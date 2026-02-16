import json
import os
import re
import logging
import traceback
import unicodedata
from copy import deepcopy
from typing import Any, Dict, List, Optional, Literal, Set

from fastapi import HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from app.error_responses import raise_error, build_error_response
from app.coaching.rules import RuleRecommendation, generate_rule_recommendations

logger = logging.getLogger(__name__)


class Summary(BaseModel):
    primary_issue: str
    evidence: List[str]
    confidence: Literal["low", "medium", "high"]

    @field_validator("evidence")
    @classmethod
    def evidence_not_empty(cls, v: List[str]) -> List[str]:
        if not v:
            raise ValueError("evidence must not be empty")
        return v


class Drill(BaseModel):
    name: str
    duration_min: int
    tempo_bpm: int
    instructions: List[str]
    success_criteria: List[str]

    @field_validator("duration_min")
    @classmethod
    def duration_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("duration_min must be positive")
        return v

    @field_validator("tempo_bpm")
    @classmethod
    def tempo_range(cls, v: int) -> int:
        if not (40 <= v <= 220):
            raise ValueError("tempo_bpm must be between 40 and 220")
        return v

    @field_validator("instructions")
    @classmethod
    def instructions_not_empty(cls, v: List[str]) -> List[str]:
        if not v:
            raise ValueError("instructions must not be empty")
        return v

    @field_validator("success_criteria")
    @classmethod
    def criteria_not_empty(cls, v: List[str]) -> List[str]:
        if not v:
            raise ValueError("success_criteria must not be empty")
        return v


class CoachResponse(BaseModel):
    summary: Summary
    drills: List[Drill]
    total_minutes: int
    disclaimer: Optional[str] = None
    rule_recommendations: List[RuleRecommendation] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_drills_and_total(cls, values: "CoachResponse") -> "CoachResponse":
        drills = values.drills or []
        if len(drills) != 3:
            raise ValueError("drills must contain exactly 3 items")
        duration_sum = sum(d.duration_min for d in drills)
        # normalize total_minutes to 10 if close (9-11) to enforce target
        if 9 <= duration_sum <= 11:
            values.total_minutes = 10
        if values.total_minutes != 10:
            values.total_minutes = 10
        if duration_sum <= 0:
            raise ValueError("total_minutes must be positive")
        return values


class CoachRequest(BaseModel):
    metrics: Dict[str, Any]
    skill_level: Literal["beginner", "intermediate", "advanced"]
    goal: str
    notes: Optional[str] = None


# ---------------- LLM Adapter ---------------- #

