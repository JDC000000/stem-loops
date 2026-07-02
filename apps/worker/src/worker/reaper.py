"""Reaper — recover jobs orphaned by a worker crash/restart (Blocker #4).

The consumer only ever claims `status='queued'` (FOR UPDATE SKIP LOCKED). A worker
that dies mid-job (Fly SIGTERM under memory/CPU pressure, OOM-kill, deploy) leaves
its job in a non-terminal, non-queued status ('downloading' … 'uploading') that
*nothing* re-claims — so it sticks forever. The reaper re-queues such a job once it
goes stale (no `updated_at` heartbeat for REAPER_STALE_SECONDS) so a fresh worker
re-runs it.

Re-running is SAFE and cheap by design:
  * separation re-attaches the persisted Replicate prediction_id — no second
    prediction, no double charge (replicate_client.submit_or_reattach);
  * loop rows use ON CONFLICT(job_id, r2_key) DO NOTHING and R2 keys are
    deterministic, so re-extraction/re-upload can't duplicate or corrupt output.

Staleness is chosen to exceed the longest single stage so a LIVE job is never
reaped: separation (the long pole, up to REPLICATE_DEADLINE) heartbeats
`updated_at` every SEPARATION_HEARTBEAT_SECONDS, and every other stage bumps it on
entry — the max gap stays well under the 300s default threshold.

Poison-job cap: a job that repeatedly kills the worker would otherwise be requeued
forever. Once it is older than REAPER_MAX_AGE_SECONDS it is failed as
INTERNAL_ERROR instead of requeued.
"""

from __future__ import annotations

import os

import psycopg

from .logger import log_structured

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# Stale = no updated_at bump for this long. Must exceed the longest heartbeated
# gap (separation heartbeats ~every 20s; other stages complete in well under 5m).
STALE_SECONDS = int(os.environ.get("REAPER_STALE_SECONDS", "300"))
# Stop retrying a job this old and fail it (poison-job backstop).
MAX_AGE_SECONDS = int(os.environ.get("REAPER_MAX_AGE_SECONDS", "1800"))

_NON_TERMINAL = ["downloading", "separating", "extracting", "uploading"]
_POISON_MESSAGE = "Processing failed after repeated attempts. Please try again."


async def reap_stale_jobs() -> dict[str, int]:
    """Fail stale-and-too-old orphans, requeue the rest. Returns {'requeued','failed'}."""
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        # Fail first: stale AND older than the retry cap (mutually exclusive with the
        # requeue branch below by created_at, so a row is only ever touched once).
        failed = await (await conn.execute(
            """
            UPDATE jobs SET status='failed', error_code='INTERNAL_ERROR',
                   error_message_user=%s, updated_at=now()
            WHERE status = ANY(%s)
              AND updated_at < now() - (%s * interval '1 second')
              AND created_at < now() - (%s * interval '1 second')
            RETURNING id
            """,
            (_POISON_MESSAGE, _NON_TERMINAL, STALE_SECONDS, MAX_AGE_SECONDS),
        )).fetchall()
        # Requeue the rest of the stale orphans for a fresh attempt.
        requeued = await (await conn.execute(
            """
            UPDATE jobs SET status='queued', updated_at=now()
            WHERE status = ANY(%s)
              AND updated_at < now() - (%s * interval '1 second')
              AND created_at >= now() - (%s * interval '1 second')
            RETURNING id
            """,
            (_NON_TERMINAL, STALE_SECONDS, MAX_AGE_SECONDS),
        )).fetchall()
        await conn.commit()

    result = {"requeued": len(requeued), "failed": len(failed)}
    if result["requeued"] or result["failed"]:
        log_structured("WARN", "reaper_swept", stale_s=STALE_SECONDS, **result)
    return result
