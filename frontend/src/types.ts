export interface TimingMetrics {
  average_offset_ms?: number;
  timing_variance_ms?: number;
  rushed_notes_percent?: number;
  dragged_notes_percent?: number;
  timing_offsets?: number[]; // optional chart data
}

export interface DynamicsMetrics {
  average_db?: number;
  dynamic_range_db?: number;
  volume_consistency_score?: number;
  rms_over_time?: number[]; // optional chart data
}

export interface TrendsMetrics {
  timing_improving?: boolean;
  consistency_score?: number;
}

export interface Metrics {
  tempo_bpm?: number;
  timing?: TimingMetrics;
  dynamics?: DynamicsMetrics;
  trends?: TrendsMetrics;
  [key: string]: unknown;
}

export interface Drill {
  name: string;
  duration_min: number;
  tempo_bpm: number;
  instructions: string[];
  success_criteria: string[];
}

export interface CoachDrill {
  name: string;
  tempo_bpm?: number | null;
  duration_min?: number | null;
  minutes?: number | null;
  instructions?: string[] | null;
  success_criteria?: string[] | null;
}

export interface CoachResponse {
  summary: {
    primary_issue: string;
    evidence: string[];
    confidence: "low" | "medium" | "high";
  };
  drills: Drill[];
  total_minutes: number;
  disclaimer: string | null;
}

export interface ApiError {
  error_code: string;
  user_message: string;
  how_to_fix?: string[];
  debug_id?: string;
  details?: Record<string, unknown>;
}

export interface RuleRecommendation {
  category: "Improve timing and consistency" | "Clean up volume control" | "Stop rushing and dragging" | "Build overall consistency";
  urgency: "low" | "medium" | "high";
  reason: string;
  evidence: string[];
}
