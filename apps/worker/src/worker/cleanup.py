"""Retention sweep (T33) — delete user content past its 7-day TTL.

PRD §6.1 / anti-goal: no user content retained beyond 7 days. R2 objects are reaped by
an 8-day bucket lifecycle rule (configure_r2_lifecycle.py); this closes the Postgres
side, which nothing was deleting (security review #5). Each job carries expires_at
(now() + 7 days) and its loops + job_events cascade-delete from it (ON DELETE CASCADE),
so a single DELETE clears the job's whole footprint. upload_rate_events are ephemeral
per-IP rate markers (no expires_at, not user content) and are pruned on a short window.
"""

from __future__ import annotations

import os

import psycopg

from .logger import log_structured

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# The per-IP upload rate markers are only needed for the 60s rate window; keep a day.
UPLOAD_EVENT_RETENTION_SECONDS = int(os.environ.get("UPLOAD_EVENT_RETENTION_SECONDS", "86400"))


async def sweep_expired() -> dict[str, int]:
    """Delete jobs past expires_at (cascades loops + job_events) and old upload rate
    markers. Returns {'jobs','upload_events'} deleted counts."""
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        jobs = await (await conn.execute(
            "DELETE FROM jobs WHERE expires_at < now() RETURNING id"
        )).fetchall()
        upload_events = await (await conn.execute(
            "DELETE FROM upload_rate_events WHERE created_at < now() - (%s * interval '1 second') "
            "RETURNING id",
            (UPLOAD_EVENT_RETENTION_SECONDS,),
        )).fetchall()
        await conn.commit()

    result = {"jobs": len(jobs), "upload_events": len(upload_events)}
    if result["jobs"] or result["upload_events"]:
        log_structured("INFO", "retention_swept", **result)
    return result
