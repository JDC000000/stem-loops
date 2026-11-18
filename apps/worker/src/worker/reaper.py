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
(job_failure.refund_if_owed). Each job is failed and refunded inside its OWN savepoint
(review SF-4): either both happen or neither does, and one job whose refund raises is rolled
back alone -- it stays non-terminal and the next reap retries it -- instead of rolling back
every other job in the batch.

QUEUED PAST ITS EXPIRY (QA C-06). A job waiting in `queued` (behind the spend brake, or a long
queue) is not an orphan and is never re-queued or failed for being stale. But once it is past
its own `expires_at` (created_at + 24 h, migration 007) the retention sweep takes any
non-terminal Free job one INFLIGHT_GRACE (1 h) later, deleting or anonymising it with the
credit still spent. So the reaper fails such a job with a refund first. It runs at startup
before the first sweep and every REAPER_INTERVAL_SECONDS (60 s) after, far inside that hour.

The cutoff is the raw `expires_at`, NOT the paid-plan retention (cleanup.RETAINED_UNTIL_SQL),
deliberately (review L-1). Retention says how long a FINISHED result is kept; a job that has
not even started after 24 h has no result to keep. For a Pro/Studio owner the sweep would not
take it (so the money risk above is Free-only), but leaving it queued means it waits for as
long as the subscription lasts and then runs, unannounced, days late. Failing it at 24 h
tells the user the truth and lets them retry; those jobs are quota-funded, so no credit is at
stake, and a credit-funded one is refunded.
"""

from __future__ import annotations

import os

import psycopg
import sentry_sdk

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


async def _fail_and_refund_each(
    conn: psycopg.AsyncConnection, job_ids: list, fail_sql: str, params: tuple, branch: str
) -> tuple[int, int]:
    """Fail and refund each candidate in its own savepoint (SF-4). The candidate rows are
    already locked by the caller's SELECT ... FOR UPDATE SKIP LOCKED; `fail_sql` re-checks the
    branch's condition on the one row. Returns (failed, refunded)."""
    failed = refunded = 0
    for (job_id,) in job_ids:
        try:
            async with conn.transaction():  # a SAVEPOINT inside the open transaction
                row = await (await conn.execute(fail_sql, (*params, job_id))).fetchone()
                if row is None:
                    continue
                refunded += await refund_if_owed(conn, str(job_id))
                failed += 1
        except Exception as exc:  # noqa: BLE001 — one bad row must not roll back the batch
            log_structured(
                "ERROR",
                "reaper_fail_refund_error",
                job_id=str(job_id),
                branch=branch,
                error=str(exc)[:200],
            )
            sentry_sdk.capture_exception(exc)
    return failed, refunded


async def reap_stale_jobs() -> dict[str, int]:
    """Re-queue stale orphans with exponential backoff (bounded to MAX_ATTEMPTS), fail (and
    refund) those that have exhausted their attempts, and fail (and refund) jobs still queued
    past their expiry. Returns {'requeued','failed','expired_queued'}."""
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
        # requeue branch by `attempts`. Refunded with the failure, per job (C-05, SF-4).
        poison = await (
            await conn.execute(
                """
            SELECT id FROM jobs
             WHERE status = ANY(%s)
               AND attempts >= %s
               AND updated_at < now() - (%s * interval '1 second')
             FOR UPDATE SKIP LOCKED
            """,
                (_NON_TERMINAL, MAX_ATTEMPTS, STALE_SECONDS),
            )
        ).fetchall()
        failed, refunded = await _fail_and_refund_each(
            conn,
            poison,
            """
            UPDATE jobs SET status='failed', error_code=%s,
                   error_message_user=%s, updated_at=now()
             WHERE status = ANY(%s) AND id = %s
            RETURNING id
            """,
            (_FAIL_CODE, _POISON_MESSAGE, _NON_TERMINAL),
            "poison",
        )
        await conn.commit()

        # Queued past its expiry (C-06). SKIP LOCKED so a consumer claiming the row at this
        # instant wins and the job simply runs.
        stale_queued = await (await conn.execute("""
            SELECT id FROM jobs
             WHERE status = 'queued' AND expires_at < now()
             FOR UPDATE SKIP LOCKED
            """)).fetchall()
        expired, expired_refunded = await _fail_and_refund_each(
            conn,
            stale_queued,
            """
            UPDATE jobs SET status='failed', error_code=%s,
                   error_message_user=%s, updated_at=now()
             WHERE status = 'queued' AND id = %s
            RETURNING id
            """,
            (_FAIL_CODE, _EXPIRED_QUEUED_MESSAGE),
            "expired_queued",
        )
        refunded += expired_refunded
        await conn.commit()

    result = {"requeued": len(requeued), "failed": failed, "expired_queued": expired}
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
