import { CoachResponse, Metrics } from "../types";

const BASE_URL = (
  (import.meta as any).env?.VITE_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/$/, "");

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = await res.text();
    try {
      const json = JSON.parse(detail);
      detail = json.detail || detail;
    } catch {
      // keep text
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export async function analyzeAudio(file: File): Promise<Metrics> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${BASE_URL}/analyze`, {
    method: "POST",
    body: form,
  });

  return handleResponse<Metrics>(res);
}

export async function generatePlan(payload: { metrics: Metrics; skill_level: string; goal: string }): Promise<CoachResponse> {
  const res = await fetch(`${BASE_URL}/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<CoachResponse>(res);
}

export async function coachFromMetrics(params: { metrics: any; skill_level: string; goal: string }): Promise<any> {
  const res = await fetch(`${BASE_URL}/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coach failed (${res.status}): ${text}`);
  }

  return res.json();
}
