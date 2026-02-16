import pytest

from app.coaching.rules import generate_rule_recommendations


def _find(recs, category):
    return next((r for r in recs if r.category == category), None)


def test_timing_high_severity():
    metrics = {
        "timing": {
            "timing_variance_ms": 200.0,
            "average_offset_ms": 80.0,
        },
        "dynamics": {"volume_consistency_score": 0.9, "dynamic_range_db": 12.0},
    }
    recs = generate_rule_recommendations(metrics)
    rec = _find(recs, "Improve timing and consistency")
    assert rec is not None
    assert rec.urgency == "high"
    assert any("timing_variance_ms" in ev for ev in rec.evidence)


def test_rushing_or_dragging():
    metrics = {
        "timing": {
            "rushed_notes_percent": 25.0,
            "dragged_notes_percent": 5.0,
        },
        "dynamics": {"volume_consistency_score": 0.9, "dynamic_range_db": 12.0},
    }
    recs = generate_rule_recommendations(metrics)
    rec = _find(recs, "Stop rushing and dragging")
    assert rec is not None
    assert rec.urgency in {"medium", "high"}
    assert any("rushed_notes_percent" in ev for ev in rec.evidence)


def test_volume_control():
    metrics = {
        "timing": {"timing_variance_ms": 40.0, "average_offset_ms": 10.0},
        "dynamics": {"volume_consistency_score": 0.50, "dynamic_range_db": 30.0},
    }
    recs = generate_rule_recommendations(metrics)
    rec = _find(recs, "Clean up volume control")
    assert rec is not None
    assert rec.urgency == "high"
    assert any("volume_consistency_score" in ev for ev in rec.evidence)


def test_overall_consistency():
    metrics = {
        "timing": {"timing_variance_ms": 50.0, "average_offset_ms": 10.0},
        "dynamics": {"volume_consistency_score": 0.85, "dynamic_range_db": 15.0},
        "trends": {"consistency_score": 0.40},
    }
    recs = generate_rule_recommendations(metrics)
    rec = _find(recs, "Build overall consistency")
    assert rec is not None
    assert rec.urgency == "high"
    assert any("consistency_score" in ev for ev in rec.evidence)
