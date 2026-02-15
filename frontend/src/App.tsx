import React, { useState } from "react";
import { analyzeAudio } from "./api/client";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<any>(null);

  const onAnalyze = async () => {
    if (!file) {
      setError("Please choose an audio file first.");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await analyzeAudio(file);
      setResult(data);
      console.log("Analyze result", data);
    } catch (err: any) {
      setError(err?.message || "Analyze failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "24px 16px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1>Analyze Audio (temp UI)</h1>
      <p style={{ color: "#555" }}>Pick an audio file, then send it to the backend /analyze endpoint.</p>

      <input
        type="file"
        accept="audio/*"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        disabled={loading}
      />

      <div style={{ marginTop: 12 }}>
        <button onClick={onAnalyze} disabled={loading || !file} style={{ padding: "10px 14px" }}>
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 12, color: "#b00020", background: "#ffe8e8", padding: 10, borderRadius: 8 }}>
          {error}
        </div>
      )}

      {result && (
        <pre style={{ marginTop: 16, background: "#f6f6f6", padding: 12, borderRadius: 8, overflowX: "auto" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default App;
