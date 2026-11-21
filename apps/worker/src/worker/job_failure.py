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

ALLOWANCE (QA-64). A signed-in LINK job spends no credit; it spends one unit of the monthly
allowance (entitlements.jobs_used) and, on the free trial path, also a trial song. The web
route records exactly what it spent in ``job_allowance_debits`` (migration 042) in the jobs-
INSERT transaction. ``restore_allowance_if_owed`` gives it back, once, when the job's STORED
error_code is in ``OUR_FAULT_CODES`` -- in the same transaction that marks the job failed, so
the sentence saying so (``ALLOWANCE_RETURNED_SENTENCE`` / ``TRIAL_RETURNED_SENTENCE``) is
appended to the stored message only when it is true, and is visible with the failure itself.

This module deliberately imports nothing heavy (no audio stack), so the reaper can use it.
"""

from __future__ import annotations

import psycopg
import sentry_sdk

from .logger import log_structured

# Failures that are OUR fault (provider outage, our storage, an unanticipated exception, a
# job we abandoned): the credit the web route debited for this job is returned.
# FETCH_PROXY_FAILED (QA-61): our proxy failed the fetch -- ours, not the user's. Only link jobs
# can fail with it, and link jobs never spend a credit (the credit_consumption trigger accepts
# upload jobs only: migrations 013 and 039), so REFUND_SQL's join on credit_consumption never
# matches one. What a failed link job DOES use -- a unit of the monthly allowance and, on the
# trial path, a trial song -- is given back by restore_allowance_if_owed (QA-64), keyed on this
# same tuple. DOWNLOAD_BLOCKED / DOWNLOAD_TIMEOUT / DOWNLOAD_PRIVATE / ... are NOT here: the
# repo classes them as the video's or the user's, so neither a credit nor a song comes back.
OUR_FAULT_CODES = ("SEPARATION_FAILED", "UPLOAD_FAILED", "INTERNAL_ERROR", "FETCH_PROXY_FAILED")
REFUND_PROVIDER = "worker_job_failed"
# Never refunded, even though no paid call was made (Jon 2026-11-18 09:23 PT: "No refund for
# over length."). Today an over-length upload is not rejected at all: it is TRIMMED to its
# first MAX_UPLOAD_DURATION_SEC seconds and processed (Jon, 2026-11-14), so it never fails
# with this code. This pins the decision for the day a refusal path comes back, and for rows
# failed before the trim. A user-fault code, decided from the STORED error_code like the rest.
NEVER_REFUNDED_CODES = ("UPLOAD_TOO_LONG",)

# One credit back for a FAILED credit-funded job when either
#   * the failure is ours: the job's STORED error_code is in OUR_FAULT_CODES, or
#   * no paid provider call was made (replicate_prediction_id IS NULL: a corrupt, empty or
#     too-short upload rejected before separation) -- nothing was spent, so this cannot be
#     farmed -- EXCEPT a NEVER_REFUNDED_CODES failure (over length: Jon, 2026-11-18).
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
   AND COALESCE(j.error_code, '') <> ALL(%(never_refunded_codes)s)
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


# QA-64. Appended to the job's stored error_message_user, in the failing transaction, only when
# restore_job_allowance() actually gave a unit back -- so it is never shown when it is false
# (user-fault failure, anonymous job, a job from before migration 042, a month that has since
# rolled over, an expired trial). The web job page appends the same sentence when its own copy
# overrides the stored one (lib/error-copy.ts USAGE_RETURNED_SENTENCES; pinned identical by
# apps/web/test/allowance-restore.test.mjs).
ALLOWANCE_RETURNED_SENTENCE = "This didn't count toward your monthly songs."
TRIAL_RETURNED_SENTENCE = "This didn't use one of your trial songs."

RESTORE_SQL = """
SELECT allowance_restored, trial_restored
  FROM public.restore_job_allowance(%(job_id)s::uuid, %(our_fault_codes)s::text[])
"""

_NOTE_RESTORED_SQL = """
UPDATE jobs
   SET error_message_user = COALESCE(error_message_user || ' ', '') || %s
 WHERE id = %s
