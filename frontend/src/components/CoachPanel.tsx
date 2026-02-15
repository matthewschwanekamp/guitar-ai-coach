import React, { useState } from "react";
import { CoachResponse, Metrics } from "../types";
import { generatePlan } from "../services/api";
import ErrorBanner from "./ErrorBanner";

interface Props {
  metrics: Metrics;
  onComplete: (plan: CoachResponse) => void;
}

const CoachPanel: React.FC<Props> = ({ metrics, onComplete }) => {
  const [skillLevel, setSkillLevel] = useState<string>("beginner");
  const [goal, setGoal] = useState<string>("Improve timing");
  const [status, setStatus] = useState<"idle" | "generating" | "done">("idle");
  const [error, setError] = useState<string>("");

  const handleGenerate = async () => {
    setError("");
    setStatus("generating");
    try {
      const plan = await generatePlan({ metrics, skill_level: skillLevel, goal });
      onComplete(plan);
      setStatus("done");
    } catch (err: any) {
      setStatus("idle");
      setError(err?.message || "Failed to generate plan");
    }
  };

  const disabled = !metrics || status === "generating";

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, marginTop: 20 }}>
      <h2>Step 2: Coach Plan</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Skill level:
          <select
            value={skillLevel}
            onChange={(e) => setSkillLevel(e.target.value)}
            style={{ marginLeft: 8 }}
          >
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 240 }}>
          Goal:
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            style={{ width: "100%", padding: 8, marginLeft: 8 }}
            placeholder="e.g., tighter timing and dynamics"
          />
        </label>
        <button onClick={handleGenerate} disabled={disabled} style={{ padding: "10px 14px" }}>
          {status === "generating" ? "Generating..." : "Generate Plan"}
        </button>
      </div>
      {status === "done" && <div style={{ marginTop: 8, color: "#0a7" }}>Plan ready below.</div>}
      {error && <ErrorBanner message={error} />}
    </div>
  );
};

export default CoachPanel;
