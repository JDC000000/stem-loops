"""Retention sweep (T33) — delete user content when its retention ends.

Product promise (Jon, 2026-11-15): Free = deleted 24 hours after the job was created.
Pro and Studio = kept while the subscription is effective, plus 30 days' grace after it
stops being effective, then deleted the normal way. Each job carries expires_at
(created_at + 24h, migration 007); a job's REAL end of retention is RETAINED_UNTIL_SQL
below, which is expires_at pushed later by its owner's paid plan. This sweep — run every
RETENTION_SWEEP_SECONDS (default 15 min) from the consumer loop — is what enforces it:

  1. For every job past RETAINED_UNTIL_SQL: delete its R2 objects — EVERY prefix in
     `r2_uploader.job_object_prefixes(job_id)`, which is `{job_id}/` (the uploaded source
     `_input.*`, the stems and all loop WAVs) AND `jobs/{job_id}/` (the chord artifact).
     THEN delete the DB row (loops + job_events cascade). R2 goes first so a failed R2
     delete leaves the row in place and the next sweep retries; the reverse order would
     orphan the files forever.
     This used to delete `{job_id}/` alone, so `jobs/<job_id>/play.chords.json` escaped
     the per-job sweep on EVERY job and only died if the best-effort orphan sweep below
     happened to reach it. Chord data is derived from the user's audio and /privacy
     promises it goes with the rest at 24h, so that was a live retention leak.
     A job that is referenced by the append-only credit ledger (credit_consumption is
     ON DELETE RESTRICT, chord_edits has no cascade) CANNOT be deleted. It is ANONYMISED
     instead: every user-identifying / content column is blanked and the shell row is kept
     so the ledger keeps its FK target. See _anonymise_job.
  2. Orphan sweep: objects older than the retention window whose job row no longer exists
     (e.g. a presigned upload that never became a job) are deleted too.
  3. upload_rate_events are ephemeral per-IP rate markers (not user content); pruned on a
     short window.

The R2 bucket lifecycle rule (configure_r2_lifecycle.py) USED to be a whole-bucket 2-day
backstop. A whole-bucket age rule cannot coexist with paid retention (it would delete a
subscriber's library on day 2 while the job row says "kept"), so that script no longer sets
an expiration by default; this sweep is the retention mechanism. See that script.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import time
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import sentry_sdk
from psycopg import errors as pg_errors
from psycopg.conninfo import conninfo_to_dict

from . import tmpdirs
from .logger import log_structured
from .storage.r2_uploader import (
    CHORDS_TOP_PREFIX,
    delete_objects,
    delete_prefix,
    job_object_prefixes,
    list_objects_older_than,
)

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
# Old keys fetched per listing call in the orphan sweep; it pages on past the ones it keeps.
ORPHAN_LIST_BATCH = 1000
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
# ---------------------------------------------------------------------------------------
# Paid-plan retention (Jon, 2026-11-15): "Pro and Studio = kept WHILE SUBSCRIBED, plus 30
# days' grace after the subscription ends. Users build a LIBRARY of songs."
#
# MECHANISM: computed at READ time from the subscriptions table, never written onto jobs.
# Nothing has to fire for it to be right: no webhook has to extend expires_at, no backfill
# has to run, a comp subscription inserted by hand works the moment it exists, and a
# downgrade takes effect on the next sweep / request without a write. The web routes use
# the SAME expression (apps/web/src/lib/retention.ts, JOB_RETAINED_UNTIL_SQL; pinned
# identical by tests/test_paid_retention.py), so "kept" means the same thing to the
# sweep that deletes and the routes that serve.
#
# A job's retention ends at GREATEST(expires_at, paid_until + 30 days) where paid_until is
# the latest moment any of the owner's Pro/Studio subscriptions was (or will be) effective,
# with the same semantics as effectivePlanCode() in apps/web/src/lib/billing/entitlements.ts:
#   active / trialing   -> current_period_end
#   past_due            -> current_period_start + 7 days   (PAST_DUE_GRACE_MS)
#   canceled / paused   -> LEAST(current_period_end, updated_at): when it stopped. The
#                          webhook stamps updated_at when it records the cancel. A later
#                          touch of the row bumps updated_at and CAN extend this, but only
#                          up to current_period_end (bounded, never forever).
#   incomplete          -> never paid, never retains.
# and it applies only when
#   * the job has an owner (anonymous jobs are always 24 h),
#   * the job was created while (or before) that plan was effective — a job made AFTER the
#     plan ended is a Free job and gets Free's exact 24 h,
#   * the job was STARTED under its owner's account: its expires_at is still the untouched
#     INSERT default, exactly created_at + 24 h (both defaults read one now()). Account
#     deletion sets expires_at = created_at and claim-jobs adds 1 microsecond, so a killed
#     job and a job started WITHOUT an account (later claimed) both stay on the 24 h clock,
#   * the job is not an anonymised shell (its content is already gone).
# Every term is a finite timestamp, so every job is eventually deleted.
#
# DEMO SONGS (V3 Slice 0, migration 040): a row with jobs.is_demo is retained until
# DEMO_RETAINED_UNTIL whatever its expires_at or owner's plan, so this sweep never selects
# it. FINITE on purpose, not 'infinity' (node-pg would hand the web Infinity -> NaN, and the
# stems/download routes fail closed to 1-second signed URLs on NaN). Only an operator sets
# is_demo; no application code writes it.
# ---------------------------------------------------------------------------------------
PAID_RETENTION_GRACE = "30 days"
# = PAST_DUE_GRACE_MS (7 days) in apps/web/src/lib/billing/entitlements.ts.
PAST_DUE_GRACE = "7 days"
# = DEMO_RETAINED_UNTIL in apps/web/src/lib/retention.ts.
DEMO_RETAINED_UNTIL = "2099-12-31T00:00:00Z"
RETAINED_UNTIL_SQL = (
    f"(CASE WHEN jobs.is_demo THEN '{DEMO_RETAINED_UNTIL}'::timestamptz ELSE "
    "GREATEST(jobs.expires_at, ("
    f"SELECT MAX(p.paid_until) + interval '{PAID_RETENTION_GRACE}' FROM ("
    "SELECT CASE"
    " WHEN s.status IN ('active','trialing') THEN s.current_period_end"
    f" WHEN s.status = 'past_due' THEN s.current_period_start + interval '{PAST_DUE_GRACE}'"
    " WHEN s.status IN ('canceled','paused') THEN LEAST(s.current_period_end, s.updated_at)"
    " END AS paid_until"
    " FROM public.subscriptions s"
    " WHERE s.user_id = jobs.user_id AND s.plan_code IN ('pro','studio')"
    ") p"
    " WHERE p.paid_until >= jobs.created_at"
    " AND jobs.expires_at = jobs.created_at + interval '24 hours'"
    " AND jobs.client_ip_hash <> 'purged'"
    ")) END)"
)
# Written to client_ip_hash / client_fingerprint of an anonymised job shell. Real values are
# hex digests so this cannot collide, and it is how the sweep recognises a shell it has already
# processed (otherwise the oldest ledger-bound jobs would be re-selected forever and, with the
# LIMIT, eventually starve every newer job). A purged_at column would be cleaner; this avoids a
# schema change.
PURGED_MARKER = "purged"

# ---------------------------------------------------------------------------------------
# Orphan-sweep safety (QA-57 / QA-59, 2026-11-18).
#
# THE INCIDENT. Every job older than ~24 h lost its WHOLE R2 footprint (`<id>/` and
# `jobs/<id>/`), including demo songs and paid libraries the DB retains until 2027, while
# the bucket had no lifecycle rule. The orphan pass below deletes every aged object whose
# job id the database does not list as live. Pointed at the RIGHT bucket and the WRONG
# database (an old staging stack holding the production R2 keys, a restored or empty DB),
# that is "delete everything older than a day", and nothing in the code could tell.
#
# TWO BRAKES, both in this file so they bind every caller of `_sweep_orphaned_objects`:
#
#   1. BINDING (refuse to run at all). The pass runs only when ORPHAN_SWEEP_BINDING equals
#      `orphan_sweep_binding()`: a short sha256 of the bucket name and the database
#      identity this process actually connects to (user, host, port, dbname of
#      DATABASE_URL; never the password). Unset -> the pass is skipped with a WARN that
#      prints the value to set. Set but different -> skipped with an ERROR + Sentry event:
#      that is the signature of a deployment whose bucket and database do not belong
#      together (a stack that copied the env and swapped DATABASE_URL), or of a changed
#      DATABASE_URL the operator must re-bind on purpose.
#      Why an env value and not a table row: no migration, nothing to seed in CI, and it is
#      checked against what this process really connects to rather than against data a
#      wrong database could also contain. Why a hash: it binds user + host + port + dbname
#      (a Supabase pooler host is shared between projects; the user carries the project
#      ref) without putting a connection string in an env var or a log line.
#
#   2. EVIDENCE (abort mid-pass). An object under a prefix the database has NEVER HEARD OF
#      (no row at all, not even an anonymised shell) whose keys show the job was PROCESSED
#      (anything under `<id>/` other than the uploaded `_input.*`, or a `jobs/<id>/` chord
#      file) should not exist: the per-job sweep deletes R2 BEFORE the row, and a failed R2
#      delete keeps the row. Abandoned presigned uploads (`<id>/_input.*` only) are the
#      normal orphans and are not counted. More than MAX_UNKNOWN_PROCESSED_JOBS such ids in
#      one pass aborts the pass BEFORE the batch that crossed it is deleted, with an ERROR +
#      Sentry event. This is what an empty or wrong database looks like from inside, even
#      when the binding was copied along with it.
#      Not "the live query returned none of the candidates": the incident database was
#      EMPTY, which that rule (conditioned on retained rows existing) would not catch, and
#      a batch of only abandoned uploads legitimately has no live candidates.
#
# NEITHER BRAKE STOPS CODE THAT DOES NOT HAVE IT. A deployment running an older build
# keeps deleting. The fix for that is operational: find it and rotate the R2 keys.
# ---------------------------------------------------------------------------------------
ORPHAN_SWEEP_BINDING_ENV = "ORPHAN_SWEEP_BINDING"
MAX_UNKNOWN_PROCESSED_JOBS = int(os.environ.get("ORPHAN_SWEEP_MAX_UNKNOWN_PROCESSED_JOBS", "5"))
ORPHAN_BRAKE_FINGERPRINT = ["retention", "orphan-sweep-brake"]
_binding_warned = False


def orphan_sweep_binding(database_url: str | None = None, bucket: str | None = None) -> str:
    """The value ORPHAN_SWEEP_BINDING must hold for this process's bucket + database.

    Pure apart from reading the defaults (`DATABASE_URL` here, `R2_BUCKET_NAME` env).
    The password is never part of it, so rotating it does not unbind the sweep.
    """
    url = DATABASE_URL if database_url is None else database_url
    name = os.environ.get("R2_BUCKET_NAME", "") if bucket is None else bucket
    try:
        info = conninfo_to_dict(url) if url else {}
    except Exception:  # noqa: BLE001 — an unparseable URL binds to nothing in particular
        info = {}
    parts = [name] + [str(info.get(k) or "") for k in ("user", "host", "port", "dbname")]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def _orphan_sweep_refused() -> str | None:
    """None when the orphan pass may run; otherwise why it may not (and say so, loudly)."""
    global _binding_warned
    expected = orphan_sweep_binding()
    configured = os.environ.get(ORPHAN_SWEEP_BINDING_ENV, "").strip()
    if configured == expected:
        return None
    if not configured:
        if not _binding_warned:
            _binding_warned = True
            log_structured(
                "WARN",
                "retention_orphan_sweep_unbound",
                action=f"set {ORPHAN_SWEEP_BINDING_ENV}={expected} on the deployment whose "
                "database owns this bucket; until then aged orphans are not deleted",
            )
        return "unbound"
    log_structured(
        "ERROR",
        "retention_orphan_sweep_binding_mismatch",
        expected_here=expected,
        action="this process's bucket + database are not the pair the binding names; "
        "the orphan pass is refused. If DATABASE_URL changed on purpose, re-bind.",
    )
    with contextlib.suppress(Exception):  # telemetry is never load-bearing
        sentry_sdk.capture_message(
            "Orphan sweep refused: R2 bucket / database binding mismatch "
            f"(expected here {expected})",
            level="error",
            fingerprint=["retention", "orphan-sweep-binding-mismatch"],
        )
    return "mismatch"


def _is_processed_key(key: str) -> bool:
    """True when `key` is something only a PROCESSED job has (not an uploaded `_input.*`)."""
    k = key.lower()
    if k.startswith(CHORDS_TOP_PREFIX):
        return True
    rest = k.split("/", 1)[1] if "/" in k else ""
    return not rest.startswith("_input")


def _brake_orphan_sweep(unknown_processed: int, batch_keys: int, deleted: int) -> None:
    log_structured(
        "ERROR",
        "retention_orphan_sweep_braked",
        unknown_processed_jobs=unknown_processed,
        limit=MAX_UNKNOWN_PROCESSED_JOBS,
        batch_keys=batch_keys,
        deleted_before_brake=deleted,
        action="aged objects of processed jobs the database has never heard of: this "
        "database may not be the one that owns this bucket. Nothing more was deleted.",
    )
    with contextlib.suppress(Exception):  # telemetry is never load-bearing
        sentry_sdk.capture_message(
            "Orphan sweep braked: "
            f"{unknown_processed} processed jobs in R2 are unknown to the database "
            f"(limit {MAX_UNKNOWN_PROCESSED_JOBS}); pass aborted",
            level="error",
            fingerprint=ORPHAN_BRAKE_FINGERPRINT,
        )


def _job_id_of(key: str) -> str:
    """The job id an R2 key belongs to, or "" if it names no job.

    Keys have TWO top-level shapes — `<job_id>/...` for everything the pipeline writes,
    and `jobs/<job_id>/...` (r2_uploader.CHORDS_TOP_PREFIX) for the chord artifact — so
    the first path segment is NOT always the job id.

    Reading it blindly returned the literal "jobs" for every chord key. That is not a
    uuid, so `_sweep_orphaned_objects` could never match a chord file to its job row and
    classified it as an orphan EVEN WHILE THE JOB WAS ALIVE — the dangerous direction.
    A job past expires_at but still processing is held back by INFLIGHT_GRACE (1 hour),
    and one in failure backoff for up to MAX_BACKOFF_SECONDS (6 hours), yet its chord
    file became orphan-eligible the moment it aged past RETENTION_SECONDS. So the chord
    file could be deleted while the job row was still being retained.

    That is NOT user-visible with default settings: an object is orphan-eligible only
    once older than RETENTION_SECONDS (24h) and expires_at = created_at + 24h, while the
    web's play-chords route serves only `expires_at > now()`, so the overlay could never
    have been handed that file. The one reader that does run after expiry is
    `_existing_play_chords` on a reaper requeue of a still-held job; an early delete there
    costs one chord regeneration (and possibly one billed Klangio request), not a user-visible
    loss.
    """
    k = key.lower()
    if k.startswith(CHORDS_TOP_PREFIX):
        k = k[len(CHORDS_TOP_PREFIX) :]
    return k.split("/", 1)[0]


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
            # expires_at < now() is the cheap index-backed prefilter; RETAINED_UNTIL_SQL is the
            # rule. A paid owner's job is past its 24 h expires_at and still retained.
            "SELECT id::text FROM jobs "
            "WHERE expires_at < now() "
            f"  AND {RETAINED_UNTIL_SQL} < now() "
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
            # R2 first; if ANY prefix raises the DB row stays and a later sweep retries
            # the whole footprint. Partial progress is safe — delete_prefix is idempotent.
            for prefix in job_object_prefixes(job_id):
                await asyncio.to_thread(delete_prefix, prefix)
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


async def _sweep_orphaned_objects(conn, deadline: float | None = None) -> int:
    """Delete R2 objects past the retention window that belong to no LIVE job.

    "Live" means a job row that is not an anonymised shell: a shell's content was already
    deleted and the row only outlives retention to anchor the credit ledger, so an aged
    object still under its prefix is garbage. Shells are excluded from _sweep_expired_jobs
    and never re-swept, so if this pass treated them as live those objects would be kept
    for ever.

    Best-effort and capped at MAX_ORPHANS_PER_SWEEP DELETIONS. It is the BACKSTOP, not the
    retention mechanism — anything a job owns must be deleted by _sweep_expired_jobs, whose
    prefix list (job_object_prefixes) is what makes that true.

    PAGES PAST WHAT IT KEEPS (QA track B, B-05). It used to list the first
    MAX_ORPHANS_PER_SWEEP old keys in lexical order and stop. Old objects of LIVE jobs (paid
    libraries, the 2099 demos) are kept, so once more of them than the cap sorted first, every
    sweep re-listed the same kept keys and never reached a real orphan later in the keyspace.
    Now it lists in batches of ORPHAN_LIST_BATCH from the last key it saw, so a kept key is
    looked at once per sweep and the scan moves on, until the listing ends, the deletion cap
    is reached, or the sweep's deadline passes.
    """
    if _orphan_sweep_refused():
        return 0
    if deadline is None:
        deadline = time.monotonic() + SWEEP_BUDGET_SECONDS
    unknown_processed: set[str] = set()
    cutoff = datetime.now(UTC) - timedelta(seconds=RETENTION_SECONDS)
    deleted = 0
    start_after = ""
    while deleted < MAX_ORPHANS_PER_SWEEP and time.monotonic() < deadline:
        keys = await asyncio.to_thread(
            list_objects_older_than, cutoff, ORPHAN_LIST_BATCH, start_after
        )
        if not keys:
            break
        # Non-uuid prefixes would make the ::uuid cast throw; they can't have a job row anyway.
        candidates = sorted({p for p in (_job_id_of(k) for k in keys) if _is_uuid(p)})
        live: set[str] = set()
        if candidates:
            found = await (
                await conn.execute(
                    # A purged shell (see _anonymise_job) is NOT live for this purpose. Its
                    # content was deleted and the row survives only to anchor the credit
                    # ledger, so anything still under its prefix is garbage the retention
                    # promise already covers. Counting it as live would keep those objects
                    # FOREVER — which is exactly what fixing _job_id_of would otherwise do to
                    # the chord file of every ledger-bound job purged before that fix, since
                    # those shells are excluded from _sweep_expired_jobs and never re-swept.
                    "SELECT id::text FROM jobs WHERE id = ANY(%s::uuid[]) "
                    "  AND client_ip_hash <> %s",
                    (candidates, PURGED_MARKER),
                )
            ).fetchall()
            live = {r[0] for r in found}
            # Brake 2: ids with NO row at all (a shell is known, merely not live).
            known = await (
                await conn.execute(
                    "SELECT id::text FROM jobs WHERE id = ANY(%s::uuid[])", (candidates,)
                )
            ).fetchall()
            unknown = set(candidates) - {r[0] for r in known}
            unknown_processed |= {
                j for j in (_job_id_of(k) for k in keys if _is_processed_key(k)) if j in unknown
            }
            if len(unknown_processed) > MAX_UNKNOWN_PROCESSED_JOBS:
                _brake_orphan_sweep(len(unknown_processed), len(keys), deleted)
                return deleted
        orphans = [k for k in keys if _job_id_of(k) not in live]
        orphans = orphans[: MAX_ORPHANS_PER_SWEEP - deleted]
        if orphans:
            deleted += await asyncio.to_thread(delete_objects, orphans)
        if len(keys) < ORPHAN_LIST_BATCH:
            break  # the listing reached the end of the bucket
        start_after = keys[-1]
    return deleted


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
                orphans = await _sweep_orphaned_objects(conn, deadline)
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
