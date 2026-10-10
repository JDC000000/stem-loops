"""Retention sweep (T33) — delete user content 24 hours after the job was created.

Product promise: "Files are deleted after 24 hours." Each job carries expires_at
(created_at + 24h, migration 007) and this sweep — run every RETENTION_SWEEP_SECONDS
(default 15 min) from the consumer loop — is what actually enforces it:

  1. For every job past expires_at: delete its R2 objects (everything under `{job_id}/`:
     the uploaded source `_input.*` and all loop WAVs), THEN delete the DB row (loops +
     job_events cascade). R2 goes first so a failed R2 delete leaves the row in place and
     the next sweep retries; the reverse order would orphan the files forever.
  2. Orphan sweep: objects older than the retention window whose job row no longer exists
     (e.g. a presigned upload that never became a job) are deleted too.
  3. upload_rate_events are ephemeral per-IP rate markers (not user content); pruned on a
     short window.

The R2 bucket lifecycle rule (configure_r2_lifecycle.py, 2 days — R2 lifecycle is
day-granular) is only the belt-and-braces backstop if this sweep is down.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg

from .logger import log_structured
from .storage.r2_uploader import delete_objects, delete_prefix, list_objects_older_than

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# Job/file lifetime. DB expires_at defaults to the same 24h (migration 007); this value
# is only used to age out orphaned R2 objects that have no job row.
RETENTION_SECONDS = int(os.environ.get("JOB_RETENTION_SECONDS", "86400"))
# The per-IP upload rate markers are only needed for the 60s rate window; keep a day.
UPLOAD_EVENT_RETENTION_SECONDS = int(os.environ.get("UPLOAD_EVENT_RETENTION_SECONDS", "86400"))
# Cap work per sweep so a huge backlog (first run after the 7d->24h switch) can't
# monopolise the poll loop; the rest is picked up on the next sweep.
MAX_JOBS_PER_SWEEP = int(os.environ.get("RETENTION_MAX_JOBS_PER_SWEEP", "200"))
MAX_ORPHANS_PER_SWEEP = 2000


def _job_id_of(key: str) -> str:
    return key.split("/", 1)[0].lower()


def _is_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except ValueError:
        return False


async def _sweep_expired_jobs(conn) -> int:
    rows = await (
        await conn.execute(
            "SELECT id FROM jobs WHERE expires_at < now() ORDER BY expires_at LIMIT %s",
            (MAX_JOBS_PER_SWEEP,),
        )
    ).fetchall()
    swept = 0
    for (job_id,) in rows:
        try:
            # R2 first; if this raises the DB row stays and the next sweep retries.
            await asyncio.to_thread(delete_prefix, f"{job_id}/")
        except Exception as e:  # noqa: BLE001 — one bad job must not block the rest
            log_structured(
                "ERROR", "retention_r2_delete_failed", job_id=str(job_id), error=str(e)[:200]
            )
            continue
        await conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
        await conn.commit()
        swept += 1
    return swept


async def _sweep_orphaned_objects(conn) -> int:
    """Delete R2 objects past the retention window that have no job row."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=RETENTION_SECONDS)
    keys = await asyncio.to_thread(list_objects_older_than, cutoff, MAX_ORPHANS_PER_SWEEP)
    if not keys:
        return 0
    # Non-uuid prefixes would make the ::uuid cast throw; they can't have a job row anyway.
    candidates = sorted({p for p in (_job_id_of(k) for k in keys) if _is_uuid(p)})
    live: set[str] = set()
    if candidates:
        found = await (
            await conn.execute(
                "SELECT id::text FROM jobs WHERE id = ANY(%s::uuid[])", (candidates,)
            )
        ).fetchall()
        live = {r[0] for r in found}
    orphans = [k for k in keys if _job_id_of(k) not in live]
    if not orphans:
        return 0
    return await asyncio.to_thread(delete_objects, orphans)


async def sweep_expired() -> dict[str, int]:
    """Enforce the retention window. Returns {'jobs','orphan_objects','upload_events'}."""
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        jobs = await _sweep_expired_jobs(conn)
        try:
            orphans = await _sweep_orphaned_objects(conn)
        except Exception as e:  # noqa: BLE001 — orphan sweep is best-effort
            log_structured("ERROR", "retention_orphan_sweep_failed", error=str(e)[:200])
            orphans = 0
        upload_events = await (
            await conn.execute(
                "DELETE FROM upload_rate_events WHERE created_at < now() - (%s * interval '1 second') "
                "RETURNING id",
                (UPLOAD_EVENT_RETENTION_SECONDS,),
            )
        ).fetchall()
        await conn.commit()

    result = {"jobs": jobs, "orphan_objects": orphans, "upload_events": len(upload_events)}
    if any(result.values()):
        log_structured("INFO", "retention_swept", **result)
    return result
