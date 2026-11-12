"""The retention sweep is actually CALLED by the poll loop, at startup and then on a timer.

Today nothing notices if `_safe_sweep` returns before sweeping, or if `poll_loop` stops
calling it: `test_consumer.py` has one test and never runs `poll_loop`, and
`test_cleanup.py` calls `sweep_expired()` directly. The 24-hour promise then rests on
nothing, and the suite stays green.

These tests RUN `consumer.poll_loop()` under a fake clock and count what happens, rather
than reading its source: a source assertion is satisfied by a comment, which is the
defect class this repo has shipped repeatedly.

WHAT EACH GROUP DOES AND DOES NOT PROVE. Be exact, because round 1 of this file claimed
more than it did:

  * The CADENCE tests (startup + interval, a busy worker, a failing sweep) install a
    counting stub over `consumer.sweep_expired`. They prove `poll_loop` and `_safe_sweep`
    call WHATEVER `consumer` has bound to that name at the right times. They prove nothing
    about what that name is bound to: replacing `from .cleanup import sweep_expired` with
    `async def sweep_expired(): return {}` leaves all of them green.
  * The DEFAULT-INTERVAL tests read the interval out of a fresh interpreter and compare it
    with the literal 900 (and the env override with another literal), so the value cannot
    drift with the code under test.
  * The CHAIN test is the only one that leaves `consumer.sweep_expired` ALONE. It is the
    one that fails when the binding is not the real sweep.

The cadence tests need no database and no S3, so they also run in the no-DB baseline that
silently skips ~170 other tests. The chain test needs both.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import types
import uuid

import pytest

from worker import consumer

# The product promise is "swept every 15 minutes". Literal on purpose: a test that reads the
# interval back out of the code under test passes for any interval the code is changed to.
SWEEP_INTERVAL_SEC = 900
# The most a sweep may run late: one idle sleep of the poll loop.
SWEEP_LATENESS_SEC = 30


class _Stop(BaseException):
    """BaseException so `poll_loop`'s `except Exception` blocks cannot swallow it."""


class _Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now


def _drive_poll_loop(
    monkeypatch, *, run_for: float, sweep=None, claim_seconds: float | None = None, claim_cap=20000
) -> _Clock:
    """Run the real `poll_loop` on a fake clock until `run_for` fake seconds have passed.

    `sweep` is a stub for `consumer.sweep_expired`, or a factory taking the fake clock and
    returning one (so a stub can timestamp its calls). With `sweep=None` NOTHING is
    installed and `consumer.sweep_expired` stays exactly what `consumer.py` bound it to.

    `claim_seconds=None` models an idle worker (nothing to claim, so it sleeps).
    `claim_seconds=N` models a BUSY one: every claim succeeds and takes N fake seconds, so
    the loop never sleeps.

    Real: `poll_loop`, `_safe_sweep`, the interval arithmetic. Stubbed: the clock, the
    sleep, `tmpdirs.sweep_stale` (a module shared with `cleanup`, so it is inert there too),
    the two reapers and the two claimers.
    """
    clock = _Clock()
    # `consumer.time` is the module; give consumer a stub with only the clock it reads.
    monkeypatch.setattr(consumer, "time", types.SimpleNamespace(monotonic=clock.monotonic))
    if sweep is not None:
        if not asyncio.iscoroutinefunction(sweep):
            sweep = sweep(clock)
        monkeypatch.setattr(consumer, "sweep_expired", sweep)
    monkeypatch.setattr(consumer.tmpdirs, "sweep_stale", lambda: 0)

    async def reap_jobs():
        return 0

    async def reap_requests():
        return 0

    calls = {"n": 0}

    def guard():
        calls["n"] += 1
        if calls["n"] > claim_cap:
            raise _Stop("poll_loop spun without ever sleeping")

    async def nothing_to_claim():
        guard()
        return False

    async def a_job_to_run():
        guard()
        clock.now += claim_seconds
        if clock.now >= run_for:
            raise _Stop
        return True

    async def fake_sleep(seconds):
        clock.now += seconds
        if clock.now >= run_for:
            raise _Stop

    monkeypatch.setattr(consumer, "reap_stale_jobs", reap_jobs)
    monkeypatch.setattr(consumer, "reap_stale_requests", reap_requests)
    monkeypatch.setattr(
        consumer, "claim_and_run", nothing_to_claim if claim_seconds is None else a_job_to_run
    )
    monkeypatch.setattr(consumer, "claim_and_cut", nothing_to_claim)
    monkeypatch.setattr(consumer.asyncio, "sleep", fake_sleep)

    with pytest.raises(_Stop):
        asyncio.run(consumer.poll_loop())
    return clock


