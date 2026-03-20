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

function extractPowerWattsFromText(text: string): number | null {
  // Best-effort deterministic extraction. Many Amazon pages include wattage in title/specs.
  // We only accept values in a reasonable range to reduce false positives.
  const t = text.replace(/\s+/g, " ");
  const candidates: Array<{ value: number; score: number }> = [];

  const powerPattern = /(\d+(?:\.\d+)?)\s*(W|watt(?:age)?|watts(?:age)?|kW)\b/gi;
  const keywordPattern = /(power|power consumption|watts|wattage|rated|consumption)/i;

  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = powerPattern.exec(t))) {
    const raw = match[1];
    const unitToken = String(match[2]).toLowerCase();
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;

    if (unitToken === "kw") {
      value = value * 1000;
    }

    // Filter out extreme outliers.
    if (value <= 1 || value > 20000) continue;

    // Score based on nearby keyword presence.
    const idx = match.index;
    const windowStart = Math.max(0, idx - 80);
    const windowEnd = Math.min(t.length, idx + match[0].length + 80);
    const window = t.slice(windowStart, windowEnd);
    const score = keywordPattern.test(window) ? 2 : 1;
    candidates.push({ value, score });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || b.value - a.value);
  // Prefer the highest score; if same score, prefer larger (often wattage is larger than other "W" tokens).
  return Number(candidates[0].value.toFixed(2));
}

function extractAnnualKwhFromText(text: string): number | null {
  // Best-effort deterministic extraction for devices that only show annual energy consumption.
  // We assume the annual figure corresponds to 24h/day operation for scaling.
  const t = text.replace(/\s+/g, " ").toLowerCase();

  // Only accept kWh values if we see annual/yearly cues nearby.
  const kwhPattern = /(\d+(?:\.\d+)?)\s*(kwh)\b/gi;
  const annualCue = /(annual|yearly|per year|kwh\/year|kwh\s*\/\s*annum|per annum|in a year)/i;

  const candidates: Array<{ value: number; score: number }> = [];
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = kwhPattern.exec(t))) {
    const raw = match[1];
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value <= 1 || value > 200000) continue;

    const idx = match.index ?? 0;
    const windowStart = Math.max(0, idx - 90);
    const windowEnd = Math.min(t.length, idx + match[0].length + 90);
    const window = t.slice(windowStart, windowEnd);
    const score = annualCue.test(window) ? 2 : 1;
    candidates.push({ value, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.value - a.value);
  return Number(candidates[0].value.toFixed(2));
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

    // Deterministic watt extraction fallback (works even if Gemini extraction misses the power field).
    const deterministicWatts = extractPowerWattsFromText(evidenceText);
    const deterministicAnnualKwh = extractAnnualKwhFromText(evidenceText);

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
      if (typeof deterministicWatts === "number") {
        const { monthly, yearly } = computeMonthlyFromWatts(deterministicWatts, hoursPerDay, year);
        items.push({
          name: name ?? displayUrl,
          url: displayUrl,
          hoursPerDay,
          monthlyKwh: monthly.map((x) => Number(x.toFixed(2))),
          yearlyKwh: Number(yearly.toFixed(2)),
          evidence: null,
          warning:
            gemini.status != null
              ? `Gemini failed (HTTP ${gemini.status}); units computed from watts found on the page.`
              : `Gemini failed; units computed from watts found on the page.`,
        });
      } else if (typeof deterministicAnnualKwh === "number") {
        // Assume annual consumption is for 24h/day.
        const assumedHoursPerDay = 24;
        const { monthly, yearly } = computeMonthlyFromYearlyKwh(
          deterministicAnnualKwh,
          assumedHoursPerDay,
          hoursPerDay,
          year,
        );
        items.push({
          name: name ?? displayUrl,
          url: displayUrl,
          hoursPerDay,
          monthlyKwh: monthly.map((x) => Number(x.toFixed(2))),
          yearlyKwh: Number(yearly.toFixed(2)),
          evidence: null,
          warning:
            gemini.status != null
              ? `Gemini failed (HTTP ${gemini.status}); units computed from annual kWh found on the page (assumed 24h/day).`
              : `Gemini failed; units computed from annual kWh found on the page (assumed 24h/day).`,
        });
      } else {
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
      }
      continue;
    }

    const parsedExtract = extractJson<GeminiExtractResponse>(gemini.rawText);
    const extract = parsedExtract ?? ({} as GeminiExtractResponse);

    const powerWattsFromGemini = safeNumber(extract.powerWatts);
    const powerWatts = typeof powerWattsFromGemini === "number" ? powerWattsFromGemini : deterministicWatts;
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

    const effectiveKwhPerYear =
      typeof kwhPerYear === "number" ? kwhPerYear : deterministicAnnualKwh;

    const effectiveAssumedHoursPerDay =
      typeof assumedHoursPerDay === "number" && assumedHoursPerDay > 0 ? assumedHoursPerDay : 24;

    if (typeof effectiveKwhPerYear === "number" && typeof effectiveAssumedHoursPerDay === "number" && effectiveAssumedHoursPerDay > 0) {
      const { monthly, yearly } = computeMonthlyFromYearlyKwh(
        effectiveKwhPerYear,
        effectiveAssumedHoursPerDay,
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

