"use client";

import { useEffect, useRef, useState } from "react";
import html2canvas from "html2canvas";

export default function HomePage() {
  type ApplianceDraft = {
    id: string;
    name: string;
    url: string;
    pageText: string;
    hoursPerDay: number;
  };

  type View = "add" | "receipt";

  // Dark mode theme
  type Theme = {
    bg: string;
    text: string;
    textSecondary: string;
    border: string;
    cardBg: string;
    inputBg: string;
    inputBorder: string;
    buttonBg: string;
    buttonBorder: string;
    accentGlow: string;
    gradient: string;
    titleColor: string;
  };

  const lightTheme: Theme = {
    bg: "#ffffff",
    text: "#001a24",
    textSecondary: "#334",
    border: "rgba(0,229,255,0.35)",
    cardBg: "#fff",
    inputBg: "#fff",
    inputBorder: "#ddd",
    buttonBg: "rgba(0,229,255,0.07)",
    buttonBorder: "rgba(0,229,255,0.35)",
    accentGlow: "rgba(0,229,255,0.06)",
    gradient: "linear-gradient(90deg, #00E5FF, #00FF90)",
    titleColor: "#001a24",
  };

  const darkTheme: Theme = {
    bg: "#0a1929",
    text: "#e3f2fd",
    textSecondary: "#b0bec5",
    border: "rgba(0,229,255,0.5)",
    cardBg: "#132f4c",
    inputBg: "#1e3a5f",
    inputBorder: "#2e5a8a",
    buttonBg: "rgba(0,229,255,0.15)",
    buttonBorder: "rgba(0,229,255,0.5)",
    accentGlow: "rgba(0,229,255,0.12)",
    gradient: "linear-gradient(90deg, #00E5FF, #00FF90)",
    titleColor: "#e3f2fd",
  };

  type ExtractionDetails = {
    method: "gemini" | "regex" | "fallback";
    geminiWatts: number | null;
    regexWatts: number | null;
    finalWatts: number | null;
    confidence: "high" | "medium" | "low";
    evidence: string[];
    rawGeminiResponse?: string;
  };

  type BillResponse = {
    bill: {
      currency: string | null;
      tariffPerKwh: number | null;
      year: number;
      months: string[];
      items: Array<{
        name: string;
        url: string;
        hoursPerDay: number;
        monthlyKwh: number[] | null;
        yearlyKwh: number | null;
        evidence?: string[] | null;
        warning?: string | null;
        extractionDetails?: ExtractionDetails | null;
      }>;
      totals: {
        monthlyKwh: number[];
        yearlyKwh: number;
        totalCost: number | null;
      };
    };
  };

  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [view, setView] = useState<View>("add");
  const [appliances, setAppliances] = useState<ApplianceDraft[]>([]);
  const [currency, setCurrency] = useState<string>("INR");
  const [tariffPerKwh, setTariffPerKwh] = useState<string>("");

  const theme = darkMode ? darkTheme : lightTheme;

  // Initialize dark mode from localStorage
  useEffect(() => {
    const savedMode = localStorage.getItem("darkMode");
    if (savedMode !== null) {
      setDarkMode(savedMode === "true");
    }
  }, []);

  // Save dark mode preference
  const toggleDarkMode = () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    localStorage.setItem("darkMode", String(newMode));
  };

  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [bill, setBill] = useState<BillResponse["bill"] | null>(null);
  const billRef = useRef<HTMLDivElement | null>(null);

  const orderCounterRef = useRef(1);
  const [receiptMeta, setReceiptMeta] = useState<{
    date: string;
    time: string;
    order: string;
    reg: string;
  }>({ date: "", time: "", order: "01", reg: "01" });
  const receiptRequestedRef = useRef(false);

  const [showAddForm, setShowAddForm] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftPageText, setDraftPageText] = useState("");
  const [draftHoursPerDay, setDraftHoursPerDay] = useState<number>(8);

  // Verification state
  const [showVerification, setShowVerification] = useState(false);
  const [verificationData, setVerificationData] = useState<{
    name: string;
    extractedWatts: number | null;
    confidence: string;
    method: string;
    evidence: string[];
    url: string;
    hoursPerDay: number;
  } | null>(null);
  const [editableWatts, setEditableWatts] = useState<string>("");
  const [editableName, setEditableName] = useState<string>("");

  function updateAppliance(id: string, patch: Partial<ApplianceDraft>) {
    setAppliances((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function removeAppliance(id: string) {
    setAppliances((prev) => prev.filter((a) => a.id !== id));
  }

  async function addApplianceFromDraft() {
    const url = draftUrl.trim();
    const pageText = draftPageText.trim();

    if (!url && !pageText) {
      setStatus("Add link or paste spec text.");
      return;
    }

    const hoursPerDay = draftHoursPerDay;

    setStatus("Extracting power data...");
    setAdding(true);

    try {
      const res = await fetch("/api/estimate-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appliances: [
            {
              url: url ? url : undefined,
              pageText: pageText ? pageText : undefined,
              hoursPerDay,
            },
          ],
        }),
      });

      const data = (await res.json()) as { bill?: BillResponse["bill"]; error?: string };

      if (!res.ok || !data.bill || !data.bill.items?.[0]) {
        setStatus(data.error ?? `Failed (${res.status})`);
        setAdding(false);
        return;
      }

      const item = data.bill.items[0];
      const details = item.extractionDetails;

      // Show verification dialog
      setVerificationData({
        name: item.name,
        extractedWatts: details?.finalWatts ?? null,
        confidence: details?.confidence ?? "unknown",
        method: details?.method ?? "unknown",
        evidence: details?.evidence ?? item.evidence ?? [],
        url: url || "Manual entry",
        hoursPerDay,
      });
      setEditableWatts(details?.finalWatts?.toString() ?? "");
      // Use user-provided name if available, otherwise use extracted name
      setEditableName(draftName.trim() || item.name);
      setShowAddForm(false);
      setShowVerification(true);
      setStatus("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Request failed");
    } finally {
      setAdding(false);
    }
  }

  function confirmAddAppliance() {
    if (!verificationData) return;

    const watts = parseFloat(editableWatts);
    if (isNaN(watts) || watts <= 0) {
      setStatus("Please enter a valid wattage.");
      return;
    }

    const finalName = editableName.trim() || verificationData.name;
    if (!finalName) {
      setStatus("Please enter a product name.");
      return;
    }

    const id = `a${appliances.length + 1}-${Date.now()}`;
    setAppliances((prev) => [
      ...prev,
      {
        id,
        name: finalName,
        url: verificationData.url,
        pageText: draftPageText,
        hoursPerDay: verificationData.hoursPerDay,
      },
    ]);

    // Reset states
    setShowVerification(false);
    setVerificationData(null);
    setDraftName("");
    setDraftUrl("");
    setDraftPageText("");
    setDraftHoursPerDay(8);
    setStatus("Product added successfully!");
  }

  function cancelVerification() {
    setShowVerification(false);
    setVerificationData(null);
    setShowAddForm(true);
  }

  function loadDemoBill() {
    const year = new Date().getFullYear();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const daysInMonth = (m: number) => new Date(year, m + 1, 0).getDate();
    const makeMonthly = (watts: number, hoursPerDay: number) => {
      const kwhPerDay = (watts / 1000) * hoursPerDay;
      return Array.from({ length: 12 }, (_, m) => kwhPerDay * daysInMonth(m)).map((x) => Number(x.toFixed(2)));
    };

    const item1Monthly = makeMonthly(60, 12);
    const item2Monthly = makeMonthly(80, 24);
    const item1Yearly = item1Monthly.reduce((a, b) => a + b, 0);
    const item2Yearly = item2Monthly.reduce((a, b) => a + b, 0);

    const totalMonthly = item1Monthly.map((_, i) => item1Monthly[i] + item2Monthly[i]);
    const totalYearly = totalMonthly.reduce((a, b) => a + b, 0);

    const demoTariff = 10;
    setCurrency("INR");
    setTariffPerKwh(String(demoTariff));

    setBill({
      currency: "INR",
      tariffPerKwh: demoTariff,
      year,
      months,
      items: [
        {
          name: "LED Bulb (60W)",
          url: "demo",
          hoursPerDay: 12,
          monthlyKwh: item1Monthly,
          yearlyKwh: Number(item1Yearly.toFixed(2)),
          evidence: ["Demo data"],
          warning: null,
        },
        {
          name: "Table Fan (80W)",
          url: "demo",
          hoursPerDay: 24,
          monthlyKwh: item2Monthly,
          yearlyKwh: Number(item2Yearly.toFixed(2)),
          evidence: ["Demo data"],
          warning: null,
        },
      ],
      totals: {
        monthlyKwh: totalMonthly.map((x) => Number(x.toFixed(2))),
        yearlyKwh: Number(totalYearly.toFixed(2)),
        totalCost: Number((totalYearly * demoTariff).toFixed(2)),
      },
    });

    // Fill receipt meta for demo.
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const yyyy = String(now.getFullYear());
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const orderNum = String(orderCounterRef.current).padStart(2, "0");
    orderCounterRef.current += 1;
    setReceiptMeta({
      date: `${mm}/${dd}/${yyyy}`,
      time: `${hours}:${minutes}`,
      order: orderNum,
      reg: "01",
    });

    setView("receipt");
    setStatus("Loaded demo bill. You can download it as an image.");
  }

  async function estimateBill() {
    setLoading(true);
    setStatus("");
    setBill(null);

    try {
      const tariffNum =
        tariffPerKwh.trim().length > 0 ? Number(tariffPerKwh) : undefined;
      const payload = {
        currency: currency.trim().length > 0 ? currency.trim() : undefined,
        tariffPerKwh:
          typeof tariffNum === "number" && Number.isFinite(tariffNum) && tariffNum > 0
            ? tariffNum
            : undefined,
        appliances: appliances.map((a) => ({
          name: a.name.trim().length > 0 ? a.name.trim() : undefined,
          url: a.url.trim().length > 0 ? a.url.trim() : undefined,
          pageText: a.pageText.trim().length > 0 ? a.pageText.trim() : undefined,
          hoursPerDay: a.hoursPerDay,
        })),
      };

      const res = await fetch("/api/estimate-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as { bill?: BillResponse["bill"]; error?: string };

      if (!res.ok) {
        setStatus(data.error ?? `Request failed (${res.status})`);
        return;
      }

      if (!data.bill) {
        setStatus("No bill returned from server.");
        return;
      }

      setBill(data.bill);
      // Fill receipt meta for the "terminal receipt" look.
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const yyyy = String(now.getFullYear());
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const orderNum = String(orderCounterRef.current).padStart(2, "0");
      orderCounterRef.current += 1;
      setReceiptMeta({
        date: `${mm}/${dd}/${yyyy}`,
        time: `${hours}:${minutes}`,
        order: orderNum,
        reg: "01",
      });
      setStatus("Estimated successfully.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function downloadBillImage() {
    if (!billRef.current) return;
    try {
      setStatus("Rendering bill image...");
      const canvas = await html2canvas(billRef.current, {
        backgroundColor: "#ffffff",
        scale: 2,
      });
      const dataUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `unit-calc-bill-${bill?.year ?? "year"}.png`;
      link.click();
      setStatus("Bill image downloaded.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Failed to download image");
    }
  }

  useEffect(() => {
    if (view === "receipt") {
      if (appliances.length === 0) return;
      if (bill) return;
      if (loading) return;
      if (receiptRequestedRef.current) return;
      receiptRequestedRef.current = true;
      estimateBill();
      return;
    }
    receiptRequestedRef.current = false;
  }, [view, appliances.length, bill, loading]);

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        justifyContent: "center",
        background: theme.bg,
        minHeight: "100vh",
        transition: "background 0.3s ease",
      }}
    >
      <div style={{ width: "100%", maxWidth: 760, position: "relative" }}>
        {/* Dark Mode Toggle */}
        <button
          onClick={toggleDarkMode}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 44,
            height: 44,
            borderRadius: 12,
            border: `1px solid ${theme.border}`,
            background: theme.buttonBg,
            color: theme.text,
            fontSize: 20,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.3s ease",
          }}
          title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
        >
          {darkMode ? "☀️" : "🌙"}
        </button>

        <h1
          style={{
            textAlign: "center",
            fontSize: 30,
            marginTop: 6,
            marginBottom: 18,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 900,
            background: theme.gradient,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            textShadow: "0 0 12px rgba(0,229,255,0.35)",
            color: theme.titleColor,
          }}
        >
          Units Calculator
        </h1>
      {view === "add" ? (
        <>
          <p style={{ marginTop: 0, textAlign: "center", marginBottom: 16, color: theme.textSecondary }}>
            Step 1: Add products (link + 12/24 hours).
          </p>

          <section style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                  justifyContent: "center",
                }}
              >
                {appliances.map((a, idx) => (
                  <div
                    key={a.id}
                    style={{
                      position: "relative",
                      display: "inline-block",
                    }}
                  >
                    <button
                      type="button"
                      title={a.name?.trim().length ? a.name : "Adding..."}
                      disabled={adding || loading}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        border: `1px solid ${theme.border}`,
                        background: theme.accentGlow,
                        color: theme.text,
                        fontWeight: 900,
                        cursor: "default",
                        textShadow: "0 0 10px rgba(0,229,255,0.25)",
                      }}
                    >
                      {idx + 1}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAppliance(a.id)}
                      disabled={adding || loading}
                      title="Remove device"
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        border: "1px solid rgba(255,100,100,0.5)",
                        background: "rgba(255,100,100,0.15)",
                        color: "#d32f2f",
                        fontSize: 12,
                        fontWeight: 900,
                        cursor: adding || loading ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => {
                    setDraftName("");
                    setDraftHoursPerDay(8);
                    setDraftUrl("");
                    setDraftPageText("");
                    setShowAddForm(true);
                  }}
                  disabled={adding || loading}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    border: `1px solid ${theme.border}`,
                    background: theme.buttonBg,
                    color: theme.text,
                    fontWeight: 900,
                    fontSize: 18,
                    cursor: adding || loading ? "not-allowed" : "pointer",
                  }}
                >
                  +
                </button>
              </div>
            </div>

            {status ? <p style={{ textAlign: "center", marginTop: 12, color: theme.textSecondary }}>{status}</p> : null}

            <div style={{ marginTop: 18, display: "flex", justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => {
                  if (appliances.length === 0) {
                    setStatus("Add at least one product first.");
                    return;
                  }
                  setStatus("");
                  setBill(null);
                  setView("receipt");
                }}
                disabled={adding || loading}
                style={{
                  padding: "12px 16px",
                  borderRadius: 12,
                  border: `1px solid ${theme.border}`,
                  background: theme.buttonBg,
                  color: theme.text,
                  fontWeight: 800,
                  cursor: adding || loading ? "not-allowed" : "pointer",
                }}
              >
                Generate receipt
              </button>
            </div>

            {showAddForm ? (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.45)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 16,
                  zIndex: 50,
                }}
                onClick={() => setShowAddForm(false)}
              >
                <div
                  style={{
                    width: "100%",
                    maxWidth: 560,
                    background: theme.cardBg,
                    borderRadius: 16,
                    boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
                    padding: 16,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 style={{ margin: "6px 0 12px 0", textAlign: "center", color: theme.text }}>Add product</h3>

                  <label style={{ display: "block", marginTop: 10, color: theme.text }}>
                    Product name (optional)
                    <input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="e.g., LED Bulb, Table Fan"
                      style={{
                        width: "100%",
                        padding: 10,
                        marginTop: 6,
                        borderRadius: 8,
                        border: `1px solid ${theme.inputBorder}`,
                        background: theme.inputBg,
                        color: theme.text,
                        fontSize: 16,
                        boxSizing: "border-box"
                      }}
                      disabled={adding || loading}
                    />
                    <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
                      Leave empty to auto-extract from product page
                    </div>
                  </label>

                  <label style={{ display: "block", marginTop: 12, color: theme.text }}>
                    Product link
                    <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                      <input
                        value={draftUrl}
                        onChange={(e) => setDraftUrl(e.target.value)}
                        placeholder="https://..."
                        style={{
                          width: "100%",
                          padding: 10,
                          borderRadius: 8,
                          border: `1px solid ${theme.inputBorder}`,
                          background: theme.inputBg,
                          color: theme.text,
                          fontSize: 16,
                          boxSizing: "border-box"
                        }}
                        disabled={adding || loading}
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const text = await navigator.clipboard.readText();
                            if (text) setDraftUrl(text.trim());
                          } catch {
                            const text = window.prompt("Paste link");
                            if (text) setDraftUrl(text.trim());
                          }
                        }}
                        disabled={adding || loading}
                        style={{ padding: "10px 12px", whiteSpace: "nowrap" }}
                      >
                        Paste
                      </button>
                    </div>
                  </label>

                  <label style={{ display: "block", marginTop: 12, color: theme.text }}>
                    Hours used per day
                    <input
                      type="number"
                      min="0.5"
                      max="24"
                      step="0.5"
                      value={draftHoursPerDay}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (!isNaN(val) && val >= 0.5 && val <= 24) {
                          setDraftHoursPerDay(val);
                        }
                      }}
                      disabled={adding || loading}
                      style={{
                        width: "100%",
                        marginTop: 6,
                        padding: 10,
                        borderRadius: 8,
                        border: `1px solid ${theme.inputBorder}`,
                        background: theme.inputBg,
                        color: theme.text,
                        fontSize: 16,
                        boxSizing: "border-box"
                      }}
                      placeholder="e.g., 8 hours"
                    />
                    <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
                      Enter hours between 0.5 and 24
                    </div>
                  </label>

                  <label style={{ display: "block", marginTop: 12, color: theme.text }}>
                    Paste spec text (optional)
                    <textarea
                      value={draftPageText}
                      onChange={(e) => setDraftPageText(e.target.value)}
                      placeholder="If the link can't be fetched, paste power/energy here."
                      style={{
                        width: "100%",
                        marginTop: 6,
                        padding: 10,
                        minHeight: 90,
                        borderRadius: 8,
                        border: `1px solid ${theme.inputBorder}`,
                        background: theme.inputBg,
                        color: theme.text,
                        fontSize: 16,
                        boxSizing: "border-box"
                      }}
                      disabled={adding || loading}
                    />
                  </label>

                  <div style={{ display: "flex", gap: 12, justifyContent: "space-between", marginTop: 14 }}>
                    <button
                      type="button"
                      onClick={() => setShowAddForm(false)}
                      disabled={adding || loading}
                      style={{
                        padding: "12px 16px",
                        flex: 1,
                        background: theme.inputBg,
                        color: theme.text,
                        border: `1px solid ${theme.inputBorder}`,
                        borderRadius: 8,
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={addApplianceFromDraft}
                      disabled={adding || loading}
                      style={{
                        padding: "12px 16px",
                        flex: 1,
                        border: `1px solid ${theme.border}`,
                        background: theme.buttonBg,
                        color: theme.text,
                        borderRadius: 12,
                        fontWeight: 900,
                      }}
                    >
                      {adding ? "Adding..." : "Confirm"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {showVerification && verificationData ? (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.45)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 16,
                  zIndex: 50,
                }}
                onClick={() => setShowVerification(false)}
              >
                <div
                  style={{
                    width: "100%",
                    maxWidth: 600,
                    background: theme.cardBg,
                    borderRadius: 16,
                    boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
                    padding: 20,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 style={{ margin: "0 0 16px 0", textAlign: "center", color: theme.text }}>
                    Verify Extracted Data
                  </h3>

                  <label style={{ display: "block", marginBottom: 16, color: theme.text }}>
                    <strong>Product Name</strong>
                    <input
                      type="text"
                      value={editableName}
                      onChange={(e) => setEditableName(e.target.value)}
                      style={{
                        width: "100%",
                        marginTop: 6,
                        padding: 12,
                        borderRadius: 8,
                        border: `2px solid ${theme.border}`,
                        background: theme.inputBg,
                        color: theme.text,
                        fontSize: 16,
                        fontWeight: 600,
                        boxSizing: "border-box"
                      }}
                      placeholder="Enter product name"
                    />
                    <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
                      {verificationData.name
                        ? `AI extracted: ${verificationData.name}`
                        : "No name found - please enter manually"}
                    </div>
                  </label>

                  <div style={{ marginBottom: 16, padding: 12, background: theme.inputBg, borderRadius: 8, color: theme.text }}>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Usage:</strong> {verificationData.hoursPerDay} hours/day
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Extraction Method:</strong>{" "}
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          background:
                            verificationData.method === "gemini"
                              ? "rgba(0,229,255,0.15)"
                              : verificationData.method === "regex"
                                ? "rgba(255,200,0,0.15)"
                                : "rgba(255,100,100,0.15)",
                          fontWeight: 600,
                        }}
                      >
                        {verificationData.method.toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <strong>Confidence:</strong>{" "}
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          background:
                            verificationData.confidence === "high"
                              ? "rgba(0,255,100,0.15)"
                              : verificationData.confidence === "medium"
                                ? "rgba(255,200,0,0.15)"
                                : "rgba(255,100,100,0.15)",
                          fontWeight: 600,
                        }}
                      >
                        {verificationData.confidence.toUpperCase()}
                      </span>
                    </div>
                  </div>

                  <label style={{ display: "block", marginBottom: 16, color: theme.text }}>
                    <strong>Power Consumption (Watts)</strong>
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      step="1"
                      value={editableWatts}
                      onChange={(e) => setEditableWatts(e.target.value)}
                      style={{
                        width: "100%",
                        marginTop: 6,
                        padding: 12,
                        borderRadius: 8,
                        border: `2px solid ${theme.border}`,
                        background: theme.inputBg,
                        color: theme.text,
                        fontSize: 18,
                        fontWeight: 600,
                        boxSizing: "border-box"
                      }}
                      placeholder="Enter wattage"
                    />
                    <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
                      {verificationData.extractedWatts
                        ? `AI extracted: ${verificationData.extractedWatts}W`
                        : "No wattage found - please enter manually"}
                    </div>
                  </label>

                  {verificationData.evidence.length > 0 && (
                    <div style={{ marginBottom: 16, color: theme.text }}>
                      <strong>Evidence:</strong>
                      <div
                        style={{
                          marginTop: 6,
                          padding: 10,
                          background: theme.inputBg,
                          borderRadius: 6,
                          maxHeight: 120,
                          overflow: "auto",
                          fontSize: 13,
                          color: theme.textSecondary,
                        }}
                      >
                        {verificationData.evidence.map((ev, idx) => (
                          <div key={idx} style={{ marginBottom: 4 }}>
                            • {ev}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
                    <button
                      type="button"
                      onClick={cancelVerification}
                      style={{
                        padding: "12px 16px",
                        flex: 1,
                        borderRadius: 12,
                        border: `1px solid ${theme.inputBorder}`,
                        background: theme.inputBg,
                        color: theme.text,
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={confirmAddAppliance}
                      style={{
                        padding: "12px 16px",
                        flex: 1,
                        border: `1px solid ${theme.border}`,
                        background: theme.buttonBg,
                        color: theme.text,
                        borderRadius: 12,
                        fontWeight: 900,
                        cursor: "pointer",
                      }}
                    >
                      Confirm & Add
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <>
          <p style={{ marginTop: 0, textAlign: "center", marginBottom: 16, color: theme.textSecondary }}>
            Step 2: Generate receipt (Units only)
          </p>

          <section style={{ marginTop: 16, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                setStatus("");
                setBill(null);
                setView("add");
              }}
              disabled={loading}
              style={{
                padding: "12px 16px",
                borderRadius: 12,
                border: `1px solid ${theme.inputBorder}`,
                background: theme.inputBg,
                color: theme.text,
                fontWeight: 800,
              }}
            >
              Back
            </button>

            {loading ? (
              <div style={{ marginLeft: 6, color: theme.text, fontWeight: 900, alignSelf: "center" }}>
                Generating receipt...
              </div>
            ) : null}
          </section>

          {status ? <p style={{ marginTop: 10, textAlign: "center" }}>{status}</p> : null}

          {bill ? (
            <section style={{ marginTop: 18 }}>
              <div style={{ marginBottom: 10, textAlign: "center" }}>
                <button
                  type="button"
                  onClick={downloadBillImage}
                  style={{ padding: "10px 14px" }}
                >
                  Download receipt
                </button>
              </div>

              <div
                ref={billRef}
                style={{
                  border: `1px solid ${theme.border}`,
                  borderRadius: 16,
                  padding: 16,
                  background: theme.cardBg,
                }}
              >
                {(() => {
                  const monthsCount = 12;
                  const truncate = (s: string, n: number) =>
                    s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
                  const formatUnits = (v: number | null) =>
                    v == null ? "N/A" : Number.isFinite(v) ? v.toFixed(2) : "N/A";

                  const itemLines = bill.items
                    .map((it, idx) => {
                      const monthly = it.monthlyKwh ?? [];
                      const sum = monthly.reduce(
                        (a, b) => a + (Number.isFinite(b) ? b : 0),
                        0,
                      );
                      const avgMonthlyUnits =
                        monthly.length > 0 ? sum / Math.min(monthsCount, monthly.length) : null;

                      const name = truncate(it.name || `Product ${idx + 1}`, 28);
                      const left = `${idx + 1}  ${name}`;
                      const leftWidth = 42;
                      const units = formatUnits(avgMonthlyUnits);
                      const unitsRight = units.padStart(8, " ");

                      const line1 = left.padEnd(leftWidth, " ") + unitsRight;
                      const line2 = `     - Usage: ${it.hoursPerDay}h/day`;
                      
                      // Add calculation breakdown
                      const details = it.extractionDetails;
                      const watts = details?.finalWatts;
                      let line3 = "";
                      if (watts && avgMonthlyUnits) {
                        const dailyKwh = (watts * it.hoursPerDay) / 1000;
                        line3 = `     - Calc: ${watts}W × ${it.hoursPerDay}h ÷ 1000 = ${dailyKwh.toFixed(2)} kWh/day`;
                      }
                      
                      // Add extraction method info
                      let line4 = "";
                      if (details) {
                        const methodLabel = details.method === "gemini" ? "AI" : details.method === "regex" ? "Pattern" : "Manual";
                        const confLabel = details.confidence.charAt(0).toUpperCase();
                        line4 = `     - Source: ${methodLabel} (${confLabel})`;
                      }

                      return [line1, line2, line3, line4].filter(Boolean).join("\n");
                    })
                    .join("\n\n");

                  const unitsSum = bill.items.reduce((acc, it) => {
                    const monthly = it.monthlyKwh ?? [];
                    if (monthly.length === 0) return acc;
                    const sum = monthly.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
                    const avgMonthlyUnits = sum / Math.min(monthsCount, monthly.length);
                    return acc + avgMonthlyUnits;
                  }, 0);

                  const allProductsComputed = bill.items.every(
                    (it) => Array.isArray(it.monthlyKwh) && it.monthlyKwh.length > 0,
                  );
                  const totalUnitsDisplay = allProductsComputed ? formatUnits(unitsSum) : "N/A";

                  const dash = "---------------------------------------";
                  const countLine = `${String(bill.items.length).padStart(15, " ") } products`;

                  const receiptText = [
                    "Units Calculator",
                    dash,
                    `Date: ${receiptMeta.date}             Time: ${receiptMeta.time}`,
                    `Order: ${receiptMeta.order}                    Reg: ${receiptMeta.reg}`,
                    dash,
                    "",
                    itemLines,
                    "",
                    dash,
                    `SUBTOTAL (Units)                ${totalUnitsDisplay}`,
                    `TAX                                0.00`,
                    dash,
                    `TOTAL UNITS                     ${totalUnitsDisplay}`,
                    dash,
                    countLine,
                    "",
                    "      Thank you for your usage!",
                    "     Please turn off the lights!",
                  ].join("\n");

                  return (
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        fontSize: 14,
                        lineHeight: 1.35,
                        color: theme.text,
                        fontWeight: 400,
                        fontFamily:
                          'Roboto Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      }}
                    >
                      {receiptText}
                    </pre>
                  );
                })()}
              </div>
            </section>
          ) : null}
        </>
      )}
      </div>
    </main>
  );
}

