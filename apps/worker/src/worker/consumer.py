"""Worker queue consumer (Gate 0 S2 decision: Python consumes via FOR UPDATE SKIP LOCKED).

There is no external queue broker: the web layer just INSERTs a job row (status='queued')
and the Python worker claims jobs straight off the `jobs` table with
`SELECT … FOR UPDATE SKIP LOCKED`, so two stateless workers never grab the same job and one
poison job can never block the queue (it fails in isolation and the loop continues). No
Redis, no sidecar. (pg-boss was evaluated in the S2 spike but never wired into the consume
path and has been removed — see spikes/s2_pgboss/s2_decision.md; retry/attempt-cap + backoff
live in reaper.py.)

SECOND QUEUE (migration 033). Loop cutting is on demand: the pipeline records a
`loops` row per loop and cuts nothing, and `loop_cutter.claim_and_cut` claims
`loop_requests` rows the same way — `FOR UPDATE SKIP LOCKED` on its own table.
The poll loop below drains BOTH. Jobs are tried first and a claimed job short-
circuits the pass, so a backlog of loop requests can never delay a fresh upload:
a user watching a progress bar is waiting on a job, while a cut request is
already a background task from the moment it is made.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import time

import psycopg
import sentry_sdk

from . import tmpdirs
from .artifact_audit import start_artifact_audit
from .cleanup import sweep_expired
from .errors import InternalError, StemLoopsError
from .fetch_canary import start_fetch_canary
from .job_failure import JobNoLongerActive, fail_job
from .logger import log_structured
from .loop_cutter import claim_and_cut, reap_stale_requests
from .pipeline import run_pipeline
from .reaper import _NON_TERMINAL, reap_stale_jobs
from .shutdown import drain
from .spend_gate import brake_state
from .storage.r2_lifecycle_guard import start_r2_lifecycle_check

DATABASE_URL = os.environ.get("DATABASE_URL", "")
POLL_INTERVAL = 2  # seconds
# How often to sweep for jobs orphaned by a crashed/restarted worker.
REAP_INTERVAL = int(os.environ.get("REAPER_INTERVAL_SECONDS", "60"))
# How often to run the retention sweep (T33) — delete content past its 24h TTL. 15 min keeps
# the worst-case overshoot (plus any in-flight job it waits behind) well under an hour.
CLEANUP_INTERVAL = int(os.environ.get("RETENTION_SWEEP_SECONDS", "900"))
# How often to run the storage checks (QA-57/QA-59): re-read the R2 bucket's lifecycle
# rules (an expiration rule deletes paid libraries behind the sweep's back) and sample
# retained songs for missing files (artifact_audit.py). A missing object raises no error
# anywhere else. Startup + once a day, each on a daemon thread, never blocking the loop.
LIFECYCLE_CHECK_INTERVAL = 86400
# Per-job wall-clock budget (QA C-06). The pipeline runs INLINE in this loop, so the reaper and
# the retention sweep only run between jobs: one hung stage used to block the queue and the
# reaper that would have recovered it until Fly restarted the process. Heartbeated stages
# never go stale, so the reaper cannot catch a hang there either; this deadline does.
# The default must never cut off a healthy job. It is the web's queued-stall threshold
# (apps/web/src/lib/job-poll.ts QUEUED_STALL_MS, 90 min): the sum of every stage the worker
# bounds with a constant, using the DEPLOYED REPLICATE_DEADLINE (fly.toml, 300 s), is 4442 s
# (ONE_JOB_WORST_CASE_S), plus margin for extract_and_tag and the R2 PUTs, which no constant
# bounds. test/job-stall-derivation.test.mjs pins this default at or above that sum.
JOB_WALL_TIMEOUT_DEFAULT = 5400.0
JOB_WALL_TIMEOUT_MESSAGE = (
    "Processing took too long and was stopped. Please try again. "
    "If this used a credit, it has been returned."
)


# Exit status after a wall-deadline kill (EX_TEMPFAIL). Non-zero, so Fly's restart-on-exit
# (fly.toml: "Liveness is handled by Fly's restart-on-exit") brings up a fresh process.
RESTART_EXIT_CODE = 75


def _restart_process() -> None:
    """End the process so Fly restarts it (review SF-2).

    The deadline cancels the pipeline COROUTINE only. The stage that hung is a worker thread
    (`asyncio.to_thread`) and Python cannot kill a thread: it keeps its executor slot, its
    memory (six stems' arrays) and its ability to act -- an abandoned chord thread can still
    submit a PAID Klangio request for a job that was just failed and refunded. A few such
    hangs exhaust the default executor and every later job times out while the worker looks
    alive. Exiting reclaims all of it. The job is already failed and refunded (committed), and
    the worker runs one job at a time, so nothing else is in flight. `os._exit`, not
    `sys.exit`: interpreter shutdown joins executor threads, i.e. would wait on the hang.
    """
    log_structured("ERROR", "worker_exit_after_wall_timeout", exit_code=RESTART_EXIT_CODE)
    with contextlib.suppress(Exception):  # exiting regardless
        sentry_sdk.flush(timeout=2)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(RESTART_EXIT_CODE)


def _job_wall_timeout() -> float:
    raw = os.environ.get("JOB_WALL_TIMEOUT_SECONDS", "").strip()
    try:
        value = float(raw) if raw else JOB_WALL_TIMEOUT_DEFAULT
    except ValueError:
        value = 0.0
    if not 0 < value < float("inf"):
        log_structured("WARN", "env_float_invalid", name="JOB_WALL_TIMEOUT_SECONDS")
        return JOB_WALL_TIMEOUT_DEFAULT
    return value


async def claim_and_run() -> bool:
    """Claim one queued job and run it. Returns True if a job was claimed.

    SPEND BRAKE (migration 035, worker/spend_gate.py). Checked HERE, before anything is
    claimed: while `spend_global` is engaged, or unreadable, or absent, no job leaves `queued`,
    nothing is spent, and the job resumes when the brake is released. This is the only place the
    brake is consulted; both input paths and both paid providers sit behind a claimed job.
    """
    if drain.requested:  # QA-63: a draining worker claims nothing new
        return False
    if (await brake_state(DATABASE_URL)).engaged:
        return False
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        row = await (await conn.execute("""
                UPDATE jobs SET status='downloading', updated_at=now()
                WHERE id = (
                    SELECT id FROM jobs WHERE status='queued'
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id
                """)).fetchone()
        await conn.commit()
    if not row:
        return False

    job_id = str(row[0])
    log_structured("INFO", "job_claimed", job_id=job_id)
    budget = _job_wall_timeout()
    deadline = asyncio.timeout(budget)
    drain_cap = drain.budget()
    try:
        # The deadline cancels the pipeline coroutine. A worker thread it was awaiting cannot
        # be killed and finishes (or times out) in the background, but the job is already
        # terminal and the queue moves on. CancelledError is not an Exception, so the
        # pipeline's own handlers do not run; the branch below fails and refunds the job.
        #
        # DRAIN (QA-63). `drain_cap` is unbounded until SIGINT/SIGTERM, then bounds the rest of
        # this job by the drain budget (shutdown.py). Checked FIRST below: a TimeoutError
        # leaving it means "out of time to drain", not a failure, and the job is released.
        async with deadline, drain_cap:
            await run_pipeline(job_id)
    except JobNoLongerActive:
        # The reaper (or a deadline) already made the job terminal and refunded it; this run
        # was a zombie. Nothing to fail, nothing to refund (review MF-1).
        log_structured("WARN", "job_abandoned_terminal", job_id=job_id)
    except TimeoutError as e:
        if drain_cap.expired():
            await release_for_drain(job_id)
        elif deadline.expired():
            log_structured("ERROR", "job_wall_timeout", job_id=job_id, budget_s=budget)
            await mark_failed(job_id, "INTERNAL_ERROR", JOB_WALL_TIMEOUT_MESSAGE)
            _restart_process()
        else:  # a TimeoutError raised BY the pipeline (e.g. socket.timeout), not our deadline
            log_structured("ERROR", "unhandled_exception", job_id=job_id, error=str(e)[:200])
            err = InternalError()
            await mark_failed(job_id, err.error_code, err.user_message)
    except StemLoopsError as e:
        await mark_failed(job_id, e.error_code, e.user_message)
    except Exception as e:  # noqa: BLE001 — isolate the failure, never crash the loop
        log_structured("ERROR", "unhandled_exception", job_id=job_id, error=str(e)[:200])
        err = InternalError()
        await mark_failed(job_id, err.error_code, err.user_message)
    return True


# Put an interrupted job back in the queue (QA-63). Only a job still in flight is moved: one
# the pipeline already finished ('done') or failed keeps its state. `attempts` is NOT bumped --
# that counter is the reaper's poison budget, and our own restart is not the job's fault.
# Everything the rerun meets is already safe to meet twice (reaper.py docstring): the
# persisted Replicate prediction is re-attached, loop rows are ON CONFLICT, R2 keys are
# deterministic and are overwritten.
_RELEASE_SQL = """
UPDATE jobs SET status='queued', updated_at=now()
 WHERE id=%s AND status = ANY(%s)
RETURNING id
"""


async def release_for_drain(job_id: str) -> bool:
    """Return a job the drain could not finish to 'queued'. Returns True if it was released.

    Never raises: if the release cannot be written (DB unreachable) the job stays where it is
    and the reaper re-queues it after its stale window, exactly as before this change."""
    try:
        async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
            row = await (await conn.execute(_RELEASE_SQL, (job_id, _NON_TERMINAL))).fetchone()
            await conn.commit()
    except Exception as e:  # noqa: BLE001 — the reaper is the fallback
        log_structured("ERROR", "job_drain_release_failed", job_id=job_id, error=str(e)[:200])
        return False
    log_structured(
        "WARN",
        "job_released_for_drain" if row else "job_drain_release_noop",
        job_id=job_id,
    )
    return row is not None


async def mark_failed(job_id: str, error_code: str, message: str) -> None:
    """Fail the job and return its credit if owed (job_failure.fail_job; idempotent, so the
    pipeline having already failed and refunded the same job is harmless)."""
    await fail_job(DATABASE_URL, job_id, error_code, message)
    log_structured("WARN", "job_failed", job_id=job_id, error_code=error_code)


async def _safe_reap() -> None:
    """Run the orphan reapers; a reaper failure must never kill the poll loop.

    Two queues, two orphan classes: a job stuck mid-pipeline (reaper.py) and a
    loop request stuck at 'running' because its worker died (loop_cutter). The
    second matters as much as the first — `loop_requests_live_idx` makes 'running'
    exclusive per job, so a stuck request blocks that job's loops forever.
    Separately guarded, so one failing reaper does not skip the other.
    """
    try:
        await reap_stale_jobs()
    except Exception as e:  # noqa: BLE001
        log_structured("ERROR", "reaper_error", error=str(e)[:200])
    try:
        await reap_stale_requests()
    except Exception as e:  # noqa: BLE001
        log_structured("ERROR", "loop_request_reaper_error", error=str(e)[:200])


async def _safe_sweep() -> None:
    """Run the retention sweep; a sweep failure must never kill the poll loop."""
    try:
        await sweep_expired()
    except Exception as e:  # noqa: BLE001
        log_structured("ERROR", "retention_sweep_error", error=str(e)[:200])


def _safe_lifecycle_check() -> None:
    """Start the daily storage checks in the background; never raises, never blocks.

    Two independent daemon threads, separately guarded: the R2 lifecycle guard and the
    retained-song artifact audit.
    """
    try:
        start_r2_lifecycle_check()
    except Exception as e:  # noqa: BLE001
        log_structured("WARN", "r2_lifecycle_check_failed", error=str(e)[:200])
    try:
        start_artifact_audit()
    except Exception as e:  # noqa: BLE001
        log_structured("WARN", "artifact_audit_failed", stage="start", error=str(e)[:200])


def _safe_start_fetch_canary() -> None:
    """Start the proxy/YouTube fetch canary (QA-61) on its own daemon thread; never raises,
    never blocks. It loops on its own interval, so it is started once, not per pass."""
    try:
        start_fetch_canary()
    except Exception as e:  # noqa: BLE001
        log_structured("WARN", "fetch_canary_start_failed", error=str(e)[:200])


async def poll_loop() -> None:
    """Continuously claim and run jobs; idle-sleep when the queue is empty.

    Reaps orphaned jobs at startup (recover whatever a prior crash abandoned) and
    then periodically (catch a sibling worker's death when horizontally scaled).

    Returns once a drain is requested (QA-63, shutdown.py) and the unit of work in hand --
    a job, or a loop cut -- has finished or been released. It claims nothing after that.
    """
    log_structured("INFO", "consumer_started")
    # A hard crash/OOM can strand a job's scratch dirs (user audio) on local disk.
    try:
        await asyncio.to_thread(tmpdirs.sweep_stale)
    except Exception as e:  # noqa: BLE001
        log_structured("ERROR", "tmp_sweep_error", error=str(e)[:200])
    _safe_lifecycle_check()
    _safe_start_fetch_canary()
    await _safe_reap()
    await _safe_sweep()
    last_reap = time.monotonic()
    last_cleanup = time.monotonic()
    last_lifecycle_check = time.monotonic()
    while not drain.requested:
        try:
            claimed = await claim_and_run()
        except Exception as e:  # noqa: BLE001 — DB blips must not kill the worker
            log_structured("ERROR", "consumer_loop_error", error=str(e)[:200])
            claimed = False
        # Only when no job was waiting: a separation is what a user is watching a
        # progress bar for, a loop cut is not. `claim_and_cut` isolates its own
        # failures (it closes the request 'failed' and returns True), so the only
        # thing that reaches here is a DB-level blip, handled like the one above.
        if not claimed and not drain.requested:
            try:
                claimed = await claim_and_cut()
            except Exception as e:  # noqa: BLE001 — DB blips must not kill the worker
                log_structured("ERROR", "loop_cutter_loop_error", error=str(e)[:200])
                claimed = False
        if drain.requested:
            break
        if time.monotonic() - last_reap >= REAP_INTERVAL:
            await _safe_reap()
            last_reap = time.monotonic()
        if time.monotonic() - last_cleanup >= CLEANUP_INTERVAL:
            await _safe_sweep()
            last_cleanup = time.monotonic()
        if time.monotonic() - last_lifecycle_check >= LIFECYCLE_CHECK_INTERVAL:
            _safe_lifecycle_check()
            last_lifecycle_check = time.monotonic()
        if not claimed:
            await asyncio.sleep(POLL_INTERVAL)
    log_structured("INFO", "consumer_drained", signal=drain.signal_name)
