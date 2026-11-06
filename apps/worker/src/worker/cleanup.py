"""Retention sweep (T33) — delete user content 24 hours after the job was created.

Product promise: "Files are deleted after 24 hours." Each job carries expires_at
(created_at + 24h, migration 007) and this sweep — run every RETENTION_SWEEP_SECONDS
(default 15 min) from the consumer loop — is what actually enforces it:

  1. For every job past expires_at: delete its R2 objects (everything under `{job_id}/`:
     the uploaded source `_input.*` and all loop WAVs), THEN delete the DB row (loops +
     job_events cascade). R2 goes first so a failed R2 delete leaves the row in place and
     the next sweep retries; the reverse order would orphan the files forever.
     A job that is referenced by the append-only credit ledger (credit_consumption is
     ON DELETE RESTRICT, chord_edits has no cascade) CANNOT be deleted. It is ANONYMISED
     instead: every user-identifying / content column is blanked and the shell row is kept
     so the ledger keeps its FK target. See _anonymise_job.
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
from psycopg import errors as pg_errors

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
# Written to client_ip_hash / client_fingerprint of an anonymised job shell. Real values are
# hex digests so this cannot collide, and it is how the sweep recognises a shell it has already
# processed (otherwise the oldest ledger-bound jobs would be re-selected forever and, with the
# LIMIT, eventually starve every newer job). A purged_at column would be cleaner; this avoids a
# schema change.
PURGED_MARKER = "purged"


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


def _record_failure(job_id: str, event: str, exc: Exception) -> None:
    """Back off a job whose delete keeps failing so it cannot hog the batch."""
    n = _failed.get(job_id, (0, 0.0))[0] + 1
    _failed[job_id] = (n, time.monotonic() + _backoff_seconds(n))
    log_structured(
        "ERROR",
        event.replace("_failed", "_stuck") if n >= STUCK_AFTER_FAILURES else event,
        job_id=job_id,
        failures=n,
        error=str(exc)[:200],
    )


async def _anonymise_job(conn, job_id: str) -> None:
    """Strip user content from a job row that must outlive retention for ledger integrity.

    Blanked: source URL / video id / title, uploaded filename and R2 key, the hashed client
    ip + fingerprint, analysis results, and the loops rows (which only describe R2 objects that
    are already gone). Kept: id, status, timestamps, requested_stems, user_id, the Replicate
    prediction id and job_events (cost trace) — none of it is user content, and the ledger rows
    (credit_consumption, chord_edits) point at the id. The text columns use '' not NULL because
    jobs_input_source_chk requires youtube_url / upload_r2_key to be non-null for their kind.
    """
    await conn.execute("DELETE FROM loops WHERE job_id = %s", (job_id,))
    await conn.execute(
        "UPDATE jobs SET youtube_url = CASE WHEN input_kind = 'youtube' THEN '' ELSE NULL END, "
        "  upload_r2_key = CASE WHEN input_kind = 'upload' THEN '' ELSE NULL END, "
        "  original_filename = NULL, video_id = NULL, title = NULL, bpm = NULL, "
        "  musical_key = NULL, client_ip_hash = %s, client_fingerprint = %s "
        "WHERE id = %s",
        (PURGED_MARKER, PURGED_MARKER, job_id),
    )
    await conn.commit()


async def _sweep_expired_jobs(conn, deadline: float) -> tuple[int, int, int]:
    """Returns (swept, stuck, anonymised). Skips jobs in failure backoff; stops at the deadline."""
    now = time.monotonic()
    skip = [jid for jid, (_n, until) in _failed.items() if until > now]
    rows = await (
        await conn.execute(
            "SELECT id::text FROM jobs "
            "WHERE expires_at < now() "
            f"  AND (status IN ('done','failed') OR expires_at < now() - interval '{INFLIGHT_GRACE}') "
            "  AND client_ip_hash <> %s "
            "  AND NOT (id::text = ANY(%s)) "
            "ORDER BY expires_at LIMIT %s",
            (PURGED_MARKER, skip, MAX_JOBS_PER_SWEEP),
        )
    ).fetchall()
    swept = 0
    anonymised = 0
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
            _record_failure(job_id, "retention_r2_delete_failed", e)
            continue
        try:
            await conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
            await conn.commit()
            _failed.pop(job_id, None)
            swept += 1
            continue
        except pg_errors.ForeignKeyViolation:
            # Ledger rows reference this job (append-only by design): keep the shell.
            await conn.rollback()
        except Exception as e:  # noqa: BLE001 — one bad row must never abort the sweep
            await conn.rollback()
            _record_failure(job_id, "retention_db_delete_failed", e)
            continue
        try:
            await _anonymise_job(conn, job_id)
        except Exception as e:  # noqa: BLE001
            await conn.rollback()
            _record_failure(job_id, "retention_anonymise_failed", e)
            continue
        _failed.pop(job_id, None)
        anonymised += 1
        log_structured("INFO", "retention_job_anonymised", job_id=job_id)
    stuck = sum(1 for n, _ in _failed.values() if n >= STUCK_AFTER_FAILURES)
    return swept, stuck, anonymised


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
    """Enforce the retention window. Returns {'jobs','anonymised','orphan_objects','upload_events','stuck'}."""
    deadline = time.monotonic() + SWEEP_BUDGET_SECONDS
    # Leftover scratch dirs from a crashed job (user audio on local disk) age out too.
    await asyncio.to_thread(tmpdirs.sweep_stale)
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        jobs, stuck, anonymised = await _sweep_expired_jobs(conn, deadline)
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
        "anonymised": anonymised,
        "orphan_objects": orphans,
        "upload_events": len(upload_events),
        "stuck": stuck,
    }
    if any(result.values()):
        log_structured("INFO", "retention_swept", **result)
    return result
