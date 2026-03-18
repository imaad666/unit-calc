import { z } from "zod";
import * as cheerio from "cheerio";

type GeminiExtractResponse = {
  applianceName?: string | null;
  powerWatts?: number | null;
  kwhPerYear?: number | null;
  assumedHoursPerDay?: number | null;
  evidence?: string[];
};

const EstimateRequestSchema = z.object({
  currency: z.string().optional(),
  tariffPerKwh: z.number().positive().optional(),
  appliances: z
    .array(
      z.object({
        name: z.string().optional(),
        url: z.string().url().optional(),
        // Optional fallback when scraping is blocked; should be the raw text from the page
        // or a copy/paste summary that includes the power/energy specs.
        pageText: z.string().optional(),
        // Commonly 12 or 24, but allow any positive number.
        hoursPerDay: z.number().positive(),
      }),
    )
    .min(1),
}).refine(
  (data) => data.appliances.every((a) => typeof a.url === "string" || typeof a.pageText === "string"),
  { message: "Each appliance needs either `url` or `pageText`." },
);

const Months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function daysInMonthForYear(year: number) {
  // month index: 0-11
  return Array.from({ length: 12 }, (_, m) => new Date(year, m + 1, 0).getDate());
}

function safeNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractJson<T>(text: string): T | null {
  // Try to parse the first JSON object found in the text.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    return null;
  }
}

async function callGeminiExtract(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false as const, error: "Missing `GEMINI_API_KEY` env var" };
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return {
        ok: false as const,
        error: `Gemini returned non-JSON (${res.status})`,
        status: res.status,
      };
    }

    const candidates = (data as any)?.candidates;
    const text =
      candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";

    if (res.status === 429 && attempt < maxAttempts - 1) {
      // Simple backoff to reduce immediate retry storms.
      const waitMs = 900 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      return {
        ok: false as const,
        error: "Gemini request failed",
        status: res.status,
        rawText: String(text),
      };
    }

    return { ok: true as const, rawText: String(text), modelData: data };
  }

  return { ok: false as const, error: "Gemini request failed (exhausted retries)" };
}

function computeMonthlyFromWatts(powerWatts: number, hoursPerDay: number, year: number) {
  const days = daysInMonthForYear(year);
  const kwhPerDay = (powerWatts / 1000) * hoursPerDay;
  const monthly = days.map((d) => kwhPerDay * d);
  const yearly = monthly.reduce((a, b) => a + b, 0);
  return { monthly, yearly };
}

function computeMonthlyFromYearlyKwh(kwhPerYear: number, assumedHoursPerDay: number, hoursPerDay: number, year: number) {
  const days = daysInMonthForYear(year);
  const daysInYear = days.reduce((a, b) => a + b, 0);
  const scale = hoursPerDay / assumedHoursPerDay;
  const scaledYearly = kwhPerYear * scale;
  const monthly = days.map((d) => (scaledYearly * d) / daysInYear);
  const yearly = monthly.reduce((a, b) => a + b, 0);
  return { monthly, yearly };
}

