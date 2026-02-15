import { CoachResponse } from "../types";

const line = (text = "") => text + "\n";

export function formatCoachReport(plan: CoachResponse): string {
  const parts: string[] = [];

  parts.push("Guitar AI Coach Report");
  parts.push("======================\n");

  parts.push("Summary");
  parts.push("-------");
  parts.push(`Primary issue: ${plan?.summary?.primary_issue ?? "N/A"}`);
  parts.push(`Confidence: ${plan?.summary?.confidence ?? "N/A"}`);

  const ev = plan?.summary?.evidence || [];
  if (ev.length === 0) {
    parts.push("\nEvidence:\n- (none)");
  } else {
    parts.push("\nEvidence:");
    ev.forEach((e) => parts.push(`- ${e}`));
  }

  parts.push("");
  const total = plan?.total_minutes ?? "N/A";
  parts.push(`Practice Plan (Total: ${total} minutes)`);
  parts.push("----------------------------------------------");

  const drills = (plan?.drills || []).slice(0, 3);
  drills.forEach((d, idx) => {
    const minutes = d.duration_min ?? (d as any).minutes ?? "(unspecified)";
    const tempo = d.tempo_bpm ?? null;
    parts.push(
      `Drill ${idx + 1}: ${d.name || "Untitled"} (${minutes} min${tempo !== null && tempo !== undefined ? `, ${tempo} bpm` : ""})`
    );
    const instr = d.instructions || [];
    parts.push("Instructions:");
    if (instr.length === 0) {
      parts.push("- (none)");
    } else {
      instr.forEach((i) => parts.push(`- ${i}`));
    }
    const crit = d.success_criteria || [];
    parts.push("Success criteria:");
    if (crit.length === 0) {
      parts.push("- (none)");
    } else {
      crit.forEach((c) => parts.push(`- ${c}`));
    }
    parts.push(""); // blank line between drills
  });

  if (plan?.disclaimer) {
    parts.push("Disclaimer:");
    parts.push(plan.disclaimer);
  }

  return parts.join("\n").trimEnd() + "\n";
}
