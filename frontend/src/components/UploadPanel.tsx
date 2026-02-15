import React, { useState } from "react";
import { analyzeAudio } from "../services/api";
import { Metrics } from "../types";
import ErrorBanner from "./ErrorBanner";

interface Props {
  onComplete: (metrics: Metrics) => void;
}

type Status = "idle" | "uploading" | "done";

const MAX_MB = 10;
const ACCEPTED_TYPES = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a"];

const UploadPanel: React.FC<Props> = ({ onComplete }) => {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");

  const handleFile = async (file: File) => {
    setError("");
    setStatus("uploading");
    try {
      const metrics = await analyzeAudio(file);
      setStatus("done");
      onComplete(metrics);
    } catch (err: any) {
      setStatus("idle");
      setError(err?.message || "Failed to analyze audio");
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError("");
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError("Unsupported file type. Use WAV/MP3/M4A.");
      return;
    }
    const maxBytes = MAX_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      setError("File too large. Max 10MB.");
      return;
    }

    handleFile(file);
  };

  return (
    <div style={{ border: "1px solid #ddd", padding: 16, borderRadius: 12, marginBottom: 16 }}>
      <h3>1) Upload your audio</h3>
      <input type="file" accept="audio/*" onChange={onChange} disabled={status === "uploading"} />
      {fileName && <div style={{ marginTop: 6, fontSize: 14, color: "#555" }}>Selected: {fileName}</div>}
      {status === "uploading" && <div style={{ marginTop: 8 }}>Uploading & analyzing…</div>}
      {status === "done" && <div style={{ marginTop: 8, color: "green" }}>Analysis complete.</div>}
      {error && <ErrorBanner message={error} />}
    </div>
  );
};

export default UploadPanel;
