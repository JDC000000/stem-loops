"""Reaper — recover jobs orphaned by a worker crash/restart, with bounded retries.

The consumer only ever claims `status='queued'` (FOR UPDATE SKIP LOCKED). A worker
that dies mid-job (Fly SIGTERM / OOM / deploy / the trial-machine cap) leaves its job
in a non-terminal, non-queued status ('downloading' … 'uploading') that *nothing*
re-claims — so it sticks forever. The reaper re-queues such a job once it goes stale
(no `updated_at` heartbeat) so a fresh worker re-runs it.

Re-running is SAFE and cheap by design: separation re-attaches the persisted Replicate
prediction_id (no second prediction, no double charge), and loop rows/uploads are
idempotent (ON CONFLICT + deterministic R2 keys).

RETRY POLICY (security re-verification BLOCKER #4). The operator requirement — "max N
attempts, exponential backoff" — was set as pg-boss options (queue.ts) but is DEAD
config: the Python worker consumes the `jobs` table via FOR UPDATE SKIP LOCKED and never
touches pg-boss's retry engine (the S2 pgboss-hybrid was never wired). So the real
bounded retry lives HERE:
  * a stale orphan is re-queued at most REAPER_MAX_ATTEMPTS times (then failed), and
  * the stale window GROWS exponentially per attempt — STALE_SECONDS * FACTOR**attempts —
    so successive retries back off instead of hammering a poison job every sweep.

Staleness must exceed the longest heartbeated gap so a LIVE job is never reaped:
separation, stem download, extraction, chords and stem retention heartbeat `updated_at`
every ~20s (pipeline._stage_heartbeat) and every other stage bumps it on entry. A stage that
hangs while heartbeating is not this module's job: the consumer's per-job wall-clock
deadline (JOB_WALL_TIMEOUT_SECONDS) fails it.

REFUNDS (QA C-05). A job failed here is OUR fault (INTERNAL_ERROR), so the credit the web
route debited for it is returned with the same idempotent SQL the pipeline uses
(job_failure.refund_if_owed), in the same transaction as the UPDATE that fails it: either
both happen or neither does and the next reap retries.

QUEUED PAST RETENTION (QA C-06). A job waiting in `queued` (behind the spend brake, or a long
queue) is not an orphan and is never re-queued or failed for being stale. But once it is
past its own `expires_at` (the 24 h retention TTL, migration 007) nothing will serve it, and
the retention sweep takes any non-terminal job one INFLIGHT_GRACE (1 h) later, deleting or
anonymising it with the credit still spent. So the reaper fails such a job with a refund
first. The reaper runs at startup before the first sweep and every REAPER_INTERVAL_SECONDS
(60 s) after, far inside that hour.
"""

from __future__ import annotations

import os

import psycopg

from .job_failure import refund_if_owed
from .logger import log_structured

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# Base stale window: no updated_at bump for this long ⇒ the worker is gone.
STALE_SECONDS = int(os.environ.get("REAPER_STALE_SECONDS", "300"))
# Bounded retries + exponential backoff (BLOCKER #4). `attempts` counts reaper re-queues
# (0 = original run only). Attempt N is only re-queued once it has been stale for
# STALE_SECONDS * BACKOFF_FACTOR**attempts, so retries space out; once attempts reach
# MAX_ATTEMPTS the job is failed terminally instead of looping forever.
# Default 2 ⇒ up to 2 reaper re-queues = 3 TOTAL tries including the initial run, matching
# the operator's "max 3 attempts" (per-deployment overridable via REAPER_MAX_ATTEMPTS).
MAX_ATTEMPTS = int(os.environ.get("REAPER_MAX_ATTEMPTS", "2"))
BACKOFF_FACTOR = float(os.environ.get("REAPER_BACKOFF_FACTOR", "2"))

_NON_TERMINAL = ["downloading", "separating", "extracting", "uploading"]
_POISON_MESSAGE = "Processing failed after repeated attempts. Please try again."
_EXPIRED_QUEUED_MESSAGE = (
    "We couldn't start processing this song in time. Please try again. "
    "If this used a credit, it has been returned."
)
_FAIL_CODE = "INTERNAL_ERROR"


async def reap_stale_jobs() -> dict[str, int]:
    """Re-queue stale orphans with exponential backoff (bounded to MAX_ATTEMPTS), fail (and
    refund) those that have exhausted their attempts, and fail (and refund) jobs still queued
    past their retention. Returns {'requeued','failed','expired_queued'}."""
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        # Requeue: attempts left AND stale beyond this attempt's exponential backoff window.
        # Its own transaction, so a refund problem below can never hold up a requeue.
        requeued = await (
            await conn.execute(
                """
            UPDATE jobs SET status='queued', attempts = attempts + 1, updated_at=now()
            WHERE status = ANY(%s)
              AND attempts < %s
              AND updated_at < now()
                  - (interval '1 second' * (%s::numeric * power(%s::numeric, attempts)))
            RETURNING id
            """,
                (_NON_TERMINAL, MAX_ATTEMPTS, STALE_SECONDS, BACKOFF_FACTOR),
            )
        ).fetchall()
        await conn.commit()

        # Fail: attempts exhausted AND stale (base window). Mutually exclusive with the
        # requeue branch by `attempts`, so a row is only ever touched by one branch. The
        # refund commits with the failure (C-05).
        failed = await (
            await conn.execute(
                """
            UPDATE jobs SET status='failed', error_code=%s,
                   error_message_user=%s, updated_at=now()
            WHERE status = ANY(%s)
              AND attempts >= %s
              AND updated_at < now() - (%s * interval '1 second')
            RETURNING id
            """,
                (_FAIL_CODE, _POISON_MESSAGE, _NON_TERMINAL, MAX_ATTEMPTS, STALE_SECONDS),
            )
        ).fetchall()
        refunded = 0
        for (job_id,) in failed:
            refunded += await refund_if_owed(conn, str(job_id), _FAIL_CODE)
        await conn.commit()

        # Queued past its retention TTL: it will never be served, and the sweep would take it
        # without a refund (C-06). Fail it, refund in the same transaction. SKIP LOCKED so a
        # consumer claiming the row at this instant wins and the job simply runs.
        expired = await (
            await conn.execute(
                """
            UPDATE jobs SET status='failed', error_code=%s,
                   error_message_user=%s, updated_at=now()
            WHERE id IN (
                SELECT id FROM jobs
                 WHERE status = 'queued' AND expires_at < now()
                 FOR UPDATE SKIP LOCKED
            )
            RETURNING id
            """,
                (_FAIL_CODE, _EXPIRED_QUEUED_MESSAGE),
            )
        ).fetchall()
        for (job_id,) in expired:
            refunded += await refund_if_owed(conn, str(job_id), _FAIL_CODE)
        await conn.commit()

    result = {"requeued": len(requeued), "failed": len(failed), "expired_queued": len(expired)}
    if result["requeued"] or result["failed"] or result["expired_queued"]:
        log_structured(
            "WARN",
            "reaper_swept",
            stale_s=STALE_SECONDS,
            max_attempts=MAX_ATTEMPTS,
            refunded=refunded,
            **result,
        )
    return result
