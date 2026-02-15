import os
import subprocess
import tempfile
from typing import Dict

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from app.analysis.metrics import analyze_wav_file
from app.llm.coach import CoachRequest, CoachResponse, generate_coach_plan

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


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


async def save_upload_to_temp(upload: UploadFile, dest_path: str) -> int:
    size = 0
    with open(dest_path, "wb") as f:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="File too large (max 10MB).",
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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="ffmpeg not installed",
        )

    if result.returncode != 0 or not os.path.exists(dst):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="ffmpeg failed to convert audio",
        )


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if file is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing file upload.",
        )

    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid content type. Please upload an audio file.",
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        raw_path = os.path.join(tmpdir, "input")
        wav_path = os.path.join(tmpdir, "converted.wav")

        await save_upload_to_temp(file, raw_path)

        convert_to_wav_44100_mono(raw_path, wav_path)

        metrics = analyze_wav_file(wav_path)

    return metrics


# POST /coach: generate a practice plan from metrics + skill/goal
@app.post("/coach", response_model=CoachResponse)
async def coach(request: CoachRequest):
    plan = await generate_coach_plan(request)
    return plan

# curl example (for manual testing):
# curl -X POST http://localhost:8000/coach \
#   -H "Content-Type: application/json" \
#   -d '{"metrics":{"tempo_bpm":120,"timing":{"average_offset_ms":-12,"timing_variance_ms":45,"rushed_notes_percent":18,"dragged_notes_percent":6},"dynamics":{"average_db":-18,"dynamic_range_db":12,"volume_consistency_score":0.72},"trends":{"timing_improving":false,"consistency_score":0.65}},"skill_level":"intermediate","goal":"timing","notes":"focus on steady eighth-notes"}'
