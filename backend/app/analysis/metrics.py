import numpy as np
import librosa
import logging
from fastapi import HTTPException, status

from app.error_responses import raise_error

MIN_SECONDS = 15
MAX_SECONDS = 90
SR = 44100
DEBUG_TIMING = True
TIMING_EASIER_MODE = False

ONSET_DELTA_BASE = 0.25
ONSET_WAIT_FRAMES_BASE = 4
MIN_SEP_MS_BASE = 80.0
MIN_IOI_MS = 60.0
MAX_IOI_MS = 800.0
MIN_IOI_COUNT_BASE = 10
MAD_K = 1.25  # band multiplier for rush/drag
STRENGTH_PERCENTILE_BASE = 80 #default onset-strength

# Fallback ladder (progressively less strict)
FALLBACK_PASSES = [
    {
        "delta": ONSET_DELTA_BASE,
        "wait": ONSET_WAIT_FRAMES_BASE,
        "percentile": STRENGTH_PERCENTILE_BASE,
        "min_sep_ms": MIN_SEP_MS_BASE,
        "min_ioi_count": MIN_IOI_COUNT_BASE,
    },
    {
        "delta": 0.20,
        "wait": 3,
        "percentile": 70,
        "min_sep_ms": 70.0,
        "min_ioi_count": 8,
    },
    {
        "delta": 0.15,
        "wait": 2,
        "percentile": 60,
        "min_sep_ms": 60.0,
        "min_ioi_count": 6,
    },
]

logger = logging.getLogger(__name__)


def _clamp(value: float, min_v: float = 0.0, max_v: float = 1.0) -> float:
    return float(max(min_v, min(max_v, value)))


def _log_timing_debug(onset_count: int, ioi_count: int, target_ms: float, band_ms: float) -> None:
    # Lightweight internal sanity logging; avoid large payloads.
    print(
        f"[timing-debug] onsets={onset_count} ioi_filtered={ioi_count} "
        f"median_ioi_ms={target_ms:.2f} band_ms={band_ms:.2f}"
    )