def call_llm(prompt: str, metrics: Dict[str, Any], provider: Optional[str] = None, schema: Optional[Dict[str, Any]] = None, attempt: int = 1, system_prompt: Optional[str] = None) -> str:
    provider = (provider or os.getenv("LLM_PROVIDER", "mock")).lower()
    print("[LLM DEBUG] PROVIDER:", provider)
    logger.info("[COACH] provider=%s attempt=%d", provider, attempt)

    if provider == "mock":
        mv = build_metric_value_map(metrics)

        def pick_evidence(primary_issue: str) -> List[str]:
            category = classify_primary_issue(primary_issue)
            timing_keys = ["timing_variance_ms", "rushed_notes_percent", "dragged_notes_percent", "consistency_score"]
            dynamics_keys = ["dynamic_range_db", "volume_consistency_score"]
            speed_keys = ["tempo_bpm"]

            if category == "timing":
                pref = timing_keys
            elif category == "dynamics":
                pref = dynamics_keys
            else:
                pref = speed_keys

            evidence_lines = []
            for k in pref:
                if k in mv:
                    evidence_lines.append(f"{k} {mv[k]} shows the issue")
                if len(evidence_lines) == 2:
                    return evidence_lines

            if len(evidence_lines) < 2:
                for k, v in mv.items():
                    if category != "speed" and k == "tempo_bpm":
                        continue
                    if k in pref:
                        continue
                    evidence_lines.append(f"{k} {v} needs improvement")
                    if len(evidence_lines) == 2:
                        break

            if not evidence_lines:
                evidence_lines.append("timing_variance_ms 50.00 shows the issue")
            return evidence_lines

        evidence_lines = pick_evidence(metrics.get("primary_issue", "timing"))
        return json.dumps(
            {
                "summary": {
                    "primary_issue": "Timing variance is elevated",
                    "evidence": evidence_lines,
                    "confidence": "medium",
                },
                "drills": [
                    {
                        "name": "Click-backed eighths",
                        "duration_min": 3,
                        "tempo_bpm": 80,
                        "instructions": [
                            "Play continuous down-up eighths on one string",
                            "Accentuate beat 1 lightly",
                            "Stay locked to click; record yourself"
                        ],
                        "success_criteria": [
                            "Reduce timing_variance_ms below 50.00 (currently 50.00)",
                        ],
                    },
                    {
                        "name": "Subdivision control",
                        "duration_min": 3,
                        "tempo_bpm": 70,
                        "instructions": [
                            "Alternate between straight eighths and swung feel",
                            "Keep pick attack consistent; mute lightly",
                            "Count aloud 1-&-2-&"
                        ],
                        "success_criteria": [
                            "Bring rushed_notes_percent below 10.00 (currently 12.00)",
                        ],
                    },
                    {
                        "name": "Dynamics ladder",
                        "duration_min": 4,
                        "tempo_bpm": 90,
                        "instructions": [
                            "Play 4-bar cycles: pp, p, mp, mf",
                            "Keep tempo steady; match click",
                            "Record and check RMS spread"
                        ],
                        "success_criteria": [
                            "Increase volume_consistency_score above 0.80 (currently 0.70)",
                        ],
                    },
                ],
                "total_minutes": 10,
                "disclaimer": None,
            }
        )

    if provider == "openai":
        try:
            from openai import OpenAI
        except Exception as exc:
            raise_error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "OpenAI SDK is not installed on the server.",
                ["Install the OpenAI Python SDK and retry."],
                details={"message": str(exc)},
            )

        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise_error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "OPENAI_API_KEY is not configured.",
                ["Set the OPENAI_API_KEY environment variable and try again."],
            )
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

        client = OpenAI(api_key=api_key)
        schema_for_openai = strict_json_schema(schema or {})
        logger.info("[COACH] applying strict additionalProperties to schema for OpenAI")
        try:
            resp = client.responses.create(
                model=model,
                temperature=0.4,
                max_output_tokens=1500,
                instructions=system_prompt or "Return ONLY JSON matching the provided schema. No markdown. No extra keys.",
                input=prompt,
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "coach_plan",
                        "strict": True,
                        "schema": schema_for_openai,
                    }
                },
            )
        except Exception as exc:
            log_coach_failure("provider_call", str(exc))
            msg = str(exc)
            if "timeout" in msg.lower():
                raise_error(
                    status.HTTP_504_GATEWAY_TIMEOUT,
                    "LLM_TIMEOUT",
                    "The coaching model timed out.",
                    ["Try again in a few seconds.", "If it keeps failing, retry after re-running analysis."],
                    details={"message": msg},
                )
            raise_error(
                status.HTTP_502_BAD_GATEWAY,
                "LLM_INVALID_OUTPUT",
                "The coaching model returned an invalid response.",
                ["Try again in a few seconds.", "If it persists, re-run analysis and retry coaching."],
                details={"message": msg},
            )

        def extract_output(r):
            try:
                if getattr(r, "output_text", None):
                    return r.output_text
            except Exception:
                pass
            try:
                return r.output[0].content[0].text
            except Exception:
                return None

        raw_out = extract_output(resp)
        if not raw_out:
            log_coach_failure("provider_call", "Could not extract OpenAI response text", None, {})
            raise_error(
                status.HTTP_502_BAD_GATEWAY,
                "LLM_INVALID_OUTPUT",
                "The coaching model returned an invalid response.",
                ["Try again in a few seconds.", "If it persists, re-run analysis and retry coaching."],
            )
        return raw_out

    raise_error(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "Unsupported LLM provider configured.",
        ["Set LLM_PROVIDER to 'openai' or leave unset for mock."],
        details={"provider": provider},
    )


# ---------------- Prompting & Guardrails ---------------- #

EVIDENCE_KEYWORDS = ["tempo", "variance", "rushed", "dragged", "dynamic", "range", "consistency"]
NUM_REGEX = re.compile(r"\d+(?:\.\d+)?")
ALLOWED_METRIC_KEYS = [
    ("tempo_bpm",),
    ("timing", "timing_variance_ms"),
    ("timing", "rushed_notes_percent"),
    ("timing", "dragged_notes_percent"),
    ("dynamics", "dynamic_range_db"),
    ("dynamics", "volume_consistency_score"),
    ("trends", "consistency_score"),
]


