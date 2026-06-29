"""Worker queue consumer (Gate 0 S2 decision: Python consumes via FOR UPDATE SKIP LOCKED).

pg-boss (Node/web layer) owns enqueue, retry and scheduling. The Python worker
claims jobs straight off the `jobs` table with `SELECT … FOR UPDATE SKIP LOCKED`,
so two stateless workers never grab the same job and one poison job can never block
the queue (it fails in isolation and the loop continues). No Redis, no sidecar.
"""

from __future__ import annotations

import asyncio
import os

import psycopg

from .errors import INTERNAL_ERROR, StemLoopsError
from .logger import log_structured
from .pipeline import run_pipeline

DATABASE_URL = os.environ.get("DATABASE_URL", "")
POLL_INTERVAL = 2  # seconds

_INTERNAL_USER_MSG = "Something went wrong on our end. We've logged it — please try again."


async def claim_and_run() -> bool:
    """Claim one queued job and run it. Returns True if a job was claimed."""
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        row = await (await conn.execute("""
                UPDATE jobs SET status='downloading', updated_at=now()
                WHERE id = (
                    SELECT id FROM jobs WHERE status='queued'
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id
                """)).fetchone()
        await conn.commit()
    if not row:
        return False

    job_id = str(row[0])
    log_structured("INFO", "job_claimed", job_id=job_id)
    try:
        await run_pipeline(job_id)
    except StemLoopsError as e:
        await mark_failed(job_id, e.error_code, e.user_message)
    except Exception as e:  # noqa: BLE001 — isolate the failure, never crash the loop
        log_structured("ERROR", "unhandled_exception", job_id=job_id, error=str(e)[:200])
        await mark_failed(job_id, INTERNAL_ERROR, _INTERNAL_USER_MSG)
    return True


async def mark_failed(job_id: str, error_code: str, message: str) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            """
            UPDATE jobs SET status='failed', error_code=%s, error_message_user=%s, updated_at=now()
            WHERE id=%s
            """,
            (error_code, message, job_id),
        )
        await conn.commit()
    log_structured("WARN", "job_failed", job_id=job_id, error_code=error_code)


async def poll_loop() -> None:
    """Continuously claim and run jobs; idle-sleep when the queue is empty."""
    log_structured("INFO", "consumer_started")
    while True:
        try:
            claimed = await claim_and_run()
        except Exception as e:  # noqa: BLE001 — DB blips must not kill the worker
            log_structured("ERROR", "consumer_loop_error", error=str(e)[:200])
            claimed = False
        if not claimed:
            await asyncio.sleep(POLL_INTERVAL)
