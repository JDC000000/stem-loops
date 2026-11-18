"""One fail-and-refund path for every place the worker gives up on a job (QA C-05 / C-06).

Before this module the refund lived only in ``pipeline._fail``. Three other code paths wrote
``status='failed'`` (or let a job be swept) without it, so the credit the web route debited
for the job was silently kept:

  * the reaper's poison branch (a job killed three times by our OOM / deploy / crash),
  * ``consumer.mark_failed`` (anything that escapes ``run_pipeline``, now including the
    per-job wall-clock deadline), and
  * a job left ``queued`` past its retention (the spend brake held it) and then swept.

Rule: every code path that writes ``status='failed'`` goes through ``refund_if_owed`` (inside
the same transaction as its UPDATE) or ``fail_job``. The refund policy and its idempotency
are unchanged from the pipeline path; see ``REFUND_SQL``.

This module deliberately imports nothing heavy (no audio stack), so the reaper can use it.
"""

from __future__ import annotations

import psycopg
import sentry_sdk

from .logger import log_structured

# Failures that are OUR fault (provider outage, our storage, an unanticipated exception, a
# job we abandoned): the credit the web route debited for this job is returned.
OUR_FAULT_CODES = ("SEPARATION_FAILED", "UPLOAD_FAILED", "INTERNAL_ERROR")
REFUND_PROVIDER = "worker_job_failed"

# One credit back for a FAILED credit-funded job when either
#   * the failure is ours: the job's STORED error_code is in OUR_FAULT_CODES, or
#   * no paid provider call was made (replicate_prediction_id IS NULL: a corrupt, empty or
#     over-length upload rejected before separation) -- nothing was spent, so this cannot be
#     farmed.
# NOT refunded: an input-caused failure AFTER paid separation (EXTRACTION_FAILED on a
# beatless / too-short track); refunding that would make Replicate spend free to trigger.
#
# The decision reads the ROW, not the caller (review SF-1): the first failure wins
# (_FAIL_SQL), so a later path that tries to fail the same job as INTERNAL_ERROR -- the wall
# deadline landing inside the pipeline's own EXTRACTION_FAILED -- can neither overwrite the
# true code nor turn a user-fault failure into a refund. `j.status = 'failed'` means a job
# that finished ('done') or is still running is never refunded, whoever asks.
#
# Idempotent: credit_adjustments is UNIQUE (provider, provider_event_id) and the job id is
# the event id, so a reaper rerun / a second failure path for the same job cannot refund
# twice. Only jobs with a credit_consumption row are touched (quota-funded and anonymous jobs
# spent no credit). reason='adjustment' (positive delta) so it can never collide with Stripe
# 'refund' clawbacks, which are negative and keyed by charge.
REFUND_SQL = """
INSERT INTO credit_adjustments (user_id, credits_delta, reason, provider, provider_event_id)
SELECT cc.user_id, 1, 'adjustment', %(provider)s, cc.job_id::text
  FROM credit_consumption cc
  JOIN jobs j ON j.id = cc.job_id
 WHERE cc.job_id = %(job_id)s
   AND j.status = 'failed'
   AND (j.error_code = ANY(%(our_fault_codes)s) OR j.replicate_prediction_id IS NULL)
ON CONFLICT (provider, provider_event_id) DO NOTHING
RETURNING user_id
"""

# Only a job that is still in flight (or queued) is failed. A job that finished is never
# flipped (a deadline firing as the pipeline writes 'done' must not undo a delivered result),
# and a job that already failed keeps its first error_code (review SF-1).
_FAIL_SQL = """
UPDATE jobs SET status='failed', error_code=%s, error_message_user=%s, updated_at=now()
 WHERE id=%s AND status NOT IN ('done','failed')
RETURNING id
"""


class JobNoLongerActive(Exception):
    """The job reached a terminal state (failed by the reaper or the deadline, or done) while
    this run was still going. The run must stop and write nothing more (review MF-1)."""


async def refund_if_owed(conn: psycopg.AsyncConnection, job_id: str) -> bool:
    """Run REFUND_SQL for one job on ``conn`` (the caller commits). True if a credit was
    returned by THIS call; False if none is owed or it had already been returned."""
    cur = await conn.execute(
        REFUND_SQL,
        {"provider": REFUND_PROVIDER, "job_id": job_id, "our_fault_codes": list(OUR_FAULT_CODES)},
    )
    refunded = await cur.fetchone() is not None
    if refunded:
        log_structured("INFO", "credit_refunded_failed_job", job_id=job_id)
    return refunded


async def fail_job(database_url: str, job_id: str, error_code: str, user_message: str) -> bool:
    """Mark a job failed (unless it is already terminal), then return its credit if owed.
    Returns True if THIS call marked the job.

    Two transactions on purpose (the pipeline's original semantics): the failure is committed
    first, so a refund problem can never leave the job looking alive. The refund step runs
    even when the job was already failed, so a refund that errored earlier is retried; it is
    idempotent and decided from the stored row. A refund error is logged and sent to Sentry,
    never raised.
    """
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        marked = await (
            await conn.execute(_FAIL_SQL, (error_code, user_message, job_id))
        ).fetchone()
        await conn.commit()
    try:
        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            await refund_if_owed(conn, job_id)
            await conn.commit()
    except Exception as exc:  # noqa: BLE001 — a refund problem must never mask the failure
        log_structured("ERROR", "credit_refund_failed", job_id=job_id, error=str(exc)[:200])
        sentry_sdk.capture_exception(exc)
    return marked is not None
