import React from "react";
import { CoachDrill } from "../types";

interface Props {
  drill: CoachDrill;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
  drillId: string;
}

const DrillCard: React.FC<Props> = ({ drill, index, isOpen, onToggle, drillId }) => {
  const minutes = drill.duration_min ?? drill.minutes ?? null;
  const tempo = drill.tempo_bpm ?? null;
  const instructions = drill.instructions || [];
  const criteria = drill.success_criteria || [];

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, marginBottom: 12, background: "white" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 600 }}>
          {index + 1}. {drill.name || "Untitled drill"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 13, color: "#555", textAlign: "right", minWidth: 90 }}>
            {minutes !== null ? `${minutes} min` : "— min"}
            {tempo !== null ? ` • ${tempo} bpm` : ""}
          </div>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-controls={`${drillId}-details`}
            style={{
              border: "1px solid #ccc",
              background: isOpen ? "#f0f0f0" : "white",
              borderRadius: 8,
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {isOpen ? "Hide details" : "Show details"}
          </button>
        </div>
      </div>

      {isOpen && (
        <div id={`${drillId}-details`} style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#444" }}>Instructions</div>
          {instructions.length === 0 ? (
            <div style={{ fontSize: 13, color: "#999" }}>No instructions provided.</div>
          ) : (
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {instructions.map((step, idx) => (
                <li key={idx} style={{ marginBottom: 4, fontSize: 14 }}>
                  {step}
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13, color: "#444" }}>Success criteria</div>
          {criteria.length === 0 ? (
            <div style={{ fontSize: 13, color: "#999" }}>No success criteria provided.</div>
          ) : (
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {criteria.map((crit, idx) => (
                <li key={idx} style={{ marginBottom: 4, fontSize: 14 }}>
                  {crit}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default DrillCard;