def extract_citation_numbers(metrics: Dict[str, Any]) -> Set[str]:
    numbers: Set[str] = set()
    for path in ALLOWED_METRIC_KEYS:
        try:
            val = metrics
            for key in path:
                val = val[key]
            num = float(val)
            numbers.add(f"{num:.2f}")
        except Exception:
            continue
    return numbers


def evidence_has_exact_citations(evidence: List[str], allowed_numbers: Set[str]) -> bool:
    if not allowed_numbers:
        return False
    text = " ".join(evidence)
    found = {n for n in allowed_numbers if n in text}
    return len(found) >= 2


def build_metric_value_map(metrics: Dict[str, Any]) -> Dict[str, str]:
    mapping = {}
    for key, path in {
        "tempo_bpm": ("tempo_bpm",),
        "timing_variance_ms": ("timing", "timing_variance_ms"),
        "rushed_notes_percent": ("timing", "rushed_notes_percent"),
        "dragged_notes_percent": ("timing", "dragged_notes_percent"),
        "dynamic_range_db": ("dynamics", "dynamic_range_db"),
        "volume_consistency_score": ("dynamics", "volume_consistency_score"),
        "consistency_score": ("trends", "consistency_score"),
    }.items():
        try:
            val = metrics
            for p in path:
                val = val[p]
            mapping[key] = f"{float(val):.2f}"
        except Exception:
            continue
    return mapping


