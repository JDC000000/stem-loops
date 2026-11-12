"""The retention sweep is actually CALLED by the poll loop, at startup and then on a timer.

Today nothing notices if `_safe_sweep` returns before sweeping, or if `poll_loop` stops
calling it: `test_consumer.py` has one test and never runs `poll_loop`, and
`test_cleanup.py` calls `sweep_expired()` directly. The 24-hour promise then rests on
nothing, and the suite stays green.

These tests RUN `consumer.poll_loop()` under a fake clock and count what happens, rather
than reading its source: a source assertion is satisfied by a comment, which is the
defect class this repo has shipped repeatedly. Only what `poll_loop` actually does can
satisfy them.

The first group needs no database and no S3, so it also runs in the no-DB baseline that
silently skips ~170 other tests. The last test drives the whole chain -- `poll_loop` ->
`_safe_sweep` -> `cleanup.sweep_expired` -> the real R2 deleters -- and needs both.
"""

from __future__ import annotations

import asyncio
import os
import types
import uuid

import pytest

from worker import consumer


class _Stop(BaseException):
    """BaseException so `poll_loop`'s `except Exception` blocks cannot swallow it."""


class _Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now


def _drive_poll_loop(monkeypatch, *, run_for: float, sweep, claim_cap: int = 20000) -> _Clock:
    # `sweep` is the stub for `consumer.sweep_expired`, or a factory taking the fake
    # clock and returning one (so a stub can timestamp its calls).
    """Run the real `poll_loop` on a fake clock until `run_for` fake seconds have passed.

    Everything BELOW `_safe_sweep` / `_safe_reap` and the job/loop claimers is stubbed;
    `poll_loop`, `_safe_sweep` and the interval arithmetic are the real ones.
    """
    clock = _Clock()
    # `consumer.time` is the module; give consumer a stub with only the clock it reads.
    monkeypatch.setattr(consumer, "time", types.SimpleNamespace(monotonic=clock.monotonic))
    if not asyncio.iscoroutinefunction(sweep):
        sweep = sweep(clock)
    monkeypatch.setattr(consumer, "sweep_expired", sweep)
    monkeypatch.setattr(consumer.tmpdirs, "sweep_stale", lambda: 0)

    async def reap_jobs():
        return 0

    async def reap_requests():
        return 0

    calls = {"n": 0}

    async def nothing_to_claim():
        calls["n"] += 1
        if calls["n"] > claim_cap:
            raise _Stop("poll_loop spun without ever sleeping")
        return False

    async def fake_sleep(seconds):
        clock.now += seconds
        if clock.now >= run_for:
            raise _Stop

    monkeypatch.setattr(consumer, "reap_stale_jobs", reap_jobs)
    monkeypatch.setattr(consumer, "reap_stale_requests", reap_requests)
    monkeypatch.setattr(consumer, "claim_and_run", nothing_to_claim)
    monkeypatch.setattr(consumer, "claim_and_cut", nothing_to_claim)
    monkeypatch.setattr(consumer.asyncio, "sleep", fake_sleep)

    with pytest.raises(_Stop):
        asyncio.run(consumer.poll_loop())
    return clock


def test_poll_loop_sweeps_once_at_startup_then_every_cleanup_interval(monkeypatch):
    sweeps: list[float] = []

    def make_sweep(clock):
        async def sweep():
            sweeps.append(clock.now)
            return {}

        return sweep

    interval = consumer.CLEANUP_INTERVAL
    _drive_poll_loop(monkeypatch, run_for=2 * interval + 10, sweep=make_sweep)

    assert len(sweeps) == 3, (
        f"expected the startup sweep plus one per CLEANUP_INTERVAL ({interval}s) over "
        f"{2 * interval + 10}s -> 3 calls; sweep_expired was called {len(sweeps)} times "
        f"at fake t={sweeps}. Nothing is enforcing the 24-hour deletion promise."
    )
    assert sweeps[0] == 0.0, "the first sweep must run at startup, before any waiting"
    step = consumer.POLL_INTERVAL
    assert interval <= sweeps[1] < interval + step, f"second sweep at {sweeps[1]}"
    assert 2 * interval <= sweeps[2] < 2 * interval + 2 * step, f"third sweep at {sweeps[2]}"


def test_a_failing_sweep_does_not_stop_the_loop_or_later_sweeps(monkeypatch):
    attempts: list[int] = []

    async def exploding_sweep():
        attempts.append(1)
        raise RuntimeError("r2 down")

    interval = consumer.CLEANUP_INTERVAL
    _drive_poll_loop(monkeypatch, run_for=interval + 10, sweep=exploding_sweep)

    assert len(attempts) == 2, (
        "a sweep that raises must be logged and retried on the next interval, not end "
        f"the loop; sweep_expired was attempted {len(attempts)} times"
    )


# ------------------------------------------------------------------ full chain

DB = os.environ.get("DATABASE_URL")


@pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
def test_poll_loop_startup_sweep_removes_an_expired_jobs_objects_from_real_r2(
    monkeypatch, tmp_path
):
    """poll_loop -> _safe_sweep -> sweep_expired -> real deleters, nothing in between stubbed."""
    import psycopg

    from tests.real_r2 import CHORDS_SHAPE, RealR2, job_footprint
    from worker import cleanup

    monkeypatch.setattr(cleanup, "DATABASE_URL", DB)
    cleanup._failed.clear()
    job = str(uuid.uuid4())
    with psycopg.connect(DB) as c:
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

        async def real_sweep():
            return await cleanup.sweep_expired()

        # Restore the real sweep: `_drive_poll_loop` installs whatever it is given.
        _drive_poll_loop(monkeypatch, run_for=10, sweep=real_sweep)

        left = [n for n, k in shapes.items() if k in r2.all_keys() and n != CHORDS_SHAPE]
        assert not left, f"poll_loop's startup sweep left an expired job's objects: {left}"
        with psycopg.connect(DB) as c:
            assert c.execute("SELECT 1 FROM public.jobs WHERE id=%s", (job,)).fetchone() is None
    cleanup._failed.clear()
