import React, { useState } from "react";
import { CoachDrill } from "../types";
import DrillCard from "./DrillCard";

interface Props {
  drills?: CoachDrill[] | null;
  totalMinutes?: number | null;
}

const PracticePlan: React.FC<Props> = ({ drills = [], totalMinutes }) => {
  const shown = drills.slice(0, 3);
  const expected = 3;
  const warn = drills.length !== expected;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: 12, padding: 16, background: "white", boxShadow: "0 2px 4px rgba(0,0,0,0.04)", marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Practice Plan</h3>
      </div>
      {warn && (
        <div style={{ fontSize: 12, color: "#b36b00", marginBottom: 8 }}>
          Expected 3 drills, received {drills.length}.
        </div>
      )}
      {shown.length === 0 ? (
        <div style={{ fontSize: 13, color: "#999" }}>No drills provided.</div>
      ) : (
        shown.map((drill, idx) => (
          <DrillCard
            key={idx}
            drill={drill}
            index={idx}
            isOpen={openIndex === idx}
            onToggle={() => setOpenIndex(openIndex === idx ? null : idx)}
            drillId={`drill-${idx}`}
          />
        ))
      )}
    </div>
  );
};

export default PracticePlan;