def analyze_wav_file(path: str) -> dict:
    try:
        y, sr = librosa.load(path, sr=SR, mono=True)
    except FileNotFoundError:
        raise_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Converted audio not found.",
            ["Retry the upload; if it persists, contact support."],
        )
    except Exception as exc:  # pragma: no cover - defensive
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "UNSUPPORTED_FORMAT",
            "Could not read the uploaded audio.",
            ["Re-export the file as WAV or MP3.", "Ensure the file is not DRM-protected."],
            details={"message": str(exc)},
        )

    if y.size == 0:
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "AUDIO_TOO_SHORT",
            "The uploaded file contains no audio.",
            ["Record at least 15 seconds of playing with clear notes."],
        )

    duration = librosa.get_duration(y=y, sr=sr)
    if duration < MIN_SECONDS or duration > MAX_SECONDS:
        if duration < MIN_SECONDS:
            raise_error(
                status.HTTP_400_BAD_REQUEST,
                "AUDIO_TOO_SHORT",
                f"Audio duration is too short ({duration:.1f}s). Minimum is {MIN_SECONDS}s.",
                ["Record at least 15 seconds of playing.", "Include several clear notes with consistent timing."],
            )
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "AUDIO_TOO_LONG",
            f"Audio duration is too long ({duration:.1f}s). Maximum is {MAX_SECONDS}s.",
            ["Trim the clip to under 90 seconds and retry."],
        )

    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak < 0.005:
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "AUDIO_QUALITY_POOR",
            "The recording is too quiet for reliable analysis.",
            [
                "Move closer to the mic or use a direct input.",
                "Increase your instrument level without clipping.",
                "Reduce background noise and hum.",
            ],
        )

    # Tempo (kept for display; timing metrics now IOI-based and independent of beat tracking)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr, trim=False)

    # Onset strength envelope (shared across passes)
    oenv = librosa.onset.onset_strength(y=y, sr=sr)

    onset_times = None
    onset_starts_filt = None
    ioi_ms_filt = None

    # Try progressively looser settings (or override if easier mode is enabled)
    passes = []
    if TIMING_EASIER_MODE:
        passes.append(
            {
                "delta": 0.10,
                "wait": 2,
                "percentile": 55,
                "min_sep_ms": 55.0,
                "min_ioi_count": 6,
            }
        )
    passes.extend(FALLBACK_PASSES)

    # Interpretation cheatsheet for the debug counters:
    # - raw_onsets < 5: onset detection isn’t firing (params too strict or attacks not visible)
    # - raw_onsets high but after_strength_filter near 0: strength filter too strict
    # - after_min_sep collapses: min_sep too high or clustered/double-triggered onsets
    # - ioi_count_after_clamp collapses: IOI clamp too tight OR onsets still noisy

    # Try progressively looser settings
    for params in passes:
        onset_frames = librosa.onset.onset_detect(
            onset_envelope=oenv,
            sr=sr,
            units="frames",
            delta=params["delta"],
            wait=params["wait"],
            backtrack=True,
        )
        onset_times_detected = librosa.frames_to_time(onset_frames, sr=sr)

        if DEBUG_TIMING:
            logger.warning("[TIMING DEBUG] raw_onsets=%d", onset_times_detected.size)

        if onset_times_detected.size == 0:
            continue

        strengths = oenv[onset_frames]

        # Top-N selection (adaptive N list)
        topn_list = [60, 100, 150]
        selected_times = None
        used_topn = None
        for topn in topn_list:
            if strengths.size <= topn:
                keep_idx = np.arange(strengths.size)
            else:
                keep_idx = np.argpartition(strengths, -topn)[-topn:]
            keep_idx = keep_idx[np.argsort(keep_idx)]  # resort by frame/time order
            times_topn = onset_times_detected[keep_idx]
            if DEBUG_TIMING:
                logger.warning("[TIMING DEBUG] topN=%d after_topN_count=%d", topn, times_topn.size)
            # Apply min-sep (primary)
            dedup_times = []
            last_time = None
            for t in times_topn:
                if last_time is None or (t - last_time) * 1000.0 >= params["min_sep_ms"]:
                    dedup_times.append(t)
                    last_time = t
            dedup_times = np.array(dedup_times, dtype=float)
            if dedup_times.size >= 2:
                selected_times = dedup_times
                used_topn = topn
                break

        # Final fallback: allow reduced min_sep if still nothing (but never below 60ms)
        if selected_times is None:
            reduced_sep = max(60.0, params["min_sep_ms"] - 10.0)
            dedup_times = []
            last_time = None
            for t in onset_times_detected:
                if last_time is None or (t - last_time) * 1000.0 >= reduced_sep:
                    dedup_times.append(t)
                    last_time = t
            dedup_times = np.array(dedup_times, dtype=float)
            selected_times = dedup_times if dedup_times.size >= 2 else None
            used_topn = used_topn if used_topn is not None else topn_list[-1]
            if DEBUG_TIMING:
                logger.warning("[TIMING DEBUG] fallback_min_sep=%.1f after_min_sep=%d", reduced_sep, dedup_times.size)

        if selected_times is None or selected_times.size < 2:
            continue

        if DEBUG_TIMING:
            logger.warning("[TIMING DEBUG] after_min_sep=%d (topN=%s)", selected_times.size, used_topn)

        ioi_ms = np.diff(selected_times) * 1000.0

        # Clamp IOIs to plausible range
        valid_mask = (ioi_ms >= MIN_IOI_MS) & (ioi_ms <= MAX_IOI_MS)
        ioi_ms_candidate = ioi_ms[valid_mask]
        onset_starts_candidate = selected_times[:-1][valid_mask]  # start time of each kept IOI

        if DEBUG_TIMING:
            pre_min = float(np.min(ioi_ms)) if ioi_ms.size else 0.0
            pre_max = float(np.max(ioi_ms)) if ioi_ms.size else 0.0
            min_ioi = float(np.min(ioi_ms_candidate)) if ioi_ms_candidate.size else 0.0
            max_ioi = float(np.max(ioi_ms_candidate)) if ioi_ms_candidate.size else 0.0
            rejected_too_small = int(np.sum(ioi_ms < MIN_IOI_MS)) if ioi_ms.size else 0
            rejected_too_large = int(np.sum(ioi_ms > MAX_IOI_MS)) if ioi_ms.size else 0
            logger.warning(
                "[TIMING DEBUG] params delta=%.3f wait=%d min_sep_ms=%.1f min_ioi_ms=%.1f max_ioi_ms=%.1f min_iois=%d topN_used=%s",
                params["delta"],
                params["wait"],
                params["min_sep_ms"],
                MIN_IOI_MS,
                MAX_IOI_MS,
                params["min_ioi_count"],
                str(used_topn),
            )
            logger.warning(
                "[TIMING DEBUG] ioi_count_pre_clamp=%d ioi_ms_pre_clamp_min=%.2f max=%.2f "
                "rejected_too_small=%d rejected_too_large=%d "
                "ioi_count_after_clamp=%d ioi_ms_after_clamp_min=%.2f max=%.2f",
                ioi_ms.size,
                pre_min,
                pre_max,
                rejected_too_small,
                rejected_too_large,
                ioi_ms_candidate.size,
                min_ioi,
                max_ioi,
            )

        if ioi_ms_candidate.size < params["min_ioi_count"]:
            continue

        # Success: keep results of this pass
        onset_times = selected_times
        onset_starts_filt = onset_starts_candidate
        ioi_ms_filt = ioi_ms_candidate
        break

    if ioi_ms_filt is None or onset_times is None:
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "AUDIO_QUALITY_POOR",
            "We couldn't detect enough clear note onsets to analyze timing.",
            [
                "Play with clearer, more percussive attacks.",
                "Reduce background noise and room echo.",
                "Move closer to the mic or use a direct input.",
            ],
        )

    median_ioi = float(np.median(ioi_ms_filt))
    deviation_ms = ioi_ms_filt - median_ioi

    mad = float(np.median(np.abs(deviation_ms)))
    robust_sigma = 1.4826 * mad if mad > 0 else 0.0

    # Mean deviation from median IOI (not beat-grid offset)
    avg_offset = float(np.mean(deviation_ms))
    timing_variance = float(robust_sigma)

    if robust_sigma == 0:
        rushed_pct = 0.0
        dragged_pct = 0.0
        band = 0.0
    else:
        band = MAD_K * robust_sigma
        rushed_pct = float(np.mean(deviation_ms < -band) * 100.0)
        dragged_pct = float(np.mean(deviation_ms > band) * 100.0)

    # Tempo fallback based on median IOI if beat tracking is unstable
    if median_ioi > 0:
        tempo = 60000.0 / median_ioi

    _log_timing_debug(onset_times.size, ioi_ms_filt.size, median_ioi, band)

    # Dynamics
    rms = librosa.feature.rms(y=y).flatten()
    if rms.size == 0:
        rms_db = np.array([0.0])
    else:
        ref = np.max(rms) if np.max(rms) > 0 else 1.0
        rms_db = librosa.amplitude_to_db(rms, ref=ref)
    avg_db = float(np.mean(rms_db))
    p5 = float(np.percentile(rms_db, 5))
    p95 = float(np.percentile(rms_db, 95))
    dynamic_range = p95 - p5
    volume_consistency = _clamp(1 - (float(np.std(rms_db)) / (dynamic_range + 1e-6)))

    # Trends using IOI stability across time thirds
    if onset_times.size < 2 or ioi_ms_filt.size == 0:
        timing_improving = False
        early_std = timing_variance
        late_std = timing_variance
    else:
        first_onset = float(onset_times[0])
        last_onset = float(onset_times[-1])
        total_window = max(1e-6, last_onset - first_onset)
        early_end = first_onset + total_window / 3.0
        late_start = first_onset + 2 * total_window / 3.0

        early_mask = (onset_starts_filt >= first_onset) & (onset_starts_filt < early_end)
        late_mask = (onset_starts_filt >= late_start) & (onset_starts_filt <= last_onset)

        early_std = float(np.std(deviation_ms[early_mask])) if np.any(early_mask) else timing_variance
        late_std = float(np.std(deviation_ms[late_mask])) if np.any(late_mask) else timing_variance
        timing_improving = late_std < early_std

    timing_std_norm = min(1.0, timing_variance / 100.0)
    consistency_score = _clamp(0.5 * (1 - timing_std_norm) + 0.5 * volume_consistency)

    result = {
        "tempo_bpm": round(float(tempo), 2),
        "timing": {
            "average_offset_ms": round(avg_offset, 2),
            "timing_variance_ms": round(timing_variance, 2),
            "rushed_notes_percent": round(rushed_pct, 2),
            "dragged_notes_percent": round(dragged_pct, 2),
        },
        "dynamics": {
            "average_db": round(avg_db, 2),
            "dynamic_range_db": round(dynamic_range, 2),
            "volume_consistency_score": round(volume_consistency, 2),
        },
        "trends": {
            "timing_improving": bool(timing_improving),
            "consistency_score": round(consistency_score, 2),
        },
    }

    # Low dynamic range or extreme noise floors can make results unreliable; flag as quality issues.
    if dynamic_range < 5.0 or avg_db < -45.0:
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "AUDIO_QUALITY_POOR",
            "Recording quality is too poor for reliable feedback (very low dynamics or level).",
            [
                "Record closer to the mic or plug in directly.",
                "Avoid heavy noise reduction/compression that flattens dynamics.",
                "Aim for a healthy level that does not clip.",
            ],
            details={"dynamic_range_db": dynamic_range, "average_db": avg_db},
        )

    return result
