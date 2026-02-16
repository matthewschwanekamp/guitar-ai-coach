import os
import subprocess
import tempfile
from typing import Dict, Any, List

from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]
env_path = BASE_DIR / ".env"
load_dotenv(dotenv_path=env_path, override=True)

print("DEBUG dotenv path:", env_path)
print("DEBUG dotenv exists:", env_path.exists())
print("DEBUG OPENAI KEY LOADED:", bool(os.getenv("OPENAI_API_KEY")))
print("DEBUG LLM_PROVIDER:", os.getenv("LLM_PROVIDER"))


from fastapi import FastAPI, File, HTTPException, UploadFile, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.analysis.metrics import analyze_wav_file
from app.llm.coach import CoachRequest, CoachResponse, generate_coach_plan
from app.error_responses import raise_error, ensure_error_response
from app.coaching.rules import generate_rule_recommendations, RuleRecommendation

print("DEBUG OPENAI KEY LOADED:", bool(os.getenv("OPENAI_API_KEY")))
print("DEBUG LLM_PROVIDER:", os.getenv("LLM_PROVIDER"))

MAX_BYTES = 10 * 1024 * 1024  # 10MB
ALLOWED_ORIGINS = ["http://localhost:3000"]

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and detail.get("error_code"):
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error_code": "INTERNAL_ERROR",
            "user_message": str(detail) if detail else "Request failed",
            "how_to_fix": ["Please try again."],
        },
    )


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


class AnalyzeResponse(BaseModel):
    metrics: Dict[str, Any]
    rule_recommendations: List[RuleRecommendation] = []


async def save_upload_to_temp(upload: UploadFile, dest_path: str) -> int:
    size = 0
    with open(dest_path, "wb") as f:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise_error(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    "AUDIO_TOO_LONG",
                    "The uploaded file is too large (max 10MB).",
                    [
                        "Trim the recording to under 90 seconds.",
                        "Export at 44.1kHz mono WAV or a lower bitrate MP3.",
                    ],
                )
            f.write(chunk)
    return size


def convert_to_wav_44100_mono(src: str, dst: str) -> None:
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                src,
                "-ar",
                "44100",
                "-ac",
                "1",
                dst,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        raise_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Audio conversion tool (ffmpeg) is not installed on the server.",
            ["Install ffmpeg and retry the upload."],
        )

    if result.returncode != 0 or not os.path.exists(dst):
        raise_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "We couldn't convert your file to WAV for analysis.",
            [
                "Export the audio as WAV or MP3 and retry.",
                "Keep the sample rate at 44.1kHz mono if possible.",
            ],
        )


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(file: UploadFile = File(...)):
    if file is None:
        raise_error(
            status.HTTP_400_BAD_REQUEST,
            "ANALYSIS_FAILED",
            "No audio file was uploaded.",
            ["Select an audio file and try again."],
        )

    if not file.content_type or not file.content_type.startswith("audio/"):
        raise_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_FORMAT",
            "Please upload an audio file (WAV or MP3).",
            ["Export your recording to WAV or MP3 and try again."],
        )

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            raw_path = os.path.join(tmpdir, "input")
            wav_path = os.path.join(tmpdir, "converted.wav")

            await save_upload_to_temp(file, raw_path)

            convert_to_wav_44100_mono(raw_path, wav_path)

            metrics = analyze_wav_file(wav_path)
            recs = generate_rule_recommendations(metrics)
        return AnalyzeResponse(metrics=metrics, rule_recommendations=recs)
    except HTTPException as exc:
        # Ensure consistent error schema
        raise ensure_error_response(exc, fallback_code="ANALYSIS_FAILED")
    except Exception as exc:  # pragma: no cover - defensive
        raise_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Unexpected error while analyzing audio.",
            ["Please try again. If it continues, re-export the audio and retry."],
            details={"message": str(exc)},
        )


# POST /coach: generate a practice plan from metrics + skill/goal
@app.post("/coach", response_model=CoachResponse)
async def coach(request: CoachRequest):
    try:
        plan = await generate_coach_plan(request)
        return plan
    except HTTPException as exc:
        raise ensure_error_response(exc, fallback_code="INTERNAL_ERROR")
    except Exception as exc:  # pragma: no cover - defensive
        raise_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Unexpected error while generating your plan.",
            ["Retry in a moment.", "If it persists, rerun analysis and try again."],
            details={"message": str(exc)},
        )

# curl example (for manual testing):
# curl -X POST http://localhost:8000/coach \
#   -H "Content-Type: application/json" \
#   -d '{"metrics":{"tempo_bpm":120,"timing":{"average_offset_ms":-12,"timing_variance_ms":45,"rushed_notes_percent":18,"dragged_notes_percent":6},"dynamics":{"average_db":-18,"dynamic_range_db":12,"volume_consistency_score":0.72},"trends":{"timing_improving":false,"consistency_score":0.65}},"skill_level":"intermediate","goal":"timing","notes":"focus on steady eighth-notes"}'
