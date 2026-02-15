import React from "react";
import { CoachResponse } from "../types";

type CoachSummary = CoachResponse["summary"];

interface Props {
  summary?: CoachSummary | null;
}

const pillColors: Record<string, string> = {
  low: "#f57c00",
  medium: "#fbc02d",
  high: "#388e3c",
};

const SummaryCard: React.FC<Props> = ({ summary }) => {
  const issue = summary?.primary_issue || "No summary available";
  const confidence = (summary?.confidence || "unknown").toLowerCase();
  const evidence = summary?.evidence || [];

  const pillColor = pillColors[confidence] || "#9e9e9e";

  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: 12, padding: 16, background: "white", boxShadow: "0 2px 4px rgba(0,0,0,0.04)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Summary</h3>
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            background: pillColor,
            color: "white",
            fontSize: 12,
            textTransform: "capitalize",
          }}
        >
          {confidence}
        </span>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: "#666" }}>Primary issue</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{issue}</div>
      </div>

      <div>
        <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Evidence</div>
        {evidence.length === 0 ? (
          <div style={{ color: "#999", fontSize: 13 }}>No evidence provided.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {evidence.map((e, idx) => (
              <li key={idx} style={{ marginBottom: 4, fontSize: 14 }}>
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default SummaryCard;
