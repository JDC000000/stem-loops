"""Worker pipeline: orchestrates download -> separate -> extract -> upload.

Phase 1 STUB: walks the four stages, writing a started/completed job_event for
each, then marks the job done. No real audio yet — Phase 2 (T11-T17) swaps in the
real download (Cobalt + yt-dlp fallback), Replicate separation, librosa BPM/key,
S3 heuristic loop extraction, S5 seamless crossfade, and R2 upload.
"""

from __future__ import annotations

import asyncio
import os

import psycopg

from .logger import log_structured
from .stub_separation import stub_separate

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# pct anchors at each stage start (matches the web stage bands).
STAGE_START_PCT = {"downloading": 0, "separating": 15, "extracting": 70, "uploading": 90}
STAGES = ["downloading", "separating", "extracting", "uploading"]


async def emit_event(job_id: str, stage: str, phase: str, pct: int | None = None) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "INSERT INTO job_events(job_id, stage, phase, pct) VALUES(%s,%s,%s,%s)",
            (job_id, stage, phase, pct),
        )
        await conn.commit()


async def set_status(job_id: str, status: str) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "UPDATE jobs SET status=%s, updated_at=now() WHERE id=%s", (status, job_id)
        )
        await conn.commit()


async def run_pipeline(job_id: str) -> None:
    """Stub pipeline: fake separation -> stage trace -> done."""
    log_structured("INFO", "pipeline_start", job_id=job_id)
    for stage in STAGES:
        await set_status(job_id, stage)
        await emit_event(job_id, stage, "started", pct=STAGE_START_PCT[stage])
        if stage == "separating":
            # Exercise the stub separator so the path is wired end-to-end.
            stub_separate(job_id)
        await asyncio.sleep(0.1)
        await emit_event(job_id, stage, "completed", pct=100)

    await set_status(job_id, "done")
    log_structured("INFO", "pipeline_done", job_id=job_id)