def _recording_sweep(sweeps: list[float]):
    def make_sweep(clock):
        async def sweep():
            sweeps.append(clock.now)
            return {}

        return sweep

    return make_sweep


def test_poll_loop_sweeps_once_at_startup_then_every_cleanup_interval(monkeypatch):
    sweeps: list[float] = []
    monkeypatch.setattr(consumer, "CLEANUP_INTERVAL", SWEEP_INTERVAL_SEC)
    run_for = 2 * SWEEP_INTERVAL_SEC + 10
    _drive_poll_loop(monkeypatch, run_for=run_for, sweep=_recording_sweep(sweeps))

    assert len(sweeps) == 3, (
        f"expected the startup sweep plus one per {SWEEP_INTERVAL_SEC}s over {run_for}s -> 3 "
        f"calls; sweep_expired was called {len(sweeps)} times at fake t={sweeps}. Nothing is "
        "enforcing the 24-hour deletion promise."
    )
    assert sweeps[0] == 0.0, "the first sweep must run at startup, before any waiting"
    for n, at in enumerate(sweeps):
        assert n * SWEEP_INTERVAL_SEC <= at < n * SWEEP_INTERVAL_SEC + SWEEP_LATENESS_SEC, (
            f"sweep {n} ran at fake t={at}, expected within {SWEEP_LATENESS_SEC}s after "
            f"t={n * SWEEP_INTERVAL_SEC}"
        )


def test_a_worker_that_is_always_busy_still_sweeps_every_interval(monkeypatch):
    """The sweep is on a wall-clock timer, NOT only when the queue is empty.

    A claim that always succeeds means the loop never reaches its idle `sleep`. Gating the
    periodic sweep on "nothing was claimed" would then sweep exactly once, at startup, for
    as long as the queue stays busy -- which is when the most user audio is on disk.
    Measured against that mutant over one fake hour: sweeps at t=[0.0] only.
    """
    sweeps: list[float] = []
    monkeypatch.setattr(consumer, "CLEANUP_INTERVAL", SWEEP_INTERVAL_SEC)
    claim_seconds = 100.0
    _drive_poll_loop(
        monkeypatch,
        run_for=3600,
        sweep=_recording_sweep(sweeps),
        claim_seconds=claim_seconds,
    )

    assert len(sweeps) == 4, (
        f"a busy worker over 3600s must sweep at startup and at 900/1800/2700; "
        f"sweep_expired ran at fake t={sweeps}"
    )
    for n, at in enumerate(sweeps):
        assert (
            n * SWEEP_INTERVAL_SEC <= at < n * SWEEP_INTERVAL_SEC + claim_seconds
        ), f"sweep {n} ran at fake t={at}"


