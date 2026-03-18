type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  modelVersion?: string;
  responseId?: string;
  usageMetadata?: Record<string, unknown>;
  promptFeedback?: unknown;
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { prompt } = (body ?? {}) as { prompt?: unknown };

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return Response.json({ error: "Missing `prompt` (string)" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Missing `GEMINI_API_KEY` env var" },
      { status: 500 },
    );
  }

  const model =
    process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

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

  let data: GeminiGenerateContentResponse;
  try {
    data = (await res.json()) as GeminiGenerateContentResponse;
  } catch {
    return Response.json(
      { error: `Gemini returned non-JSON (${res.status})` },
      { status: 502 },
    );
  }

  if (!res.ok) {
    return Response.json(
      {
        error: "Gemini request failed",
        status: res.status,
      },
      { status: 502 },
    );
  }

  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();

  return Response.json({
    text,
    finishReason: candidate?.finishReason ?? null,
    modelVersion: data.modelVersion ?? null,
    responseId: data.responseId ?? null,
  });
}

