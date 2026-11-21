"""Graceful drain on SIGINT / SIGTERM (QA-63).

THE INCIDENT. A worker restart (`fly secrets set`, `fly deploy`: Fly stops the one Machine,
826070b70571e8, before starting its replacement) killed the job in flight. uvicorn's
`Server.serve()` installs its own SIGINT/SIGTERM handlers, shuts the /health server down, and
on the way out RE-RAISES the captured signal (uvicorn `capture_signals`). For SIGINT, Fly's
historical default kill signal, that is a `KeyboardInterrupt` in `__main__`: `asyncio.run`
cancels the poll loop mid-pipeline, `tmpdirs.job_scope()` deletes the job's scratch dirs while
the stem-retention THREAD is still walking them (it skips stems whose files have vanished, so
Sentry got "V3-J2 stem retention incomplete: 1/6"), and the job sits in 'uploading' until the
reaper re-queues it ~5 minutes later and the download + separation are paid for again.

WHAT HAPPENS NOW, in order:

  1. main.py owns the signals (uvicorn's capture is disabled there) and routes both to
     `drain.request()`.
  2. The consumer stops claiming: no new job and no new loop cut once a drain is requested.
  3. The job already running keeps running, bounded by the DRAIN BUDGET, which starts at the
     signal: `DRAIN_BUDGET_DEFAULT` seconds, fitted inside fly.toml's `kill_timeout`.
  4. If it finishes, fine. If the budget runs out first, the pipeline coroutine is cancelled
     and the job is put back to 'queued' at once (consumer.release_for_drain), with its
     `attempts` untouched: being interrupted by our own deploy is not a failed attempt. The
     next worker claims it immediately instead of after the reaper's stale window, and
     re-attaches the persisted Replicate prediction rather than paying for a new one.
  5. The process exits 0 (main.py), without a traceback and without a Sentry event.

`abandoned()` is the thread-side half of step 4. A pipeline stage running in
`asyncio.to_thread` cannot be cancelled, only orphaned; one that checks `abandoned()` stops
writing artefacts and reporting their absence as a defect.
"""

from __future__ import annotations

import asyncio
import os
import time

from .logger import log_structured

# fly.toml `kill_timeout` is 300 s, which is Fly's documented maximum. The budget leaves
# DRAIN_EXIT_MARGIN_S of it for what follows the budget: cancelling the pipeline, the release
# UPDATE (one connection), the /health server's shutdown and the Sentry flush in main.py.
# tests/test_worker_drain.py pins DRAIN_BUDGET_DEFAULT + DRAIN_EXIT_MARGIN_S <= kill_timeout
# by READING fly.toml, so the two cannot drift apart silently. A typical job is 2-4 minutes,
# so most jobs finish inside the budget even when the signal lands right after the claim.
FLY_MAX_KILL_TIMEOUT_S = 300
DRAIN_EXIT_MARGIN_S = 30
DRAIN_BUDGET_DEFAULT = 270.0


def drain_budget() -> float:
    """Seconds a running job may keep running after the signal (WORKER_DRAIN_SECONDS)."""
    raw = os.environ.get("WORKER_DRAIN_SECONDS", "").strip()
    try:
        value = float(raw) if raw else DRAIN_BUDGET_DEFAULT
    except ValueError:
        value = -1.0
    if not 0 <= value < float("inf"):
        log_structured("WARN", "env_float_invalid", name="WORKER_DRAIN_SECONDS")
        return DRAIN_BUDGET_DEFAULT
    return value


class _Budget:
    """`async with drain.budget() as b:` -- bounds the body by the drain budget, but only once
    a drain is requested (before that it is unbounded). `b.expired()` says whether the
    TimeoutError leaving the block is the drain's and not some other deadline's."""

    def __init__(self, owner: Drain) -> None:
        self._owner = owner
        self._timeout = asyncio.timeout(None)

    async def __aenter__(self) -> _Budget:
        await self._timeout.__aenter__()
        self._owner._budgets.add(self)
        if self._owner.requested:
            self._arm()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self._owner._budgets.discard(self)
        return await self._timeout.__aexit__(exc_type, exc, tb)

    def _arm(self) -> None:
        deadline = self._owner.deadline
        if deadline is None:
            return
        loop = asyncio.get_running_loop()
        when = loop.time() + max(0.0, deadline - time.monotonic())
        current = self._timeout.when()
        if current is None or when < current:
            self._timeout.reschedule(when)

    def expired(self) -> bool:
        return self._timeout.expired()


class Drain:
    """Process-wide drain state. One instance, `drain`, below."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Back to 'not draining'. For tests; production never un-drains."""
        self.signal_name: str | None = None
        self.deadline: float | None = None  # time.monotonic() at which the budget runs out
        self._budgets: set[_Budget] = set()

    @property
    def requested(self) -> bool:
        return self.deadline is not None

    def request(self, signal_name: str = "manual") -> None:
        """Start draining. Idempotent: a repeated signal neither restarts nor extends the
        budget (Fly may deliver kill_signal more than once)."""
        if self.requested:
            log_structured("INFO", "worker_drain_signal_repeated", signal=signal_name)
            return
        budget = drain_budget()
        self.signal_name = signal_name
        self.deadline = time.monotonic() + budget
        log_structured("WARN", "worker_draining", signal=signal_name, budget_s=budget)
        for b in list(self._budgets):
            b._arm()

    def budget(self) -> _Budget:
        return _Budget(self)

    def abandoned(self) -> bool:
        """True once a drain's budget has run out. Thread-safe (reads two floats), so a stage
        running in a worker thread can ask it: the coroutine that awaited it has been, or is
        about to be, cancelled and the job released, and its scratch dirs are being removed."""
        deadline = self.deadline
        return deadline is not None and time.monotonic() >= deadline


drain = Drain()


def abandoned() -> bool:
    return drain.abandoned()