def strict_json_schema(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively set additionalProperties=False on all object schemas."""
    def _patch(node: Any) -> Any:
        if isinstance(node, dict):
            is_object = node.get("type") == "object" or "properties" in node
            if is_object and "additionalProperties" not in node:
                node["additionalProperties"] = False
            if is_object and isinstance(node.get("properties"), dict):
                prop_keys = list(node["properties"].keys())
                node["required"] = prop_keys

            # Recurse properties
            if "properties" in node and isinstance(node["properties"], dict):
                for k, v in node["properties"].items():
                    node["properties"][k] = _patch(v)

            # Recurse items
            if "items" in node:
                node["items"] = _patch(node["items"])

            # Recurse combinators
            for key in ("anyOf", "oneOf", "allOf"):
                if key in node and isinstance(node[key], list):
                    node[key] = [_patch(v) for v in node[key]]

            # Recurse defs
            for key in ("$defs", "definitions"):
                if key in node and isinstance(node[key], dict):
                    for k, v in node[key].items():
                        node[key][k] = _patch(v)

            # additionalProperties if it's a schema dict
            if isinstance(node.get("additionalProperties"), dict):
                node["additionalProperties"] = _patch(node["additionalProperties"])

        elif isinstance(node, list):
            node = [_patch(v) for v in node]
        return node

    return _patch(deepcopy(schema))


def evidence_has_correct_pairs(evidence: List[str], mv: Dict[str, str], min_pairs: int = 2) -> bool:
    passed = set()
    for line in evidence:
        for name, val in mv.items():
            if name in line and val in line:
                passed.add(name)
    return len(passed) >= min_pairs


def classify_primary_issue(primary_issue: str) -> str:
    s = primary_issue.lower()
    if "dynamic" in s or "volume" in s:
        return "dynamics"
    if "speed" in s or "tempo" in s:
        return "speed"
    if any(k in s for k in ["timing", "rhythm", "variance", "rushed", "dragged"]):
        return "timing"
    return "timing"


def evidence_has_relevant_pair(evidence: List[str], mv: Dict[str, str], allowed_metric_names: Set[str]) -> bool:
    for line in evidence:
        for name in allowed_metric_names:
            if name in mv and name in line and mv[name] in line:
                return True
    return False


def build_problem_metrics(metrics: Dict[str, Any]) -> Dict[str, float]:
    out = {}
    try:
        tv = float(metrics.get("timing", {}).get("timing_variance_ms", 0))
        if tv > 40:
            out["timing_variance_ms"] = tv
    except Exception:
        pass
    try:
        rp = float(metrics.get("timing", {}).get("rushed_notes_percent", 0))
        if rp > 15:
            out["rushed_notes_percent"] = rp
    except Exception:
        pass
    try:
        dp = float(metrics.get("timing", {}).get("dragged_notes_percent", 0))
        if dp > 15:
            out["dragged_notes_percent"] = dp
    except Exception:
        pass
    try:
        dr = float(metrics.get("dynamics", {}).get("dynamic_range_db", 0))
        if dr < 8:
            out["dynamic_range_db"] = dr
    except Exception:
        pass
    try:
        vcs = float(metrics.get("dynamics", {}).get("volume_consistency_score", 1))
        if vcs < 0.5:
            out["volume_consistency_score"] = vcs
    except Exception:
        pass
    try:
        cs = float(metrics.get("trends", {}).get("consistency_score", 1))
        if cs < 0.6:
            out["consistency_score"] = cs
    except Exception:
        pass
    return out


def evidence_supports_issue(evidence: List[str], primary_issue: str, mv_map: Dict[str, str], problem_metrics: Dict[str, float]) -> bool:
    # at least one problem metric cited
    if not any(name in " ".join(evidence) for name in problem_metrics.keys()):
        return False
    issue_lower = primary_issue.lower()
    if "timing" in issue_lower:
        if not any(m in " ".join(evidence) for m in ["timing_variance_ms", "rushed_notes_percent", "dragged_notes_percent", "consistency_score"]):
            return False
    if "dynamics" in issue_lower:
        if not any(m in " ".join(evidence) for m in ["dynamic_range_db", "volume_consistency_score"]):
            return False
    # tempo use only if primary issue is speed-related
    if "tempo_bpm" in " ".join(evidence):
        if all(k not in issue_lower for k in ["speed", "tempo"]):
            return False
    return True


def validate_success_criteria(drills: List[Drill], metrics: Dict[str, Any]) -> bool:
    curr = {
        "rushed_notes_percent": float(metrics.get("timing", {}).get("rushed_notes_percent", 0)),
        "dragged_notes_percent": float(metrics.get("timing", {}).get("dragged_notes_percent", 0)),
        "timing_variance_ms": float(metrics.get("timing", {}).get("timing_variance_ms", 0)),
        "volume_consistency_score": float(metrics.get("dynamics", {}).get("volume_consistency_score", 0)),
        "dynamic_range_db": float(metrics.get("dynamics", {}).get("dynamic_range_db", 0)),
        "consistency_score": float(metrics.get("trends", {}).get("consistency_score", 0)),
    }

    supported_metrics = set(curr.keys())
    eps = 1e-6

    def detect_metric(text: str) -> Optional[str]:
        for name in supported_metrics:
            if name in text:
                return name
        return None

    def parse_target(text: str) -> Optional[float]:
        # Strip optional (currently ...) clause before extracting the target
        stripped = re.sub(r"\(currently[^)]*\)", "", text, flags=re.IGNORECASE)
        nums = NUM_REGEX.findall(stripped)
        if not nums:
            return None
        try:
            return float(nums[0])
        except Exception:
            return None

    for drill in drills:
        for crit in drill.success_criteria:
            lower = crit.lower()
            metric = detect_metric(lower)
            if not metric:
                return False

            target = parse_target(crit)
            if target is None:
                return False

            current_val = curr[metric]

            if "increase" in lower:
                if current_val >= 1.0 - eps:
                    continue
                if not (target > current_val):
                    return False
            elif "reduce" in lower or "bring" in lower:
                if current_val <= eps:
                    if "bring" in lower:
                        if target > eps:
                            return False
                    # If already zero, allow reduce target regardless as there is no improvement possible.
                    continue
                if not (target < current_val):
                    return False
            else:
                # Unknown direction keyword
                return False
    return True


UNSUPPORTED_PHRASES = ["±", "offset", "beat grid", "histogram", "outside ±", "per-note", "per note", "offsets"]


def sanitize_success_criteria(criteria: List[str], metrics: Dict[str, Any]) -> List[str]:
    sanitized: List[str] = []

    curr_variance = float(metrics.get("timing", {}).get("timing_variance_ms", 0.0))
    curr_rushed = float(metrics.get("timing", {}).get("rushed_notes_percent", 0.0))
    curr_dragged = float(metrics.get("timing", {}).get("dragged_notes_percent", 0.0))
    curr_dyn = float(metrics.get("dynamics", {}).get("dynamic_range_db", 0.0))
    curr_vcs = float(metrics.get("dynamics", {}).get("volume_consistency_score", 0.0))
    curr_cons = float(metrics.get("trends", {}).get("consistency_score", 0.0))

    suggestions = [
        f"Reduce timing_variance_ms below {curr_variance * 0.85:.2f} (currently {curr_variance:.2f})",
        f"Bring rushed_notes_percent below {max(curr_rushed * 0.85, curr_rushed - 2.0, 0):.2f} (currently {curr_rushed:.2f})",
        f"Bring dragged_notes_percent below {max(curr_dragged * 0.85, curr_dragged - 2.0, 0):.2f} (currently {curr_dragged:.2f})",
        f"Increase volume_consistency_score above {min(curr_vcs + 0.05, 1.0):.2f} (currently {curr_vcs:.2f})",
        f"Increase dynamic_range_db above {curr_dyn + 2.0:.2f} (currently {curr_dyn:.2f})",
        f"Increase consistency_score above {min(curr_cons + 0.10, 1.0):.2f} (currently {curr_cons:.2f})",
    ]

    allowed_names = [
        "timing_variance_ms",
        "rushed_notes_percent",
        "dragged_notes_percent",
        "dynamic_range_db",
        "volume_consistency_score",
        "consistency_score",
    ]

    canonical_by_metric = {
        "timing_variance_ms": suggestions[0],
        "rushed_notes_percent": suggestions[1],
        "dragged_notes_percent": suggestions[2],
        "volume_consistency_score": suggestions[3],
        "dynamic_range_db": suggestions[4],
        "consistency_score": suggestions[5],
    }

    seen_metrics: Set[str] = set()

    def next_suggestion() -> Optional[str]:
        for key in allowed_names:
            if key not in seen_metrics:
                seen_metrics.add(key)
                return canonical_by_metric[key]
        return None

    # process incoming criteria
    for item in criteria:
        lowered = item.lower()
        if any(phrase in lowered for phrase in UNSUPPORTED_PHRASES):
            continue

        matched_metric = next((name for name in allowed_names if name in lowered), None)
        if matched_metric:
            if matched_metric in seen_metrics:
                continue  # dedupe per metric
            seen_metrics.add(matched_metric)
            sanitized.append(canonical_by_metric[matched_metric])
        else:
            suggestion = next_suggestion()
            if suggestion:
                sanitized.append(suggestion)

    # backfill if empty or still need at least one per drill
    if not sanitized:
        suggestion = next_suggestion()
        if suggestion:
            sanitized.append(suggestion)

    return sanitized


def log_coach_failure(stage: str, reason: str, raw: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> None:
    try:
        preview = raw[:500] if raw else None
        logger.error(
            "[COACH] stage=%s reason=%s extra=%s raw_preview=%s",
            stage,
            reason,
            extra,
            preview,
        )
    except Exception:
        # Never let logging crash the flow
        pass


SYSTEM_PROMPT = """You are a guitar practice coach.

You MUST output ONLY a single JSON object that conforms EXACTLY to the provided JSON Schema.
- No markdown, no code fences, no explanations, no extra keys.
- If you are unsure, still output valid JSON that conforms to the schema.

Quality rules:
- The plan MUST contain EXACTLY 3 drills.
- Evidence bullets MUST be an array of strings where each string is EXACTLY in this format:
    "<metric_key>: <numeric_value>"
  Examples:
    "timing_variance_ms: 268.54"
    "rushed_notes_percent: 38.89"
    "dynamic_range_db: 28.06"
    "volume_consistency_score: 0.68"
- numeric_value MUST be copied from the provided metrics JSON (exact value, same decimals you output).
- Provide at least 2 evidence bullets.
- If the primary issue involves multiple domains (timing AND dynamics), include at least one evidence key for each relevant domain.
- Drills must be concrete (metronome markings, reps/sets, minutes, what to listen for).
- Avoid generic advice unless tied to cited metrics with the exact format above.
"""


def build_prompt(request: CoachRequest, disclaimer: Optional[str], mv_map: Dict[str, str]) -> tuple[str, str]:
    metrics_json = json.dumps(request.metrics, ensure_ascii=False, separators=(",", ":"))
    allowed_tokens = [f"{k}: {v}" for k, v in mv_map.items()]
    user_prompt = (
        "Input:\n"
        f"- skill_level: {request.skill_level}\n"
        f"- goal: {request.goal}\n"
        f"- metrics_json: {metrics_json}\n\n"
        "Hard requirements:\n"
        "1) Output EXACTLY 3 drills.\n"
        "2) Each drill MUST include:\n"
        "   - a clear name/title\n"
        "   - duration in minutes\n"
        "   - step-by-step instructions (actionable, measurable)\n"
        "   - Evidence: at least 2 items formatted EXACTLY as '<metric_key>: <numeric_value>' and pulled from metrics_json.\n"
        "3) At least 1 drill MUST target timing if any of these are present:\n"
        "   timing.rushed_notes_percent, timing.dragged_notes_percent, timing.timing_variance_ms, timing.average_offset_ms\n"
        "4) At least 1 drill MUST target dynamics if any of these are present:\n"
        "   dynamics.dynamic_range_db, dynamics.volume_consistency_score, dynamics.average_db\n"
        "5) If the metrics indicate performance is already strong (e.g., low variance, low rushed/dragged, high consistency), then create “refinement” drills (groove, articulation, tone, musicality) BUT still cite the strongest metrics as evidence.\n\n"
        "Reminder:\n"
        "Evidence bullets MUST follow exactly '<metric_key>: <value>' using keys present in metrics_json. No prose-only evidence. No extra words.\n"
        "Summary.evidence MUST include at least 2 items copied EXACTLY from the Allowed Evidence Tokens list below.\n"
        "DO NOT change spacing, decimals, or names.\n\n"
        "Allowed Evidence Tokens (COPY EXACTLY):\n"
    )
    for tok in allowed_tokens:
        user_prompt += f"- {tok}\n"
    user_prompt += "\nReturn ONLY JSON.\n"
    if disclaimer:
        user_prompt += f"\nDisclaimer: {disclaimer}\n"
    return SYSTEM_PROMPT, user_prompt


TIMING_KEYS = {"timing_variance_ms", "rushed_notes_percent", "dragged_notes_percent", "average_offset_ms", "consistency_score"}
DYNAMICS_KEYS = {"dynamic_range_db", "volume_consistency_score", "average_db"}


def flatten_metric_values(mv_map: Dict[str, str]) -> Dict[str, float]:
    flat: Dict[str, float] = {}
    for k, v in mv_map.items():
        try:
            flat[k] = float(v)
        except Exception:
            continue
    return flat


EVIDENCE_REGEX_STRICT = re.compile(r"^([A-Za-z0-9_]+)\s*:\s*(-?\d+(?:\.\d+)?)$")


def parse_or_salvage_evidence_bullet(bullet: str) -> Optional[tuple[str, float]]:
    bullet_original = bullet
    try:
        bullet = unicodedata.normalize("NFKC", bullet)
    except Exception:
        pass
    bullet = bullet.replace("：", ":").strip()

    strict_match = EVIDENCE_REGEX_STRICT.match(bullet)
    if strict_match:
        try:
            return strict_match.group(1), float(strict_match.group(2))
        except Exception:
            return None

    key_match = re.match(r"^([A-Za-z0-9_]+)", bullet)
    val_match = re.search(r"(-?\d+(?:\.\d+)?)", bullet)

    if key_match and val_match:
        key = key_match.group(1)
        val_str = val_match.group(1)
        try:
            val = float(val_str)
        except Exception:
            val = None
        if val is not None:
            logger.info(
                "[COACH] stage=%s message=%s extra=%s",
                "guardrail_format_salvaged",
                "Evidence bullet salvaged",
                {
                    "salvaged": True,
                    "bullet_repr": repr(bullet_original),
                    "bullet_norm_repr": repr(bullet),
                    "normalized": f"{key}: {val_str}",
                    "pattern": EVIDENCE_REGEX_STRICT.pattern,
                    "bullet_len": len(bullet),
                },
            )
            return key, val

    log_coach_failure(
        "guardrail_format",
        "Evidence bullet format invalid",
        None,
        {
            "bullet_repr": repr(bullet_original),
            "bullet_norm_repr": repr(bullet),
            "bullet_len": len(bullet),
            "pattern": EVIDENCE_REGEX_STRICT.pattern,
        },
    )
    return None


def validate_evidence(resp: CoachResponse, mv_map: Dict[str, str]) -> None:
    evidence = resp.summary.evidence
    if len(evidence) < 2:
        raise ValueError("Evidence must contain at least two bullets.")

    metric_values = flatten_metric_values(mv_map)
    parsed: List[tuple[str, float]] = []
    for bullet in evidence:
        parsed_item = parse_or_salvage_evidence_bullet(bullet)
        if not parsed_item:
            log_coach_failure("guardrail_format", "Evidence bullet format invalid", None, {"bullet": bullet})
            raise ValueError("Evidence format invalid; expected '<metric_key>: <value>'")
        key, val = parsed_item
        if key not in metric_values:
            log_coach_failure("guardrail_missing_key", "Evidence key not in metrics", None, {"key": key})
            raise ValueError("Evidence references unknown metric key")
        metric_val = metric_values[key]
        if abs(metric_val - val) > max(0.05, 0.005 * abs(metric_val if metric_val else 1)):
            log_coach_failure("guardrail_value_mismatch", "Evidence value does not match metrics", None, {"key": key, "expected": metric_val, "got": val})
            raise ValueError("Evidence value does not match metrics")
        parsed.append((key, val))

    primary = resp.summary.primary_issue.lower()
    needs_timing = any(tok in primary for tok in ["timing", "rhythm", "rushed", "dragged", "variance"])
    needs_dynamics = any(tok in primary for tok in ["dynamic", "dynamics", "volume"])

    has_timing = any(k in TIMING_KEYS for k, _ in parsed)
    has_dynamics = any(k in DYNAMICS_KEYS for k, _ in parsed)

    if needs_timing and not has_timing:
        log_coach_failure("guardrail_relevance", "Missing timing evidence", None, {"primary_issue": resp.summary.primary_issue, "evidence": evidence})
        raise ValueError("Evidence does not support primary issue")
    if needs_dynamics and not has_dynamics:
        log_coach_failure("guardrail_relevance", "Missing dynamics evidence", None, {"primary_issue": resp.summary.primary_issue, "evidence": evidence})
        raise ValueError("Evidence does not support primary issue")


async def generate_coach_plan(request: CoachRequest) -> CoachResponse:
    # Confidence/disclaimer heuristic
    disclaimer: Optional[str] = None
    try:
        timing_var = float(request.metrics.get("timing", {}).get("timing_variance_ms", 0))
        vol_consistency = float(request.metrics.get("dynamics", {}).get("volume_consistency_score", 1))
        dyn_range = float(request.metrics.get("dynamics", {}).get("dynamic_range_db", 12))
        tempo_val = float(request.metrics.get("tempo_bpm", 120))
    except Exception:
        timing_var, vol_consistency, dyn_range, tempo_val = 0, 1, 12, 120

    if timing_var > 200 or vol_consistency < 0.3 or dyn_range < 6 or tempo_val < 45 or tempo_val > 200:
        disclaimer = "Recording/analysis confidence is low; try a cleaner guitar-only recording with clear attacks."

    mv_map = build_metric_value_map(request.metrics)
    system_prompt, user_prompt = build_prompt(request, disclaimer, mv_map)
    schema = CoachResponse.model_json_schema()
    # Exclude rule-based recommendations from the LLM schema to avoid forcing the LLM to emit them.
    if "properties" in schema:
        schema["properties"].pop("rule_recommendations", None)
    if "required" in schema:
        schema["required"] = [r for r in schema["required"] if r != "rule_recommendations"]

    def attempt(prompt_text: str, attempt_num: int) -> CoachResponse:
        raw = call_llm(prompt_text, request.metrics, os.getenv("LLM_PROVIDER", "mock"), schema, attempt=attempt_num, system_prompt=system_prompt)
        try:
            data = json.loads(raw)
        except Exception as exc:
            log_coach_failure("parse_json", str(exc), raw)
            raise ValueError(f"LLM returned non-JSON: {exc}")
        try:
            resp = CoachResponse(**data)
        except Exception as exc:
            err_extra = None
            try:
                err_extra = exc.errors()
            except Exception:
                err_extra = None
            log_coach_failure("schema_validation", str(exc), raw, {"errors": err_extra})
            raise ValueError(f"Schema validation failed: {exc}")
        validate_evidence(resp, mv_map)
        # sanitize success criteria to only refer to supported metrics
        for drill in resp.drills:
            drill.success_criteria = sanitize_success_criteria(drill.success_criteria, request.metrics)
        if not validate_success_criteria(resp.drills, request.metrics):
            log_coach_failure(
                "guardrail_targets",
                "Success criteria not logically improving metrics",
                raw,
                {
                    "criteria": [d.success_criteria for d in resp.drills],
                    "current_metrics": request.metrics,
                },
            )
            raise ValueError("Success criteria not logically improving metrics")
        # Ensure disclaimer override if we set one
        if disclaimer:
            resp.disclaimer = disclaimer
        # Rule-based recommendations (non-LLM)
        try:
            resp.rule_recommendations = generate_rule_recommendations(request.metrics)
        except Exception:
            # Don't block the main response if rules fail; log and continue.
            logger.exception("[COACH] rule_recommendations generation failed")
        # Normalize total_minutes to 10 if close
        if 9 <= resp.total_minutes <= 11:
            resp.total_minutes = 10
        return resp

    try:
        return attempt(user_prompt, 1)
    except HTTPException as http_exc:
        # pass through standardized errors (e.g., LLM timeouts)
        raise http_exc
    except Exception as first_exc:
        retry_prefix = (
            "Your last output failed validation.\n"
            "Fix ALL issues and return ONLY JSON matching the schema.\n"
            "Non-negotiable:\n"
            "- EXACTLY 3 drills\n"
            "- Evidence bullets MUST be formatted EXACTLY as '<metric_key>: <value>' using only keys from metrics_json\n"
            "- No generic language; every drill must be justified by cited metrics\n"
            "Return ONLY JSON.\n\n"
        )
        retry_prompt = retry_prefix + user_prompt
        try:
            return attempt(retry_prompt, 2)
        except HTTPException as http_exc:
            raise http_exc
        except Exception as exc:
            import traceback
            traceback.print_exc()
            raise


# --------- Minimal self-checks (dev only) --------- #

def _test_sanitize_success_criteria() -> None:
    metrics = {
        "timing": {"timing_variance_ms": 200.0, "rushed_notes_percent": 12.0, "dragged_notes_percent": 8.0},
        "dynamics": {"dynamic_range_db": 10.0, "volume_consistency_score": 0.7},
        "trends": {"consistency_score": 0.65},
    }
    criteria = ["Reduce timing_variance_ms below 50.00 (currently 50.00)"]
    out = sanitize_success_criteria(criteria, metrics)
    assert out, "sanitized criteria should not be empty"
    first = out[0]
    assert "(currently 200.00)" in first, "current value should reflect real metric"
    target_match = NUM_REGEX.findall(first)
    assert target_match, "target should be present"
    target_val = float(target_match[0])
    assert 169.9 <= target_val <= 170.1, "target should reflect 15% improvement"


def _test_validate_success_criteria_ignores_currently() -> None:
    metrics = {
        "timing": {"timing_variance_ms": 200.0, "rushed_notes_percent": 12.0, "dragged_notes_percent": 8.0},
        "dynamics": {"dynamic_range_db": 10.0, "volume_consistency_score": 0.7},
        "trends": {"consistency_score": 0.65},
    }
    crit = ["Reduce timing_variance_ms below 170.00 (currently 50.00)"]
    drill = Drill(
        name="test",
        duration_min=1,
        tempo_bpm=80,
        instructions=["do thing"],
        success_criteria=crit,
    )
    assert validate_success_criteria([drill], metrics) is True, "mismatched currently clause should be ignored"


def _test_unsupported_metric_replaced() -> None:
    metrics = {
        "timing": {"timing_variance_ms": 200.0, "rushed_notes_percent": 12.0, "dragged_notes_percent": 8.0},
        "dynamics": {"dynamic_range_db": 10.0, "volume_consistency_score": 0.7},
        "trends": {"consistency_score": 0.65},
    }
    out = sanitize_success_criteria(["Lower fret buzz below 2"], metrics)
    assert out, "sanitized criteria should backfill suggestion"
    allowed_names = ["timing_variance_ms", "rushed_notes_percent", "dragged_notes_percent", "dynamic_range_db", "volume_consistency_score", "consistency_score"]
    assert any(name in out[0] for name in allowed_names), "should replace unsupported text with allowed metric suggestion"


def _run_self_tests() -> None:
    _test_sanitize_success_criteria()
    _test_validate_success_criteria_ignores_currently()
    _test_unsupported_metric_replaced()
    print("self-tests passed")


if __name__ == "__main__":
    _run_self_tests()
