from typing import Any, Dict, List, Literal

from pydantic import BaseModel


class RuleRecommendation(BaseModel):
    category: Literal[
        "Improve timing and consistency",
        "Clean up volume control",
        "Stop rushing and dragging",
        "Build overall consistency",
    ]
    urgency: Literal["low", "medium", "high"]
    reason: str
    evidence: List[str]


# Tunable thresholds / targets
TIMING_VARIANCE_TARGET = 60.0
TIMING_VARIANCE_RANGE = 120.0
OFFSET_TARGET = 30.0
OFFSET_RANGE = 90.0

RUSH_DRAG_THRESHOLD = 10.0
RUSH_DRAG_RANGE = 20.0

VOLUME_CONSISTENCY_TARGET = 0.80
VOLUME_CONSISTENCY_RANGE = 0.20
DYNAMIC_RANGE_TARGET = 25.0
DYNAMIC_RANGE_RANGE = 20.0

CONSISTENCY_SCORE_TARGET = 0.70
CONSISTENCY_SCORE_RANGE = 0.40


def clamp(val: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, val))


def fmt(key: str, value: Any) -> str:
    try:
        return f"{key}: {float(value):.2f}"
    except Exception:
        return f"{key}: {value}"


def _urgency(severity: float) -> str:
    if severity >= 0.70:
        return "high"
    if severity >= 0.35:
        return "medium"
    return "low"


def generate_rule_recommendations(metrics: Dict[str, Any]) -> List[RuleRecommendation]:
    recs: List[RuleRecommendation] = []

    timing = metrics.get("timing", {}) or {}
    dynamics = metrics.get("dynamics", {}) or {}
    trends = metrics.get("trends", {}) or {}

    # Extract metrics with safe defaults
    tv = float(timing.get("timing_variance_ms", 0.0) or 0.0)
    offset = float(timing.get("average_offset_ms", 0.0) or 0.0)
    rushed = float(timing.get("rushed_notes_percent", 0.0) or 0.0)
    dragged = float(timing.get("dragged_notes_percent", 0.0) or 0.0)
    vcs = float(dynamics.get("volume_consistency_score", 0.0) or 0.0)
    dyn_range = float(dynamics.get("dynamic_range_db", 0.0) or 0.0)
    cons = trends.get("consistency_score", None)
    cons_val = float(cons) if cons is not None else None

    # Timing & consistency
    tv_component = clamp((tv - TIMING_VARIANCE_TARGET) / TIMING_VARIANCE_RANGE)
    offset_component = clamp((abs(offset) - OFFSET_TARGET) / OFFSET_RANGE)
    timing_severity = 0.7 * tv_component + 0.3 * offset_component
    if timing_severity > 0:
        recs.append(
            RuleRecommendation(
                category="Improve timing and consistency",
                urgency=_urgency(timing_severity),
                reason=f"Timing variance is elevated ({tv:.2f} ms) and/or average offset is high ({offset:.2f} ms).",
                evidence=[fmt("timing_variance_ms", tv), fmt("average_offset_ms", offset)],
            )
        )

    # Stop rushing / dragging
    rushed_component = clamp((rushed - RUSH_DRAG_THRESHOLD) / RUSH_DRAG_RANGE)
    dragged_component = clamp((dragged - RUSH_DRAG_THRESHOLD) / RUSH_DRAG_RANGE)
    rush_severity = max(rushed_component, dragged_component)
    if rush_severity > 0:
        evidence = [fmt("rushed_notes_percent", rushed), fmt("dragged_notes_percent", dragged)]
        recs.append(
            RuleRecommendation(
                category="Stop rushing and dragging",
                urgency=_urgency(rush_severity),
                reason="Rushed or dragged note percentages are elevated.",
                evidence=evidence,
            )
        )

    # Volume control
    vcs_component = clamp((VOLUME_CONSISTENCY_TARGET - vcs) / VOLUME_CONSISTENCY_RANGE)
    dyn_component = clamp((dyn_range - DYNAMIC_RANGE_TARGET) / DYNAMIC_RANGE_RANGE)
    volume_severity = 0.7 * vcs_component + 0.3 * dyn_component
    if volume_severity > 0:
        evidence = [fmt("volume_consistency_score", vcs), fmt("dynamic_range_db", dyn_range)]
        recs.append(
            RuleRecommendation(
                category="Clean up volume control",
                urgency=_urgency(volume_severity),
                reason="Volume consistency or dynamic range is outside the target band.",
                evidence=evidence,
            )
        )

    # Overall consistency
    if cons_val is not None:
        cons_component = clamp((CONSISTENCY_SCORE_TARGET - cons_val) / CONSISTENCY_SCORE_RANGE)
        consistency_severity = cons_component
    else:
        consistency_severity = 0.5 * timing_severity + 0.5 * volume_severity

    if consistency_severity > 0:
        evidence = []
        if cons_val is not None:
            evidence.append(fmt("consistency_score", cons_val))
        else:
            evidence.append(fmt("timing_variance_ms", tv))
            evidence.append(fmt("volume_consistency_score", vcs))
        # Ensure at least 2 bullets
        if len(evidence) < 2:
            evidence.append(fmt("dynamic_range_db", dyn_range))
        recs.append(
            RuleRecommendation(
                category="Build overall consistency",
                urgency=_urgency(consistency_severity),
                reason="Overall consistency could be improved based on current trends.",
                evidence=evidence,
            )
        )

    return recs
