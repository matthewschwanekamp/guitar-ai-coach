import React, { useCallback, useEffect, useRef, useState } from "react";
import Waveform from "../components/Waveform";
import { analyzeAudio, coachFromMetrics } from "../services/api";
import { CoachResponse, Metrics } from "../types";
import SummaryCard from "../components/SummaryCard";
import PracticePlan from "../components/PracticePlan";
import { copyToClipboard } from "../utils/copyToClipboard";
import { formatCoachReport } from "../utils/formatReport";

type ValidationStatus = "idle" | "validating" | "valid" | "invalid";
type InputMode = "upload" | "record";
type RecordingState = "idle" | "recording" | "processing";

const MIN_SECONDS = 15;
const MAX_SECONDS = 90;
const MAX_MB = 10;

const ACCEPT_EXTENSIONS = [".wav", ".mp3", ".m4a"];
const ACCEPT_MIME_PREFIX = "audio/"; // browsers often report audio/*, but can be inconsistent for m4a

function pickPreferredMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;

  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

function mimeTypeToExtension(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "audio";
}

function formatSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

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

  const [mode, setMode] = useState<InputMode>("upload");
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const recordingStartMsRef = useRef<number>(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const autoStopTimeoutRef = useRef<number | null>(null);
  const stopSafetyTimeoutRef = useRef<number | null>(null);
  const stopHandledRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const [level, setLevel] = useState<number>(0);
  const [clippingRisk, setClippingRisk] = useState<boolean>(false);
  const [recordingMimeType, setRecordingMimeType] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<Metrics | null>(null);
  const [plan, setPlan] = useState<CoachResponse | null>(null);
  const [isCoaching, setIsCoaching] = useState(false);
  const [coachError, setCoachError] = useState<string | null>(null);
  const [skillLevel, setSkillLevel] = useState<string>("beginner");
  const [goal, setGoal] = useState<string>("Improve timing consistency and clean dynamics.");
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [metricsOpen, setMetricsOpen] = useState(false);

  // Audio preview URL is separate from metadata URL. We keep this one alive while previewing.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const clearAutoStopTimeout = useCallback(() => {
    if (autoStopTimeoutRef.current !== null) {
      window.clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  }, []);

  const clearStopSafetyTimeout = useCallback(() => {
    if (stopSafetyTimeoutRef.current !== null) {
      window.clearTimeout(stopSafetyTimeoutRef.current);
      stopSafetyTimeoutRef.current = null;
    }
  }, []);

  const stopLevelMonitoring = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }

    setLevel(0);
    setClippingRisk(false);
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Cleanup preview URL and any recording resources when the component unmounts or the preview changes.
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      stopTimer();
      clearAutoStopTimeout();
      clearStopSafetyTimeout();
      stopLevelMonitoring();
      stopStream();
      chunksRef.current = [];
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onerror = null;
        mediaRecorderRef.current.onstop = null;
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, [previewUrl, stopStream, stopTimer, clearAutoStopTimeout, clearStopSafetyTimeout, stopLevelMonitoring]);

  const resetRecording = () => {
    stopTimer();
    clearAutoStopTimeout();
    clearStopSafetyTimeout();
    stopLevelMonitoring();
    stopStream();
    chunksRef.current = [];
    setElapsedSeconds(0);
    recordingStartMsRef.current = 0;
    stopHandledRef.current = false;
    setRecordingState("idle");
    setRecordingMimeType(null);

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onerror = null;
      mediaRecorderRef.current.onstop = null;

      if (mediaRecorderRef.current.state !== "inactive") {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
    }

    mediaRecorderRef.current = null;
  };

  const reset = () => {
    resetRecording();
    setStatus("idle");
    setError(null);
    setFile(null);
    setDurationSeconds(null);
    setAnalyzeError(null);
    setAnalyzeResult(null);
    setIsAnalyzing(false);
    setPlan(null);
    setCoachError(null);
    setIsCoaching(false);
    setCopyStatus("idle");
    setCopyError(null);

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
    if (recordingState === "recording") return;

    const selected = e.target.files?.[0] ?? null;
    if (!selected) return;

    // If user selects a new file after a previous selection, clear old state.
    setFile(null);
    setDurationSeconds(null);
    setError(null);

    await validateAndSetFile(selected);
  };

  const handleModeChange = (nextMode: InputMode) => {
    if (recordingState !== "idle") return;
    // Clear any current audio/preview when switching modes to avoid stale state.
    reset();
    setMode(nextMode);
  };

  const startRecording = async () => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      setError("Recording is only available in the browser.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone access is not supported in this browser.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setError("Recording is not supported in this browser (MediaRecorder missing).");
      return;
    }

    if (recordingState === "recording") return;

    // Clear previous audio state when starting a new recording.
    reset();
    setError(null);
    setStatus("idle");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const preferredMime = pickPreferredMimeType();
      const recorder = new MediaRecorder(stream, preferredMime ? { mimeType: preferredMime } : undefined);
      mediaRecorderRef.current = recorder;
      setRecordingMimeType(preferredMime ?? recorder.mimeType);

      chunksRef.current = [];
      stopHandledRef.current = false;
      recordingStartMsRef.current = Number(new Date());
      setElapsedSeconds(0);
      setRecordingState("recording");
      setLevel(0);
      setClippingRisk(false);

      // Set up live level monitoring
      try {
        const audioCtx = new AudioContext();
        const sourceNode = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        sourceNode.connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i += 1) {
            // data is centered at 128; convert to -1..1
            const sample = Math.abs(data[i] - 128) / 128;
            if (sample > peak) peak = sample;
          }
          setLevel(peak);
          setClippingRisk(peak > 0.92);
          rafIdRef.current = requestAnimationFrame(tick);
        };

        rafIdRef.current = requestAnimationFrame(tick);

        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
      } catch {
        // Monitoring is non-critical; ignore failures.
      }

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setError("Recording failed. Please try again.");
        setStatus("invalid");
        resetRecording();
      };

      recorder.onstop = async () => {
        if (stopHandledRef.current) return;
        stopHandledRef.current = true;

        stopTimer();
        clearAutoStopTimeout();
        clearStopSafetyTimeout();
        stopLevelMonitoring();
        stopStream();

        if (chunksRef.current.length === 0) {
          setStatus("invalid");
          setError("Recording failed. No audio data was captured.");
          setRecordingState("idle");
          mediaRecorderRef.current = null;
          return;
        }

        const measuredElapsed = Math.min(
          MAX_SECONDS,
          Math.floor((Date.now() - recordingStartMsRef.current) / 1000)
        );
        setElapsedSeconds(measuredElapsed);

        const mime = mediaRecorderRef.current?.mimeType || recordingMimeType || "audio/webm";
        const extension = mimeTypeToExtension(mime);
        const blob = new Blob(chunksRef.current, { type: mime });
        const recordedFile = new File([blob], `recording.${extension}`, { type: mime });
        chunksRef.current = [];
        mediaRecorderRef.current = null;

        // Surface friendly message if user stopped early.
        if (measuredElapsed < MIN_SECONDS) {
          await validateAndSetFile(recordedFile); // still run through validation pipeline
          setStatus("invalid");
          setFile(null);
          setDurationSeconds(null);
          setPreviewUrl((current) => {
            if (current) URL.revokeObjectURL(current);
            return null;
          });
          setError("Recording too short. Please record at least 15 seconds.");
          setRecordingState("idle");
          return;
        }

        await validateAndSetFile(recordedFile);
        setRecordingState("idle");
      };

      recorder.start();

      clearAutoStopTimeout();
      autoStopTimeoutRef.current = window.setTimeout(() => {
        stopRecording("auto");
      }, MAX_SECONDS * 1000);

      timerIntervalRef.current = window.setInterval(() => {
        if (!recordingStartMsRef.current) return;
        const elapsed = Math.min(
          MAX_SECONDS,
          Math.floor((Date.now() - recordingStartMsRef.current) / 1000)
        );
        setElapsedSeconds(elapsed);
      }, 250);
    } catch {
      setError("Microphone permission denied or unavailable.");
      resetRecording();
    }
  };

  const stopRecording = (reason: "manual" | "auto" = "manual") => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
      return;
    }

    stopTimer();
    clearAutoStopTimeout();
    clearStopSafetyTimeout();
    stopLevelMonitoring();

    if (reason === "auto") {
      setElapsedSeconds(MAX_SECONDS);
      stopStream();
    }

    try {
      mediaRecorderRef.current.stop();
      setRecordingState("processing");

      stopSafetyTimeoutRef.current = window.setTimeout(() => {
        if (!stopHandledRef.current) {
          stopTimer();
          clearAutoStopTimeout();
          stopStream();
          setRecordingState("idle");
          setError("Auto-stop failed—please press Stop");
        }
      }, 1500);
    } catch {
      setError("Could not stop recording. Please try again.");
      resetRecording();
    }
  };

  const handleReset = () => {
    resetRecording();
    reset();
  };

  const canProceed = status === "valid" && file && previewUrl && durationSeconds !== null;
  const isRecording = recordingState === "recording";

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Guitar AI Coach</h1>
      <p style={{ marginTop: 0, color: "#444" }}>
        Upload or record a <strong>15–90 second</strong> guitar clip (WAV/MP3/M4A). We’ll validate it locally and let you preview it.
      </p>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, marginTop: 16 }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => handleModeChange("upload")}
            disabled={isRecording}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: mode === "upload" ? "2px solid #222" : "1px solid #ccc",
              background: mode === "upload" ? "#f2f2f2" : "white",
              cursor: isRecording ? "not-allowed" : "pointer",
              fontWeight: mode === "upload" ? 700 : 500,
            }}
          >
            Upload
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("record")}
            disabled={isRecording}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: mode === "record" ? "2px solid #222" : "1px solid #ccc",
              background: mode === "record" ? "#f2f2f2" : "white",
              cursor: isRecording ? "not-allowed" : "pointer",
              fontWeight: mode === "record" ? 700 : 500,
            }}
          >
            Record
          </button>
        </div>

        {mode === "upload" && (
          <>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>Upload audio</label>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_EXTENSIONS.join(",")}
              onChange={onFileChange}
              disabled={isRecording}
            />

            <div style={{ marginTop: 12, color: "#555", fontSize: 14 }}>
              <div>Allowed: {ACCEPT_EXTENSIONS.join(", ")} · Max size: {MAX_MB}MB · Duration: {MIN_SECONDS}–{MAX_SECONDS}s</div>
            </div>
          </>
        )}

        {mode === "record" && (
          <>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>Record in browser</label>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={startRecording}
                disabled={isRecording}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #222",
                  background: isRecording ? "#ddd" : "#222",
                  color: "white",
                  cursor: isRecording ? "not-allowed" : "pointer",
                }}
              >
                Start Recording
              </button>
              <button
                type="button"
                onClick={() => stopRecording("manual")}
                disabled={!isRecording}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
              border: "1px solid #b53f3f",
              background: !isRecording ? "#eee" : "#b53f3f",
              color: !isRecording ? "#888" : "white",
              cursor: !isRecording ? "not-allowed" : "pointer",
            }}
          >
                Stop
              </button>
              <button
                type="button"
                onClick={handleReset}
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", background: "white", cursor: "pointer" }}
              >
                Reset
              </button>
              <div style={{ minWidth: 120, fontWeight: 600 }}>
                Timer: {formatSeconds(elapsedSeconds)}
              </div>
              {isRecording && (
                <div style={{ color: "#b53f3f", fontSize: 13 }}>
                  Recording… auto-stops at {MAX_SECONDS}s
                </div>
              )}
            </div>
            {isRecording && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Input level</div>
                <div
                  style={{
                    position: "relative",
                    height: 10,
                    background: "#f0f0f0",
                    borderRadius: 6,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, Math.round(level * 100))}%`,
                      background: clippingRisk ? "#c0392b" : "#2c7be5",
                      transition: "width 80ms linear",
                    }}
                  />
                </div>
                {clippingRisk && (
                  <div style={{ marginTop: 6, color: "#c0392b", fontSize: 13 }}>
                    Clipping risk — move farther from mic / lower input volume.
                  </div>
                )}
              </div>
            )}
            <div style={{ marginTop: 8, color: "#555", fontSize: 14 }}>
              Tip: click Start to grant microphone permission, then Stop to review your take.
            </div>
          </>
        )}

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
            <Waveform audioUrl={previewUrl} />
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
            onClick={async () => {
              if (!file) return;
              setAnalyzeError(null);
              setAnalyzeResult(null);
              setIsAnalyzing(true);
              try {
                const res = await analyzeAudio(file);
                setAnalyzeResult(res);
                setPlan(null);
                setCoachError(null);
                console.log("Analyze response:", res);
              } catch (err: any) {
                const message = err?.message || "Analyze failed";
                setAnalyzeError(message);
                console.error("Analyze error:", err);
              } finally {
                setIsAnalyzing(false);
              }
            }}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #222",
              background: canProceed && !isAnalyzing ? "#222" : "#aaa",
              color: "white",
              cursor: canProceed && !isAnalyzing ? "pointer" : "not-allowed",
            }}
          >
            {isAnalyzing ? "Analyzing…" : "Analyze my playing (next step)"}
          </button>
        </div>

        {analyzeError && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#fff3f3", border: "1px solid #ffd0d0", color: "#8a1f1f" }}>
            <strong>Analyze error:</strong> {analyzeError}
          </div>
        )}

        {analyzeResult && (
          <div style={{ marginTop: 12, border: "1px solid #e5e5e5", borderRadius: 10, padding: 12, background: "white" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>Backend metrics JSON</div>
              <button
                type="button"
                onClick={() => setMetricsOpen((v) => !v)}
                aria-expanded={metricsOpen}
                aria-controls="metrics-json-panel"
                disabled={!analyzeResult}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #777",
                  background: "white",
                  color: "#222",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {metricsOpen ? "Hide JSON" : "Show JSON"}
              </button>
            </div>
            {metricsOpen && (
              <div id="metrics-json-panel" style={{ marginTop: 8 }}>
                <pre style={{ background: "#f6f6f6", padding: 12, borderRadius: 10, maxHeight: 320, overflow: "auto", border: "1px solid #e5e5e5", margin: 0 }}>
{JSON.stringify(analyzeResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, padding: 12, borderRadius: 10, border: "1px solid #e5e5e5", background: "#f8f8f8" }}>
          <h3 style={{ marginTop: 0 }}>Generate Plan</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label>
              Skill level:{" "}
              <select value={skillLevel} onChange={(e) => setSkillLevel(e.target.value)}>
                <option value="beginner">beginner</option>
                <option value="intermediate">intermediate</option>
                <option value="advanced">advanced</option>
              </select>
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
              <label style={{ flex: "1 1 360px", minWidth: 240 }}>
                Goal:{" "}
                <input
                  type="text"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  style={{ width: "100%", padding: 8 }}
                  placeholder="What do you want to improve?"
                />
              </label>
              <button
                type="button"
                disabled={!analyzeResult || isCoaching || isAnalyzing}
                onClick={async () => {
                  if (!analyzeResult) return;
                  setIsCoaching(true);
                  setCoachError(null);
                  setPlan(null);
                  try {
                    const resp = await coachFromMetrics({
                      metrics: analyzeResult,
                      skill_level: skillLevel,
                      goal,
                    });
                    setPlan(resp);
                    console.log("Coach response:", resp);
                  } catch (err: any) {
                    const message = err?.message || "Coach failed";
                    setCoachError(message);
                    console.error(err);
                  } finally {
                    setIsCoaching(false);
                  }
                }}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #222",
                  background: analyzeResult && !isCoaching && !isAnalyzing ? "#222" : "#aaa",
                  color: "white",
                  cursor: analyzeResult && !isCoaching && !isAnalyzing ? "pointer" : "not-allowed",
                  flex: "0 0 auto",
                }}
              >
                {isCoaching ? "Generating…" : "Generate Plan"}
              </button>
            </div>
          </div>
          {isCoaching && <div style={{ marginTop: 8 }}>Calling /coach…</div>}
          {coachError && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "#fff3f3", border: "1px solid #ffd0d0", color: "#8a1f1f" }}>
              <strong>Coach error:</strong> {coachError}
            </div>
          )}
          {plan && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>Results</div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!plan) return;
                    try {
                      setCopyError(null);
                      setCopyStatus("idle");
                      const text = formatCoachReport(plan);
                      await copyToClipboard(text);
                      setCopyStatus("success");
                      setTimeout(() => setCopyStatus("idle"), 1500);
                    } catch (err: any) {
                      setCopyStatus("error");
                      setCopyError(err?.message || "Copy failed");
                    }
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #777",
                    background: "white",
                    color: "#222",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                  disabled={!plan}
                >
                  {copyStatus === "success" ? "Copied!" : "Copy report"}
                </button>
              </div>
              {copyStatus === "error" && copyError && (
                <div style={{ fontSize: 12, color: "#b00020" }}>{copyError}</div>
              )}
              <SummaryCard summary={plan.summary} />
              <PracticePlan drills={plan.drills} totalMinutes={plan.total_minutes} />
            </div>
          )}
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
