import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

interface WaveformProps {
  audioUrl: string | null;
  height?: number;
}

function formatTime(secs: number): string {
  const minutes = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(secs % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function Waveform({ audioUrl, height = 80 }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const destroyWaveSurfer = () => {
      if (waveSurferRef.current) {
        waveSurferRef.current.destroy();
        waveSurferRef.current = null;
      }
      setIsReady(false);
      setIsPlaying(false);
      setDuration(0);
      setCurrentTime(0);
    };

    if (!audioUrl || !containerRef.current) {
      destroyWaveSurfer();
      return undefined;
    }

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height,
      waveColor: "#7aa0ff",
      progressColor: "#1b5cd6",
      cursorColor: "#1b5cd6",
      responsive: true,
      normalize: true,
      backend: "MediaElement",
    });

    waveSurferRef.current = ws;
    ws.load(audioUrl);

    const handleReady = () => {
      setIsReady(true);
      setDuration(ws.getDuration());
      setCurrentTime(0);
      setIsPlaying(false);
    };

    const handleTimeUpdate = (time: number) => {
      setCurrentTime(time);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleFinish = () => {
      setIsPlaying(false);
      setCurrentTime(ws.getDuration());
    };

    ws.on("ready", handleReady);
    ws.on("timeupdate", handleTimeUpdate);
    ws.on("play", handlePlay);
    ws.on("pause", handlePause);
    ws.on("finish", handleFinish);

    return () => {
      ws.un("ready", handleReady);
      ws.un("timeupdate", handleTimeUpdate);
      ws.un("play", handlePlay);
      ws.un("pause", handlePause);
      ws.un("finish", handleFinish);
      destroyWaveSurfer();
    };
  }, [audioUrl, height]);

  const togglePlay = () => {
    if (!waveSurferRef.current || !isReady) return;
    waveSurferRef.current.playPause();
  };

  if (!audioUrl) return null;

  return (
    <div>
      <div ref={containerRef} style={{ width: "100%", height }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, fontSize: 14 }}>
        <button
          type="button"
          onClick={togglePlay}
          disabled={!isReady}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #ccc",
            background: isReady ? "#f7f7f7" : "#eee",
            cursor: isReady ? "pointer" : "not-allowed",
          }}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <div style={{ color: "#333" }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
      </div>
    </div>
  );
}
