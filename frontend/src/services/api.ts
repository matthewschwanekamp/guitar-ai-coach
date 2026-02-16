import { ApiError, CoachResponse, Metrics, RuleRecommendation } from "../types";

const BASE_URL = (
  (import.meta as any).env?.VITE_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/$/, "");

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    return res.json() as Promise<T>;
  }

  const rawText = await res.text();
  let parsed: any = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    // non-JSON body
  }

  const payload: ApiError | undefined =
    parsed?.error_code
      ? parsed
      : parsed?.detail?.error_code
      ? parsed.detail
      : undefined;

  if (payload) {
    const err = new Error(payload.user_message || "Request failed");
    (err as any).apiError = payload;
    (err as any).status = res.status;
    throw err;
  }

  if (parsed?.detail) {
    throw new Error(`HTTP ${res.status}: ${parsed.detail}`);
  }

  throw new Error(`HTTP ${res.status}: ${rawText || "Request failed"}`);
}

export interface AnalyzeResponse {
  metrics: Metrics;
  rule_recommendations: RuleRecommendation[];
}

export async function analyzeAudio(file: File): Promise<AnalyzeResponse> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${BASE_URL}/analyze`, {
    method: "POST",
    body: form,
  });

  return handleResponse<AnalyzeResponse>(res);
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

  return handleResponse<any>(res);
}