function htmlToEvidenceText(html: string, maxChars: number) {
  const $ = cheerio.load(html);
  const title = ($("title").first().text() || "").trim();
  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
  const headings = $("h1, h2, h3")
    .slice(0, 8)
    .toArray()
    .map((el) => $(el).text().trim())
    .filter(Boolean)
    .slice(0, 8);

  // Use body text; keep it bounded.
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const combined = [
    title ? `TITLE: ${title}` : "",
    metaDesc ? `META_DESCRIPTION: ${metaDesc}` : "",
    headings.length ? `HEADINGS: ${headings.join(" | ")}` : "",
    bodyText ? `BODY_TEXT: ${bodyText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (combined.length <= maxChars) return combined;
  return combined.slice(0, maxChars);
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = EstimateRequestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { currency, tariffPerKwh, appliances } = parsed.data;
  const year = new Date().getFullYear();

  const months = [...Months];
  const items: Array<{
    name: string;
    url: string;
    hoursPerDay: number;
    monthlyKwh: number[] | null;
    yearlyKwh: number | null;
    evidence?: string[] | null;
    warning?: string | null;
  }> = [];

  const targetMaxHtmlChars = 30000;

  for (const appliance of appliances) {
    const { url: applianceUrl, hoursPerDay, name, pageText } = appliance;

    const displayUrl = applianceUrl ?? "Appliance";

    // Fetch server-side (Vercel supports outbound fetch).
    let html: string | null = null;
    try {
      if (typeof pageText === "string" && pageText.trim().length > 0) {
        html = null;
      } else if (typeof applianceUrl === "string") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(applianceUrl, {
          method: "GET",
          headers: {
            // Some hosts behave better with a UA.
            "User-Agent": "unit-calc/1.0",
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          items.push({
            name: name ?? applianceUrl,
            url: applianceUrl,
            hoursPerDay,
            monthlyKwh: null,
            yearlyKwh: null,
            warning: `Could not fetch link (HTTP ${res.status})`,
          });
          continue;
        }

        html = await res.text();
      }
    } catch {
      items.push({
        name: name ?? displayUrl,
        url: displayUrl,
        hoursPerDay,
        monthlyKwh: null,
        yearlyKwh: null,
        warning: "Could not fetch link contents (network/timeout/CORS restrictions)",
      });
      continue;
    }

    const evidenceText =
      typeof pageText === "string" && pageText.trim().length > 0
        ? `PAGE_TEXT:\n${pageText.trim()}`.slice(0, targetMaxHtmlChars)
        : html
          ? htmlToEvidenceText(html, targetMaxHtmlChars)
          : "";

    const extractPrompt = [
      "You are an assistant that extracts appliance electricity usage data from product page text.",
      "Return STRICT JSON only (no markdown, no extra keys).",
      "Schema:",
      "{ applianceName: string|null, powerWatts: number|null, kwhPerYear: number|null, assumedHoursPerDay: number|null, evidence: string[] }",
      "Rules:",
      "- If you can identify a power rating in W (like 'Power: 1200W', 'Consumption 200W'), set powerWatts and keep kwhPerYear=null and assumedHoursPerDay=null.",
      "- Otherwise, if you can find energy usage for a known schedule (like 'Annual consumption: 180 kWh' or 'Monthly consumption' etc.), then set kwhPerYear and assumedHoursPerDay.",
      "- The assumedHoursPerDay should match the schedule used by the energy figure (e.g., if it says 'used 3 hours per day', use 3).",
      "- If you are not sure, return null values and include evidence of what you looked at.",
      "",
      `Device URL (for reference only): ${displayUrl}`,
      `User usage: ${hoursPerDay} hours per day.`,
      "",
      "Page text:",
      evidenceText,
    ].join("\n");

    const gemini = await callGeminiExtract(extractPrompt);
    if (!gemini.ok) {
      items.push({
        name: name ?? displayUrl,
        url: displayUrl,
        hoursPerDay,
        monthlyKwh: null,
        yearlyKwh: null,
        evidence: null,
        warning:
          gemini.status != null
            ? `Gemini failed (HTTP ${gemini.status})`
            : `Gemini failed`,
      });
      continue;
    }

    const parsedExtract = extractJson<GeminiExtractResponse>(gemini.rawText);
    const extract = parsedExtract ?? ({} as GeminiExtractResponse);

    const powerWatts = safeNumber(extract.powerWatts);
    const kwhPerYear = safeNumber(extract.kwhPerYear);
    const assumedHoursPerDay = safeNumber(extract.assumedHoursPerDay);

    const itemName = (extract.applianceName ?? name ?? displayUrl).toString();

    if (typeof powerWatts === "number") {
      const { monthly, yearly } = computeMonthlyFromWatts(powerWatts, hoursPerDay, year);
      items.push({
        name: itemName,
        url: displayUrl,
        hoursPerDay,
        monthlyKwh: monthly.map((x) => Number(x.toFixed(2))),
        yearlyKwh: Number(yearly.toFixed(2)),
        evidence: extract.evidence ?? null,
      });
      continue;
    }

    if (typeof kwhPerYear === "number" && typeof assumedHoursPerDay === "number" && assumedHoursPerDay > 0) {
      const { monthly, yearly } = computeMonthlyFromYearlyKwh(
        kwhPerYear,
        assumedHoursPerDay,
        hoursPerDay,
        year,
      );
      items.push({
        name: itemName,
        url: displayUrl,
        hoursPerDay,
        monthlyKwh: monthly.map((x) => Number(x.toFixed(2))),
        yearlyKwh: Number(yearly.toFixed(2)),
        evidence: extract.evidence ?? null,
      });
      continue;
    }

    items.push({
      name: itemName,
      url: displayUrl,
      hoursPerDay,
      monthlyKwh: null,
      yearlyKwh: null,
      evidence: extract.evidence ?? null,
      warning: "Could not confidently extract power/energy from the page.",
    });
  }

  const monthlyTotals = Array.from({ length: 12 }, (_, idx) =>
    items.reduce((sum, it) => sum + (it.monthlyKwh?.[idx] ?? 0), 0),
  );
  const yearlyTotal = monthlyTotals.reduce((a, b) => a + b, 0);

  let totalCost: number | null = null;
  if (typeof tariffPerKwh === "number") {
    totalCost = monthlyTotals.reduce((sum, m) => sum + m * tariffPerKwh, 0);
    totalCost = Number(totalCost.toFixed(2));
  }

  return Response.json({
    bill: {
      currency: currency ?? null,
      tariffPerKwh: typeof tariffPerKwh === "number" ? tariffPerKwh : null,
      year,
      months,
      items,
      totals: {
        monthlyKwh: monthlyTotals.map((x) => Number(x.toFixed(2))),
        yearlyKwh: Number(yearlyTotal.toFixed(2)),
        totalCost,
      },
    },
  });
}