def _interval_from_a_fresh_interpreter(env_value: str | None) -> int:
    """`consumer.CLEANUP_INTERVAL` as a new process computes it, with the env we choose.

    A subprocess because the value is fixed when `consumer` is imported, and re-importing
    it in this process would rebind every name the other tests patch.
    """
    env = {k: v for k, v in os.environ.items() if k != "RETENTION_SWEEP_SECONDS"}
    if env_value is not None:
        env["RETENTION_SWEEP_SECONDS"] = env_value
    env["PYTHONPATH"] = os.pathsep.join(p for p in sys.path if p)
    out = subprocess.run(
        [sys.executable, "-c", "from worker import consumer; print(consumer.CLEANUP_INTERVAL)"],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert out.returncode == 0, f"could not import worker.consumer: {out.stderr[-500:]}"
    return int(out.stdout.strip().splitlines()[-1])


def test_the_default_sweep_interval_is_fifteen_minutes():
    """Pinned against a literal, not read back from the constant under test: a default of
    2 hours would still be 'one sweep per CLEANUP_INTERVAL' and every cadence test above
    would agree with it."""
    got = _interval_from_a_fresh_interpreter(None)
    assert got == SWEEP_INTERVAL_SEC, (
        f"RETENTION_SWEEP_SECONDS unset gives CLEANUP_INTERVAL={got}s; the product promise "
        f"(cleanup.py docstring: 'default 15 min') is {SWEEP_INTERVAL_SEC}s"
    )


def test_retention_sweep_seconds_overrides_the_default_interval():
    assert _interval_from_a_fresh_interpreter("123") == 123


def test_a_failing_sweep_does_not_stop_the_loop_or_later_sweeps(monkeypatch):
    attempts: list[int] = []

    async def exploding_sweep():
        attempts.append(1)
        raise RuntimeError("r2 down")

    monkeypatch.setattr(consumer, "CLEANUP_INTERVAL", SWEEP_INTERVAL_SEC)
    _drive_poll_loop(monkeypatch, run_for=SWEEP_INTERVAL_SEC + 10, sweep=exploding_sweep)

    assert len(attempts) == 2, (
        "a sweep that raises must be logged and retried on the next interval, not end "
        f"the loop; sweep_expired was attempted {len(attempts)} times"
    )


# ------------------------------------------------------------------ full chain


def test_poll_loop_startup_sweep_removes_an_expired_jobs_objects_from_real_r2(
    monkeypatch, tmp_path
):
    """The real `poll_loop` -> the real `_safe_sweep` -> WHATEVER `consumer.py` bound
    `sweep_expired` to -> the real R2 deleters, against a real S3 server and Postgres.

    `consumer.sweep_expired` is NOT patched here (`sweep=None`), so this fails if
    `consumer.py` binds that name to anything that does not sweep -- which no cadence test
    can see. What IS stubbed: the clock and sleep, the reapers and claimers, and
    `tmpdirs.sweep_stale`. Objects are 1 h old so the age-based orphan pass is inert and
    only the per-job delete can remove them. Shape 7 (chords) is excluded here and
    asserted by the tests in `test_retention_real_r2.py`.
    """
    import psycopg

    from tests.real_r2 import CHORDS_SHAPE, RealR2, job_footprint, require_database
    from worker import cleanup

    db = require_database()
    monkeypatch.setattr(cleanup, "DATABASE_URL", db)
    cleanup._failed.clear()
    job = str(uuid.uuid4())
    with psycopg.connect(db) as c:
        c.execute(
            "INSERT INTO public.jobs (id, input_kind, youtube_url, status, loop_length_bars, "
            "  requested_stems, client_ip_hash, client_fingerprint, created_at, expires_at) "
            "VALUES (%s,'youtube','https://y/x','done',4,%s,'iphash','fp', "
            "  now() - interval '25 hours', now() - interval '1 hour')",
            (job, ["drums"]),
        )
        c.commit()

    with RealR2(monkeypatch) as r2:
        shapes = job_footprint(job, str(tmp_path))
        for key in shapes.values():
            r2.age(key, 1.0)  # younger than the orphan backstop: only the per-job delete helps

        _drive_poll_loop(monkeypatch, run_for=10)

        left = [n for n, k in shapes.items() if k in r2.all_keys() and n != CHORDS_SHAPE]
        assert not left, f"poll_loop's startup sweep left an expired job's objects: {left}"
        with psycopg.connect(db) as c:
            assert c.execute("SELECT 1 FROM public.jobs WHERE id=%s", (job,)).fetchone() is None
    cleanup._failed.clear()
