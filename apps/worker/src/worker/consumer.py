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
from .cleanup import sweep_expired
from .errors import InternalError, StemLoopsError
from .job_failure import JobNoLongerActive, fail_job
from .logger import log_structured
from .loop_cutter import claim_and_cut, reap_stale_requests
from .pipeline import run_pipeline
from .reaper import reap_stale_jobs
from .spend_gate import brake_state

DATABASE_URL = os.environ.get("DATABASE_URL", "")
POLL_INTERVAL = 2  # seconds
# How often to sweep for jobs orphaned by a crashed/restarted worker.
REAP_INTERVAL = int(os.environ.get("REAPER_INTERVAL_SECONDS", "60"))
# How often to run the retention sweep (T33) — delete content past its 24h TTL. 15 min keeps
# the worst-case overshoot (plus any in-flight job it waits behind) well under an hour.
CLEANUP_INTERVAL = int(os.environ.get("RETENTION_SWEEP_SECONDS", "900"))
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
    try:
        # The deadline cancels the pipeline coroutine. A worker thread it was awaiting cannot
        # be killed and finishes (or times out) in the background, but the job is already
        # terminal and the queue moves on. CancelledError is not an Exception, so the
        # pipeline's own handlers do not run; the branch below fails and refunds the job.
        async with deadline:
            await run_pipeline(job_id)
    except JobNoLongerActive:
        # The reaper (or a deadline) already made the job terminal and refunded it; this run
        # was a zombie. Nothing to fail, nothing to refund (review MF-1).
        log_structured("WARN", "job_abandoned_terminal", job_id=job_id)
    except TimeoutError as e:
        if deadline.expired():
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


async def poll_loop() -> None:
    """Continuously claim and run jobs; idle-sleep when the queue is empty.

    Reaps orphaned jobs at startup (recover whatever a prior crash abandoned) and
    then periodically (catch a sibling worker's death when horizontally scaled).
    """
    log_structured("INFO", "consumer_started")
    # A hard crash/OOM can strand a job's scratch dirs (user audio) on local disk.
    try:
        await asyncio.to_thread(tmpdirs.sweep_stale)
    except Exception as e:  # noqa: BLE001
        log_structured("ERROR", "tmp_sweep_error", error=str(e)[:200])
    await _safe_reap()
    await _safe_sweep()
    last_reap = time.monotonic()
    last_cleanup = time.monotonic()
    while True:
        try:
            claimed = await claim_and_run()
        except Exception as e:  # noqa: BLE001 — DB blips must not kill the worker
            log_structured("ERROR", "consumer_loop_error", error=str(e)[:200])
            claimed = False
        # Only when no job was waiting: a separation is what a user is watching a
        # progress bar for, a loop cut is not. `claim_and_cut` isolates its own
        # failures (it closes the request 'failed' and returns True), so the only
        # thing that reaches here is a DB-level blip, handled like the one above.
        if not claimed:
            try:
                claimed = await claim_and_cut()
            except Exception as e:  # noqa: BLE001 — DB blips must not kill the worker
                log_structured("ERROR", "loop_cutter_loop_error", error=str(e)[:200])
                claimed = False
        if time.monotonic() - last_reap >= REAP_INTERVAL:
            await _safe_reap()
            last_reap = time.monotonic()
        if time.monotonic() - last_cleanup >= CLEANUP_INTERVAL:
            await _safe_sweep()
            last_cleanup = time.monotonic()
        if not claimed:
            await asyncio.sleep(POLL_INTERVAL)
