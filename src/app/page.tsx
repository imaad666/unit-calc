"use client";

import { useState } from "react";

export default function HomePage() {
  const [prompt, setPrompt] = useState("Explain how AI works in a few words");
  const [result, setResult] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    setStatus("");
    setResult("");

    try {
      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const data = (await res.json()) as { text?: string; error?: string };

      if (!res.ok) {
        setStatus(data.error ?? `Request failed (${res.status})`);
        return;
      }

      setResult(data.text ?? "");
      setStatus("Success");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Unit Calc</h1>
      <p>Step 1: test Gemini API integration.</p>

      <label style={{ display: "block", marginTop: 12 }}>
        Prompt
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{ width: "100%", marginTop: 6, padding: 8 }}
        />
      </label>

      <button
        onClick={run}
        disabled={loading}
        style={{ marginTop: 12, padding: "10px 14px" }}
      >
        {loading ? "Running..." : "Run"}
      </button>

      {status ? <p style={{ marginTop: 12 }}>{status}</p> : null}
      {result ? (
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            background: "#f6f6f6",
            borderRadius: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {result}
        </pre>
      ) : null}
    </main>
  );
}

