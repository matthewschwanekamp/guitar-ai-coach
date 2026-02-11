import React, { useEffect, useMemo, useRef, useState } from "react";

type ValidationStatus = "idle" | "validating" | "valid" | "invalid";

const MIN_SECONDS = 15;
const MAX_SECONDS = 90;
const MAX_MB = 10;

const ACCEPT_EXTENSIONS = [".wav", ".mp3", ".m4a"];
const ACCEPT_MIME_PREFIX = "audio/"; // browsers often report audio/*, but can be inconsistent for m4a

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function getAudioDurationSeconds(file: File): Promise<number> {
  // Use an <audio> element + loadedmetadata. This is the most reliable lightweight method.
  const objectUrl = URL.createObjectURL(file);

  try {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = objectUrl;

    const duration = await new Promise<number>((resolve, reject) => {
      const onLoadedMetadata = () => {
        resolve(audio.duration);
      };
      const onError = () => {
        reject(new Error("Audio metadata could not be loaded"));
      };

      audio.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      audio.addEventListener("error", onError, { once: true });
    });

    return duration;
  } finally {
    // IMPORTANT: Always revoke to avoid memory leaks.
    URL.revokeObjectURL(objectUrl);
  }
}

function isLikelyAudioFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const hasAllowedExt = ACCEPT_EXTENSIONS.some((ext) => name.endsWith(ext));
  const hasAudioMime = file.type ? file.type.startsWith(ACCEPT_MIME_PREFIX) : false;

  // Some browsers may report empty MIME for certain recordings; extension check is a useful fallback.
  return hasAllowedExt || hasAudioMime;
}

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<ValidationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);

  // Audio preview URL is separate from metadata URL. We keep this one alive while previewing.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sizeMB = useMemo(() => (file ? Number(formatMB(file.size)) : null), [file]);

  useEffect(() => {
    // Cleanup preview URL when file changes or component unmounts.
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setStatus("idle");
    setError(null);
    setFile(null);
    setDurationSeconds(null);

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const validateAndSetFile = async (selected: File) => {
    setStatus("validating");
    setError(null);
    setDurationSeconds(null);

    // 1) Type check
    if (!isLikelyAudioFile(selected)) {
      setStatus("invalid");
      setError("Invalid file type. Please upload a WAV, MP3, or M4A audio file.");
      return;
    }

    // 2) Size check
    const maxBytes = MAX_MB * 1024 * 1024;
    if (selected.size > maxBytes) {
      setStatus("invalid");
      setError(`File too large. Max size is ${MAX_MB}MB. Your file is ${formatMB(selected.size)}MB.`);
      return;
    }

    // 3) Duration check
    let dur: number;
    try {
      dur = await getAudioDurationSeconds(selected);
    } catch {
      setStatus("invalid");
      setError("Could not read audio duration. Try converting your clip to WAV and re-uploading.");
      return;
    }

    if (!Number.isFinite(dur) || dur <= 0) {
      setStatus("invalid");
      setError("Could not read audio duration. Try converting your clip to WAV and re-uploading.");
      return;
    }

    // Some formats report duration as a float with tiny precision issues. Normalize lightly.
    const normalized = Math.round(dur * 10) / 10;

    if (normalized < MIN_SECONDS) {
      setStatus("invalid");
      setError(`File too short. Minimum is ${MIN_SECONDS}s. Your clip is ${normalized}s.`);
      return;
    }

    if (normalized > MAX_SECONDS) {
      setStatus("invalid");
      setError(`File too long. Maximum is ${MAX_SECONDS}s. Your clip is ${normalized}s.`);
      return;
    }

    // Valid: set state + preview URL
    setFile(selected);
    setDurationSeconds(normalized);

    // Create preview URL (separate from metadata URL; keep alive for the player)
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(selected));

    setStatus("valid");
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    if (!selected) return;

    // If user selects a new file after a previous selection, clear old state.
    setFile(null);
    setDurationSeconds(null);
    setError(null);

    await validateAndSetFile(selected);
  };

  const canProceed = status === "valid" && file && previewUrl && durationSeconds !== null;

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Guitar AI Coach</h1>
      <p style={{ marginTop: 0, color: "#444" }}>
        Upload a <strong>15–90 second</strong> guitar clip (WAV/MP3/M4A). We’ll validate it locally and let you preview it.
      </p>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, marginTop: 16 }}>
        <label style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>Upload audio</label>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_EXTENSIONS.join(",")}
          onChange={onFileChange}
        />

        <div style={{ marginTop: 12, color: "#555", fontSize: 14 }}>
          <div>Allowed: {ACCEPT_EXTENSIONS.join(", ")} · Max size: {MAX_MB}MB · Duration: {MIN_SECONDS}–{MAX_SECONDS}s</div>
        </div>

        {status === "validating" && (
          <div style={{ marginTop: 12 }}>Validating…</div>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#fff3f3", border: "1px solid #ffd0d0", color: "#8a1f1f" }}>
            <strong>Validation error:</strong> {error}
          </div>
        )}

        {file && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#f7f7f7", border: "1px solid #e5e5e5" }}>
            <div><strong>File:</strong> {file.name}</div>
            <div><strong>Type:</strong> {file.type || "(unknown)"}</div>
            <div><strong>Size:</strong> {formatMB(file.size)} MB</div>
            <div><strong>Duration:</strong> {durationSeconds !== null ? `${durationSeconds}s` : "—"}</div>
          </div>
        )}

        {previewUrl && status === "valid" && (
          <div style={{ marginTop: 16 }}>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>Preview</label>
            <audio controls src={previewUrl} style={{ width: "100%" }} />
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={reset}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", background: "white", cursor: "pointer" }}
          >
            Reset
          </button>

          <button
            type="button"
            disabled={!canProceed}
            onClick={() => console.log("Ready to send to backend:", { file, durationSeconds })}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #222",
              background: canProceed ? "#222" : "#aaa",
              color: "white",
              cursor: canProceed ? "pointer" : "not-allowed",
            }}
          >
            Analyze my playing (next step)
          </button>
        </div>
      </section>

      <section style={{ marginTop: 18, color: "#555", fontSize: 14 }}>
        <p style={{ marginBottom: 6 }}><strong>Recording tips:</strong></p>
        <ul style={{ marginTop: 0 }}>
          <li>Record close enough to avoid room echo, but not so close that it clips.</li>
          <li>Keep a steady tempo for best timing analysis later.</li>
          <li>If duration detection fails, convert the clip to WAV and retry.</li>
        </ul>
      </section>
    </main>
  );
}
