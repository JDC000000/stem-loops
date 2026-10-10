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
import time
import uuid
from datetime import UTC, datetime, timedelta

import psycopg

from . import tmpdirs
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
# Wall-clock budget per sweep pass: the sweep runs inline in the poll loop, so it must not
# starve job claiming while a big backlog drains. When it runs out it stops; the next pass
# (15 min) continues. A single job's delete is never interrupted midway.
SWEEP_BUDGET_SECONDS = float(os.environ.get("RETENTION_SWEEP_BUDGET_SECONDS", "60"))
# A job still processing (status not done/failed) is only swept once it is this far past
# expires_at — protects an in-flight job from a sibling worker's sweep.
INFLIGHT_GRACE = "1 hour"
# In-memory backoff for jobs whose R2 delete keeps failing, so one stuck job can't hog
# the batch: id -> (consecutive_failures, retry_not_before_monotonic).
_failed: dict[str, tuple[int, float]] = {}
STUCK_AFTER_FAILURES = 3
MAX_BACKOFF_SECONDS = 6 * 3600


def _job_id_of(key: str) -> str:
    return key.split("/", 1)[0].lower()


def _is_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except ValueError:
        return False


def _backoff_seconds(failures: int) -> float:
    return min(MAX_BACKOFF_SECONDS, 900 * (2 ** (failures - 1)))


async def _sweep_expired_jobs(conn, deadline: float) -> tuple[int, int]:
    """Returns (swept, stuck). Skips jobs in failure backoff; stops at the deadline."""
    now = time.monotonic()
    skip = [jid for jid, (_n, until) in _failed.items() if until > now]
    rows = await (
        await conn.execute(
            "SELECT id::text FROM jobs "
            "WHERE expires_at < now() "
            f"  AND (status IN ('done','failed') OR expires_at < now() - interval '{INFLIGHT_GRACE}') "
            "  AND NOT (id::text = ANY(%s)) "
            "ORDER BY expires_at LIMIT %s",
            (skip, MAX_JOBS_PER_SWEEP),
        )
    ).fetchall()
    swept = 0
    for (job_id,) in rows:
        if time.monotonic() >= deadline:
            log_structured(
                "INFO", "retention_budget_exhausted", phase="jobs", remaining=len(rows) - swept
            )
            break
        try:
            # R2 first; if this raises the DB row stays and a later sweep retries.
            await asyncio.to_thread(delete_prefix, f"{job_id}/")
        except Exception as e:  # noqa: BLE001 — one bad job must not block the rest
            n = _failed.get(job_id, (0, 0.0))[0] + 1
            _failed[job_id] = (n, time.monotonic() + _backoff_seconds(n))
            log_structured(
                "ERROR",
                (
                    "retention_r2_delete_stuck"
                    if n >= STUCK_AFTER_FAILURES
                    else "retention_r2_delete_failed"
                ),
                job_id=job_id,
                failures=n,
                error=str(e)[:200],
            )
            continue
        _failed.pop(job_id, None)
        await conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
        await conn.commit()
        swept += 1
    stuck = sum(1 for n, _ in _failed.values() if n >= STUCK_AFTER_FAILURES)
    return swept, stuck


async def _sweep_orphaned_objects(conn) -> int:
    """Delete R2 objects past the retention window that have no job row."""
    cutoff = datetime.now(UTC) - timedelta(seconds=RETENTION_SECONDS)
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
    """Enforce the retention window. Returns {'jobs','orphan_objects','upload_events','stuck'}."""
    deadline = time.monotonic() + SWEEP_BUDGET_SECONDS
    # Leftover scratch dirs from a crashed job (user audio on local disk) age out too.
    await asyncio.to_thread(tmpdirs.sweep_stale)
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        jobs, stuck = await _sweep_expired_jobs(conn, deadline)
        orphans = 0
        if time.monotonic() < deadline:
            try:
                orphans = await _sweep_orphaned_objects(conn)
            except Exception as e:  # noqa: BLE001 — orphan sweep is best-effort
                log_structured("ERROR", "retention_orphan_sweep_failed", error=str(e)[:200])
        upload_events = await (
            await conn.execute(
                "DELETE FROM upload_rate_events WHERE created_at < now() - (%s * interval '1 second') "
                "RETURNING id",
                (UPLOAD_EVENT_RETENTION_SECONDS,),
            )
        ).fetchall()
        await conn.commit()

    result = {
        "jobs": jobs,
        "orphan_objects": orphans,
        "upload_events": len(upload_events),
        "stuck": stuck,
    }
    if any(result.values()):
        log_structured("INFO", "retention_swept", **result)
    return result
