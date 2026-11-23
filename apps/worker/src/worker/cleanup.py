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

The orphan pass (2) has two safety brakes (QA-57 / QA-59; see the block above
ORPHAN_SWEEP_BINDING_ENV): it runs only when ORPHAN_SWEEP_BINDING binds this bucket to this
database, and it LATCHES ITSELF OFF for the life of the process once more than
ORPHAN_SWEEP_MAX_UNKNOWN_PROCESSED_JOBS processed jobs the database has never heard of turn
up (counted over the whole process, not per pass). The trip logs
`retention_orphan_sweep_braked` at ERROR and sends one Sentry error, once.

RECOVERY when it trips: INVESTIGATE FIRST, THEN RESTART. A restart clears the latch and the
count, so restarting a worker that still faces the wrong database lets it delete up to the
limit again before it re-trips. Check that DATABASE_URL is the database that owns the bucket
(not a restore, a truncated copy or another stack's), and whether job rows were deleted by
hand without their R2 objects. Fix the cause (correct DATABASE_URL, or unset
ORPHAN_SWEEP_BINDING to keep the pass off, or clear the stray prefixes by hand), and only then
restart the worker. The per-job retention sweep (1) is never latched off.

Operator command: `python -m src.worker.cleanup --print-binding` (in the worker container:
`fly ssh console -a stem-loops -C "sh -c 'cd /app && python -m src.worker.cleanup
--print-binding'"`) prints the value ORPHAN_SWEEP_BINDING must hold on THAT machine.

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
import sys
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
#      DATABASE_URL; never the password). Unset -> the pass is skipped with one WARN + one
#      Sentry warning per process (neither carries the value: the operator prints it on
#      the right machine with `python -m src.worker.cleanup --print-binding`, see
#      _main). Set but different -> skipped with an ERROR + Sentry event:
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
#      THE EVIDENCE BRAKE LATCHES (PR #306 revision 2). The count of unknown processed
#      job ids is kept for the LIFE OF THE PROCESS, not per pass, and once it goes over the
#      limit the orphan pass stays OFF until the process restarts: one ERROR + one Sentry
#      event at the trip, then nothing more is deleted by this pass in any later sweep.
#      A per-pass count was a slow drain: each 15-minute pass restarted at zero, deleted
#      up to the limit of unknown jobs that sorted before the trip, and braked; the next
#      pass found the NEXT few. With a sparse wrong database (same identity, restored from
#      an old backup, partly truncated) that is ~480 jobs a day of exactly the libraries
#      this exists to protect. The per-job retention sweep is never latched off.
#
# RECOVERY AFTER THE EVIDENCE BRAKE TRIPS (`retention_orphan_sweep_braked`, Sentry
# fingerprint ORPHAN_BRAKE_FINGERPRINT). Do NOT just restart: a restart clears the latch and
# the count, so the next pass may delete up to the limit again before it re-trips.
#   1. Investigate first. Is DATABASE_URL the database that owns this bucket? Is it a fresh
#      restore or a truncated copy? Did someone `DELETE FROM jobs` by hand? Compare the
#      Sentry/ERROR count with `SELECT count(*) FROM jobs` and the bucket's prefixes.
#   2. If the database is wrong: fix DATABASE_URL (the binding brake will then refuse the
#      pass until it is re-bound) or unset ORPHAN_SWEEP_BINDING, THEN restart.
#   3. If the unknown jobs really are garbage (rows deleted by hand without their R2
#      objects): delete those prefixes by hand, or raise
#      ORPHAN_SWEEP_MAX_UNKNOWN_PROCESSED_JOBS for one deploy, then restart.
#
# NEITHER BRAKE STOPS CODE THAT DOES NOT HAVE IT. A deployment running an older build
# keeps deleting. The fix for that is operational: find it and rotate the R2 keys.
# ---------------------------------------------------------------------------------------
ORPHAN_SWEEP_BINDING_ENV = "ORPHAN_SWEEP_BINDING"
MAX_UNKNOWN_PROCESSED_JOBS = int(os.environ.get("ORPHAN_SWEEP_MAX_UNKNOWN_PROCESSED_JOBS", "5"))
ORPHAN_BRAKE_FINGERPRINT = ["retention", "orphan-sweep-brake"]
_binding_warned = False
# Process-lifetime state of the evidence brake (see "THE EVIDENCE BRAKE LATCHES" above).
_unknown_processed_seen: set[str] = set()
_orphan_brake_tripped = False


def _reset_orphan_brake() -> None:
    """Clear the process-lifetime brake state and the one-time warnings. Tests only:
    in production only a restart clears it, after the investigation the module docstring
    describes."""
    global _orphan_brake_tripped, _binding_warned, _unbound_reported
    _unknown_processed_seen.clear()
    _orphan_brake_tripped = False
    _binding_warned = False
    _unbound_reported = False


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
    if _orphan_brake_tripped:
        # Latched off by the evidence brake for the life of this process. The ERROR and
        # the Sentry event were sent once, at the trip; this line is only for the log trail.
        log_structured("INFO", "retention_orphan_sweep_latched_off")
        return "braked"
    expected = orphan_sweep_binding()
    configured = os.environ.get(ORPHAN_SWEEP_BINDING_ENV, "").strip()
    if configured == expected:
        return None
    if not configured:
        if not _binding_warned:
            _binding_warned = True
            # The value itself is NOT printed (PR #306 review, L-2): on a foreign stack that
            # line would tell its operator how to arm the pass against this bucket. The
            # operator reads it on purpose, on the right machine, with --print-binding.
            log_structured(
                "WARN",
                "retention_orphan_sweep_unbound",
                action=f"{ORPHAN_SWEEP_BINDING_ENV} is not set, so aged orphans are not "
                "deleted. On the deployment whose database owns this bucket ONLY, read the "
                "value with `python -m src.worker.cleanup --print-binding` (in /app) and set it.",
            )
            _report_unbound_once()
        return "unbound"
    # Neither line carries the expected value: a stack that copied the env and swapped
    # DATABASE_URL lands HERE, and printing its own value would tell it how to re-arm.
    log_structured(
        "ERROR",
        "retention_orphan_sweep_binding_mismatch",
        action="this process's bucket + database are not the pair the binding names; "
        "the orphan pass is refused. If DATABASE_URL changed on purpose, re-bind "
        "(python -m src.worker.cleanup --print-binding on THIS machine).",
    )
    with contextlib.suppress(Exception):  # telemetry is never load-bearing
        sentry_sdk.capture_message(
            "Orphan sweep refused: R2 bucket / database binding mismatch",
            level="error",
            fingerprint=["retention", "orphan-sweep-binding-mismatch"],
        )
    return "mismatch"


_unbound_reported = False


def _report_unbound_once() -> None:
    """One Sentry WARNING per process while the pass is unbound (PR #306 review, M-1).

    Unbound, the backstop for abandoned uploads (user audio under `<id>/_input.*`) is off
    and the Free 24 h promise for those objects is not kept. A WARN line alone is easy to
    miss, so every process start that finds it unbound also raises one Sentry warning under
    a fixed fingerprint (one issue whose counter grows per deploy/restart, not per pass).
    No binding value in it.
    """
    global _unbound_reported
    if _unbound_reported:
        return
    _unbound_reported = True
    with contextlib.suppress(Exception):  # telemetry is never load-bearing
        sentry_sdk.capture_message(
            f"Orphan sweep unbound: {ORPHAN_SWEEP_BINDING_ENV} is not set, so aged "
            "abandoned uploads are not deleted",
            level="warning",
            fingerprint=["retention", "orphan-sweep-unbound"],
        )


def _is_processed_key(key: str) -> bool:
    """True when `key` is something only a PROCESSED job has (not an uploaded `_input.*`)."""
    k = key.lower()
    if k.startswith(CHORDS_TOP_PREFIX):
        return True
    rest = k.split("/", 1)[1] if "/" in k else ""
    return not rest.startswith("_input")


def _brake_orphan_sweep(unknown_processed: int, batch_keys: int, deleted: int) -> None:
    """Trip the evidence brake: latch the orphan pass off for the life of this process and
    say so ONCE (ERROR + Sentry). Later passes are refused by _orphan_sweep_refused."""
    global _orphan_brake_tripped
    if _orphan_brake_tripped:
        return
    _orphan_brake_tripped = True
    log_structured(
        "ERROR",
        "retention_orphan_sweep_braked",
        unknown_processed_jobs=unknown_processed,
        limit=MAX_UNKNOWN_PROCESSED_JOBS,
        batch_keys=batch_keys,
        deleted_this_pass=deleted,
        action="aged objects of processed jobs the database has never heard of: this "
        "database may not be the one that owns this bucket. The batch that crossed the limit "
        "was not deleted, and the orphan pass is now OFF until this process restarts. Up to "
        "the limit of such jobs may already have been deleted by this process before the "
        "trip. Investigate BEFORE restarting (cleanup.py, 'RECOVERY').",
    )
    with contextlib.suppress(Exception):  # telemetry is never load-bearing
        sentry_sdk.capture_message(
            "Orphan sweep braked: "
            f"{unknown_processed} processed jobs in R2 are unknown to the database "
            f"(limit {MAX_UNKNOWN_PROCESSED_JOBS}); orphan pass off until restart",
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

    Does NOT commit: the caller owns the transaction (see _sweep_expired_jobs).
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
    # NO commit here (Phase B, B1): the sweep runs this inside the job's one transaction,
    # after ROLLBACK TO SAVEPOINT before_delete, so the library snapshot taken before the
    # failed DELETE commits together with the shell. The caller commits.


# ---------------------------------------------------------------------------------------
# Song library (Phase B, B1; migration 043). When the sweep removes a signed-in user's song
# it keeps a METADATA row (link or file name, title, video id, BPM, key; no job_id) so the
# library still lists it as "Audio expired" with a Re-make. Written in the job's own sweep
# transaction BEFORE the DELETE (reading the row it is about to delete), so the entry and the
# delete/anonymise commit or roll back together.
#
# Only for a job that is: owned (user_id set), `done`, not a demo, not already an anonymised
# shell, and whose owner is NOT tombstoned (account deletion in progress: the entry would
# outlive the account's promise). A link entry is UPSERTed on (user_id, youtube_url), so a
# re-made song refreshes the one row instead of adding a second.
# ---------------------------------------------------------------------------------------
LIBRARY_SNAPSHOT_SQL = (
    "INSERT INTO library_entries AS e (user_id, input_kind, youtube_url, original_filename, "
    "  title, video_id, bpm, musical_key, first_created_at, updated_at) "
    "SELECT jobs.user_id, jobs.input_kind, "
    "  CASE WHEN jobs.input_kind = 'youtube' THEN jobs.youtube_url END, "
    "  CASE WHEN jobs.input_kind = 'upload' THEN jobs.original_filename END, "
    "  jobs.title, jobs.video_id, jobs.bpm, jobs.musical_key, jobs.created_at, now() "
    "FROM jobs "
    "WHERE jobs.id = %s "
    "  AND jobs.user_id IS NOT NULL "
    "  AND jobs.status = 'done' "
    "  AND jobs.is_demo = false "
    "  AND jobs.client_ip_hash <> %s "
    "  AND EXISTS (SELECT 1 FROM users u WHERE u.id = jobs.user_id AND u.deleted_at IS NULL) "
    "ON CONFLICT (user_id, youtube_url) WHERE youtube_url IS NOT NULL DO UPDATE SET "
    "  title = COALESCE(EXCLUDED.title, e.title), "
    "  video_id = COALESCE(EXCLUDED.video_id, e.video_id), "
    "  bpm = COALESCE(EXCLUDED.bpm, e.bpm), "
    "  musical_key = COALESCE(EXCLUDED.musical_key, e.musical_key), "
    "  first_created_at = LEAST(e.first_created_at, EXCLUDED.first_created_at), "
    "  updated_at = now()"
)
_library_unmigrated_reported = False


async def _snapshot_library_entry(conn, job_id: str) -> int:
    """UPSERT the job's library entry inside the caller's transaction. Returns rows written
    (0 or 1). Runs in its own SAVEPOINT so a database without migration 043 (42P01,
    UndefinedTable) is tolerated: the savepoint is rolled back and the job is swept exactly as
    before. Any other error propagates and the caller rolls the whole job back."""
    global _library_unmigrated_reported
    await conn.execute("SAVEPOINT library_snapshot")
    try:
        cur = await conn.execute(LIBRARY_SNAPSHOT_SQL, (job_id, PURGED_MARKER))
    except pg_errors.UndefinedTable:
        await conn.execute("ROLLBACK TO SAVEPOINT library_snapshot")
        if not _library_unmigrated_reported:
            _library_unmigrated_reported = True
            log_structured(
                "WARN",
                "library_entries_unmigrated",
                action="migration 043 is not applied: swept songs leave no library entry",
            )
        return 0
    await conn.execute("RELEASE SAVEPOINT library_snapshot")
    return max(0, getattr(cur, "rowcount", 0) or 0)


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
    snapshotted = 0
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
        # ONE transaction per job (Phase B, B1): (1) the library snapshot, (2) SAVEPOINT
        # before_delete + DELETE, (3) on ForeignKeyViolation ROLLBACK TO that savepoint (NOT
        # conn.rollback(), which would also undo the snapshot) and anonymise in the same
        # transaction, (4) COMMIT. (5) Any other failure rolls ALL of it back (no entry, row
        # kept) and the job is retried later with backoff.
        event = "retention_db_delete_failed"
        try:
            n_snap = await _snapshot_library_entry(conn, job_id)
            await conn.execute("SAVEPOINT before_delete")
            try:
                await conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
                deleted = True
            except pg_errors.ForeignKeyViolation:
                # Ledger rows reference this job (append-only by design): keep the shell.
                await conn.execute("ROLLBACK TO SAVEPOINT before_delete")
                event = "retention_anonymise_failed"
                await _anonymise_job(conn, job_id)
                deleted = False
            await conn.commit()
        except Exception as e:  # noqa: BLE001 — one bad row must never abort the sweep
            await conn.rollback()
            _record_failure(job_id, event, e)
            continue
        snapshotted += n_snap
        if deleted:
            _failed.pop(job_id, None)
            swept += 1
        else:
            _failed.pop(job_id, None)
            anonymised += 1
            log_structured("INFO", "retention_job_anonymised", job_id=job_id)
    log_structured("INFO", "library_entry_snapshotted", count=snapshotted)
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
    unknown_processed = _unknown_processed_seen  # process lifetime, not per pass
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
            unknown_processed.update(
                j for j in (_job_id_of(k) for k in keys if _is_processed_key(k)) if j in unknown
            )
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


def _main(argv: list[str] | None = None) -> int:
    """`python -m src.worker.cleanup --print-binding`: print this machine's binding value.

    Read-only: it hashes R2_BUCKET_NAME and DATABASE_URL's user/host/port/dbname (never the
    password) and prints the 16-hex result; it connects to nothing and deletes nothing. Run
    it ONLY on the deployment whose database owns the bucket, then
    `fly secrets set ORPHAN_SWEEP_BINDING=<value> -a stem-loops`.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="python -m src.worker.cleanup")
    parser.add_argument(
        "--print-binding",
        action="store_true",
        help="print the ORPHAN_SWEEP_BINDING value for this process's bucket + database",
    )
    args = parser.parse_args(argv)
    if not args.print_binding:
        parser.print_help()
        return 2
    if not DATABASE_URL or not os.environ.get("R2_BUCKET_NAME"):
        print("DATABASE_URL and R2_BUCKET_NAME must both be set", file=sys.stderr)
        return 1
    print(orphan_sweep_binding())
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
