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
separation (the long pole) heartbeats `updated_at` every ~20s and every other stage
bumps it on entry, all well under the 300s base window.
"""

from __future__ import annotations

import os

import psycopg

from .logger import log_structured

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# Base stale window: no updated_at bump for this long ⇒ the worker is gone.
STALE_SECONDS = int(os.environ.get("REAPER_STALE_SECONDS", "300"))
# Bounded retries + exponential backoff (BLOCKER #4). `attempts` counts reaper re-queues
# (0 = original run only). Attempt N is only re-queued once it has been stale for
# STALE_SECONDS * BACKOFF_FACTOR**attempts, so retries space out; once attempts reach
# MAX_ATTEMPTS the job is failed terminally instead of looping forever.
MAX_ATTEMPTS = int(os.environ.get("REAPER_MAX_ATTEMPTS", "3"))
BACKOFF_FACTOR = float(os.environ.get("REAPER_BACKOFF_FACTOR", "2"))

_NON_TERMINAL = ["downloading", "separating", "extracting", "uploading"]
_POISON_MESSAGE = "Processing failed after repeated attempts. Please try again."


async def reap_stale_jobs() -> dict[str, int]:
    """Re-queue stale orphans with exponential backoff (bounded to MAX_ATTEMPTS), and
    fail those that have exhausted their attempts. Returns {'requeued','failed'}."""
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        # Fail first: attempts exhausted AND stale (base window). Mutually exclusive with
        # the requeue branch by `attempts`, so a row is only ever touched by one branch.
        failed = await (await conn.execute(
            """
            UPDATE jobs SET status='failed', error_code='INTERNAL_ERROR',
                   error_message_user=%s, updated_at=now()
            WHERE status = ANY(%s)
              AND attempts >= %s
              AND updated_at < now() - (%s * interval '1 second')
            RETURNING id
            """,
            (_POISON_MESSAGE, _NON_TERMINAL, MAX_ATTEMPTS, STALE_SECONDS),
        )).fetchall()
        # Requeue: attempts left AND stale beyond this attempt's exponential backoff window.
        requeued = await (await conn.execute(
            """
            UPDATE jobs SET status='queued', attempts = attempts + 1, updated_at=now()
            WHERE status = ANY(%s)
              AND attempts < %s
              AND updated_at < now()
                  - (interval '1 second' * (%s::numeric * power(%s::numeric, attempts)))
            RETURNING id
            """,
            (_NON_TERMINAL, MAX_ATTEMPTS, STALE_SECONDS, BACKOFF_FACTOR),
        )).fetchall()
        await conn.commit()

    result = {"requeued": len(requeued), "failed": len(failed)}
    if result["requeued"] or result["failed"]:
        log_structured("WARN", "reaper_swept", stale_s=STALE_SECONDS,
                       max_attempts=MAX_ATTEMPTS, **result)
    return result
