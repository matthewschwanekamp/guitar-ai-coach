import React from "react";
import { CoachResponse, Metrics } from "../types";
import DrillCard from "./DrillCard";
import ErrorBanner from "./ErrorBanner";

interface Props {
  metrics: Metrics;
  plan: CoachResponse;
}

const Dashboard: React.FC<Props> = ({ metrics, plan }) => {
  const [copied, setCopied] = React.useState<string>("");
  const [error, setError] = React.useState<string>("");

  const copyReport = async () => {
    setError("");
    const lines: string[] = [];
    lines.push(`# Practice Plan`);
    lines.push(`Primary issue: ${plan.summary.primary_issue}`);
    lines.push(`Confidence: ${plan.summary.confidence}`);
    lines.push(`Evidence:`);
    plan.summary.evidence.forEach((e) => lines.push(`- ${e}`));
    lines.push(``);
    lines.push(`Metrics:`);
    lines.push(`- tempo_bpm: ${metrics.tempo_bpm ?? "n/a"}`);
    lines.push(`- timing_variance_ms: ${metrics.timing?.timing_variance_ms ?? "n/a"}`);
    lines.push(`- dynamic_range_db: ${metrics.dynamics?.dynamic_range_db ?? "n/a"}`);
    lines.push(`- volume_consistency_score: ${metrics.dynamics?.volume_consistency_score ?? "n/a"}`);
    lines.push(`- consistency_score: ${metrics.trends?.consistency_score ?? "n/a"}`);
    lines.push(``);
    lines.push(`Drills (total ${plan.total_minutes} min):`);
    plan.drills.forEach((d, i) => {
      lines.push(`${i + 1}. ${d.name} (${d.duration_min} min @ ${d.tempo_bpm} bpm)`);
      d.instructions.forEach((inst) => lines.push(`   - ${inst}`));
      lines.push(`   Success:`);
      d.success_criteria.forEach((sc) => lines.push(`     * ${sc}`));
    });
    if (plan.disclaimer) {
      lines.push(`Disclaimer: ${plan.disclaimer}`);
    }

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied("Report copied");
      setTimeout(() => setCopied(""), 2000);
    } catch (err: any) {
      setError(err?.message || "Could not copy");
    }
  };

  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 12, padding: 16, marginTop: 20 }}>
      <h2>Results</h2>
      <div style={{ marginBottom: 8 }}>
        <strong>Primary issue:</strong> {plan.summary.primary_issue}
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong>Confidence:</strong> {plan.summary.confidence}
      </div>
      <div>
        <strong>Evidence</strong>
        <ul>
          {plan.summary.evidence.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      </div>
      {plan.disclaimer && (
        <div style={{ background: "#fff8e1", padding: 10, borderRadius: 8, marginBottom: 10 }}>
          {plan.disclaimer}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
        <MetricCard label="Tempo (bpm)" value={metrics.tempo_bpm} />
        <MetricCard label="Timing variance (ms)" value={metrics.timing?.timing_variance_ms} />
        <MetricCard label="Dynamic range (dB)" value={metrics.dynamics?.dynamic_range_db} />
        <MetricCard label="Volume consistency" value={metrics.dynamics?.volume_consistency_score} />
        <MetricCard label="Consistency score" value={metrics.trends?.consistency_score} />
      </div>

      <div style={{ marginTop: 16 }}>
        <strong>Timing offsets</strong>
        <div style={{ background: "#f7f7f7", padding: 10, borderRadius: 8, minHeight: 60 }}>
          {metrics.timing?.timing_offsets && metrics.timing.timing_offsets.length > 0 ? (
            <div>{metrics.timing.timing_offsets.join(", ")}</div>
          ) : (
            "No detailed data."
          )}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <strong>RMS over time</strong>
        <div style={{ background: "#f7f7f7", padding: 10, borderRadius: 8, minHeight: 60 }}>
          {metrics.dynamics?.rms_over_time && metrics.dynamics.rms_over_time.length > 0 ? (
            <div>{metrics.dynamics.rms_over_time.join(", ")}</div>
          ) : (
            "No detailed data."
          )}
        </div>
      </div>

      <h3 style={{ marginTop: 16 }}>Drills</h3>
      {plan.drills.map((drill, idx) => (
        <DrillCard key={idx} drill={drill} />
      ))}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button onClick={copyReport} style={{ padding: "10px 14px" }}>
          Copy Report
        </button>
        {copied && <span style={{ color: "#0a7" }}>{copied}</span>}
      </div>
      {error && <ErrorBanner message={error} />}
    </div>
  );
};

const MetricCard: React.FC<{ label: string; value: number | string | undefined }> = ({ label, value }) => (
  <div style={{ flex: "1 1 160px", minWidth: 160, background: "#fafafa", borderRadius: 8, padding: 10, border: "1px solid #eee" }}>
    <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 600 }}>{value ?? "n/a"}</div>
  </div>
);

export default Dashboard;