"""

# One warning per process while migration 042 is not applied (see restore_allowance_if_owed).
_restore_unmigrated_warned = False


class JobNoLongerActive(Exception):
    """The job reached a terminal state (failed by the reaper or the deadline, or done) while
    this run was still going. The run must stop and write nothing more (review MF-1)."""


async def refund_if_owed(conn: psycopg.AsyncConnection, job_id: str) -> bool:
    """Run REFUND_SQL for one job on ``conn`` (the caller commits). True if a credit was
    returned by THIS call; False if none is owed or it had already been returned."""
    cur = await conn.execute(
        REFUND_SQL,
        {
            "provider": REFUND_PROVIDER,
            "job_id": job_id,
            "our_fault_codes": list(OUR_FAULT_CODES),
            "never_refunded_codes": list(NEVER_REFUNDED_CODES),
        },
    )
    refunded = await cur.fetchone() is not None
    if refunded:
        log_structured("INFO", "credit_refunded_failed_job", job_id=job_id)
    return refunded


async def restore_allowance_if_owed(conn: psycopg.AsyncConnection, job_id: str) -> str | None:
    """Give back, once, the allowance unit / trial song a failed link job spent, if the job's
    STORED error_code is ours (migration 042 restore_job_allowance; the caller commits). Also
    appends the matching sentence to the stored error_message_user, in the same savepoint, so
    the message says so exactly when it happened.

    Returns "trial" or "allowance" for what THIS call gave back, else None (nothing owed, a
    user-fault code, already restored, a rolled-over period, an expired trial).

    Runs in a SAVEPOINT on the caller's transaction. A database without migration 042 (no
    function: 42883) is "not migrated yet": logged once per process, None returned, and the
    caller's failure / credit refund are unaffected. Any other error rolls back this savepoint
    only and is raised to the caller.
    """
    global _restore_unmigrated_warned
    try:
        async with conn.transaction():
            row = await (
                await conn.execute(
                    RESTORE_SQL,
                    {"job_id": job_id, "our_fault_codes": list(OUR_FAULT_CODES)},
                )
            ).fetchone()
            if row is None:
                return None
            allowance_back, trial_back = bool(row[0]), bool(row[1])
            if not (allowance_back or trial_back):
                return None
            restored = "trial" if trial_back else "allowance"
            sentence = TRIAL_RETURNED_SENTENCE if trial_back else ALLOWANCE_RETURNED_SENTENCE
            await conn.execute(_NOTE_RESTORED_SQL, (sentence, job_id))
    except psycopg.errors.UndefinedFunction:
        if not _restore_unmigrated_warned:
            _restore_unmigrated_warned = True
            log_structured("WARN", "allowance_restore_unmigrated", job_id=job_id)
        return None
    log_structured(
        "INFO",
        "allowance_restored_failed_job",
        job_id=job_id,
        allowance=allowance_back,
        trial=trial_back,
    )
    return restored


async def restore_allowance_isolated(
    conn: psycopg.AsyncConnection, job_id: str, *, stage: str
) -> str | None:
    """``restore_allowance_if_owed`` that NEVER raises (QA-66, review #308 L-1).

    The restore already runs in its own SAVEPOINT, so an error rolls back only the restore;
    catching it here is what keeps the caller's transaction going: the reaper's per-job
    savepoint still fails the job and keeps its credit refund, and fail_job's second
    transaction still commits the credit refund. A persistent restore error (42501 if the
    worker's role cannot run restore_job_allowance, say) can then never leave a job
    non-terminal or silently stop upload refunds. Logged as ``allowance_restore_failed``
    with ``stage`` and sent to Sentry; the restore is exactly-once in the database, so a
    later path (or the next reaper sweep for a job not yet failed) can still apply it.
    """
    try:
        return await restore_allowance_if_owed(conn, job_id)
    except Exception as exc:  # noqa: BLE001 — a restore problem must never undo a failure/refund
        log_structured(
            "ERROR", "allowance_restore_failed", job_id=job_id, stage=stage, error=str(exc)[:200]
        )
        sentry_sdk.capture_exception(exc)
        return None


async def fail_job(database_url: str, job_id: str, error_code: str, user_message: str) -> bool:
    """Mark a job failed (unless it is already terminal), then return its credit if owed.
    Returns True if THIS call marked the job.

    Two transactions on purpose (the pipeline's original semantics): the failure is committed
    first, so a refund problem can never leave the job looking alive. The refund step runs
    even when the job was already failed, so a refund that errored earlier is retried; it is
    idempotent and decided from the stored row. A refund error is logged and sent to Sentry,
    never raised.

    The allowance restore (QA-64) runs in the FAILING transaction, in its own savepoint, so
    the "didn't count" sentence is committed together with the failure and the job page never
    shows the failure without it. If it errors there, the failure still commits and the
    restore is retried in the second transaction (it is exactly-once in the database). In
    both transactions it is isolated (restore_allowance_isolated, QA-66): a restore error is
    logged as ``allowance_restore_failed`` and never rolls back the failure or the credit
    refund; ``credit_refund_failed`` now means only what it says.
    """
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        marked = await (
            await conn.execute(_FAIL_SQL, (error_code, user_message, job_id))
        ).fetchone()
        await restore_allowance_isolated(conn, job_id, stage="fail_job")
        await conn.commit()
    try:
        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            await refund_if_owed(conn, job_id)
            await restore_allowance_isolated(conn, job_id, stage="fail_job_retry")
            await conn.commit()
    except Exception as exc:  # noqa: BLE001 — a refund problem must never mask the failure
        log_structured("ERROR", "credit_refund_failed", job_id=job_id, error=str(exc)[:200])
        sentry_sdk.capture_exception(exc)
    return marked is not None
