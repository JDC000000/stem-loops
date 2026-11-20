"""QA-63: a restart drains the worker instead of killing the job in flight.

No database: the consumer's two SQL round trips (the claim and the drain release) go to a
fake `psycopg` that records them, and the pipeline is a stub that sleeps. What is REAL:
`consumer.claim_and_run`, `consumer.poll_loop`, `consumer.release_for_drain`, the drain
state and budget (`worker.shutdown`), `main.serve` / `main._Server`, and -- in the
subprocess tests -- a real signal delivered to a real process by the kernel.

The subprocess tests are the incident itself: before this change SIGINT produced a
KeyboardInterrupt traceback and a cancelled job, and SIGTERM killed the process outright.
`test_harness_sees_the_bug_with_stock_uvicorn` runs the same harness with uvicorn's own
signal capture put back, and requires the old failure, so a green run here means the harness
can tell the difference.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import select
import signal
import subprocess
import sys
import textwrap
import time
import tomllib
import types
from pathlib import Path

import pytest
import uvicorn

from worker import consumer, pipeline, shutdown
from worker.shutdown import drain

WORKER_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _fresh_drain(monkeypatch):
    monkeypatch.delenv("WORKER_DRAIN_SECONDS", raising=False)
    drain.reset()
    yield
    drain.reset()


class _FakeDB:
    """Stands in for `consumer.psycopg`. The first claim returns `job-1`, later claims find
    nothing; the release returns the row unless `release_row` is None."""

    def __init__(self, release_row=("job-1",)):
        self.sql: list[tuple[str, object]] = []
        self.claims = 0
        self.release_row = release_row
        self.connects = 0
        db = self

        class _Cur:
            def __init__(self, row):
                self._row = row

            async def fetchone(self):
                return self._row

        class _Conn:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def execute(self, sql, params=None):
                db.sql.append((sql, params))
                if "status='downloading'" in sql:
                    db.claims += 1
                    return _Cur(("job-1",) if db.claims == 1 else None)
                if "SET status='queued'" in sql:
                    return _Cur(db.release_row)
                raise AssertionError(f"unexpected SQL: {sql}")

            async def commit(self):
                return None

        async def connect(_url):
            db.connects += 1
            return _Conn()

        self.module = types.SimpleNamespace(AsyncConnection=types.SimpleNamespace(connect=connect))

    def releases(self):
        return [(s, p) for s, p in self.sql if "SET status='queued'" in s]


def _wire(monkeypatch, db: _FakeDB, pipeline_fn, failed: list):
    monkeypatch.setattr(consumer, "psycopg", db.module)

    async def brake_released(_url):
        return types.SimpleNamespace(engaged=False)

    async def record_failed(job_id, code, msg):
        failed.append((job_id, code))

    monkeypatch.setattr(consumer, "brake_state", brake_released)
    monkeypatch.setattr(consumer, "run_pipeline", pipeline_fn)
    monkeypatch.setattr(consumer, "mark_failed", record_failed)


# --------------------------------------------------------------------------- drain state


def test_request_is_idempotent_and_does_not_extend_the_budget(monkeypatch):
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "100")
    drain.request("SIGTERM")
    first = drain.deadline
    time.sleep(0.01)
    drain.request("SIGINT")
    assert drain.deadline == first
    assert drain.signal_name == "SIGTERM"
    assert drain.requested and not drain.abandoned()


@pytest.mark.parametrize("raw", ["abc", "-1", "inf", "nan"])
def test_invalid_budget_falls_back_to_default(monkeypatch, raw):
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", raw)
    assert shutdown.drain_budget() == shutdown.DRAIN_BUDGET_DEFAULT


def test_abandoned_only_after_the_budget(monkeypatch):
    assert not drain.abandoned()
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0")
    drain.request("SIGTERM")
    assert drain.abandoned()


# --------------------------------------------------------------------------- claim_and_run


def test_draining_worker_claims_nothing(monkeypatch):
    db, failed = _FakeDB(), []

    async def never(_job_id):
        raise AssertionError("pipeline ran on a draining worker")

    _wire(monkeypatch, db, never, failed)
    drain.request("SIGTERM")
    assert asyncio.run(consumer.claim_and_run()) is False
    assert db.connects == 0, "a draining worker must not even open the claim connection"


def test_job_in_flight_finishes_when_it_fits_the_budget(monkeypatch):
    """The signal lands mid-job; the job completes; nothing is released or failed."""
    db, failed, finished = _FakeDB(), [], []

    async def job(job_id):
        drain.request("SIGTERM")
        await asyncio.sleep(0.2)
        finished.append(job_id)

    _wire(monkeypatch, db, job, failed)
    assert asyncio.run(consumer.claim_and_run()) is True
    assert finished == ["job-1"]
    assert db.releases() == [] and failed == []


def test_job_over_the_budget_is_released_to_queued_not_failed(monkeypatch):
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0.1")
    db, failed, finished = _FakeDB(), [], []

    async def job(job_id):
        drain.request("SIGTERM")
        await asyncio.sleep(30)
        finished.append(job_id)

    _wire(monkeypatch, db, job, failed)
    t0 = time.monotonic()
    assert asyncio.run(consumer.claim_and_run()) is True
    assert time.monotonic() - t0 < 5, "the budget did not bound the job"
    assert finished == [] and failed == [], "a drained job must not be failed or refunded"
    [(sql, params)] = db.releases()
    assert params[0] == "job-1"
    # Only an in-flight job moves; a finished or failed one keeps its state.
    assert set(params[1]) == {"downloading", "separating", "extracting", "uploading"}
    assert "status = ANY" in sql
    assert "attempts" not in sql, "a restart is not a failed attempt"


def test_budget_counts_from_the_signal_not_from_the_claim(monkeypatch):
    """A signal received BEFORE the job reached its budget block still bounds it."""
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0.1")
    db, failed = _FakeDB(), []

    async def job(_job_id):
        await asyncio.sleep(30)

    async def scenario():
        asyncio.get_running_loop().call_later(0.05, drain.request, "SIGINT")
        return await consumer.claim_and_run()

    _wire(monkeypatch, db, job, failed)
    t0 = time.monotonic()
    assert asyncio.run(scenario()) is True
    assert time.monotonic() - t0 < 5
    assert len(db.releases()) == 1 and failed == []


def test_wall_deadline_is_still_a_failure_not_a_release(monkeypatch):
    """The drain branch must not swallow the per-job wall deadline (QA C-06)."""
    monkeypatch.setenv("JOB_WALL_TIMEOUT_SECONDS", "0.1")
    db, failed, restarts = _FakeDB(), [], []

    async def job(_job_id):
        await asyncio.sleep(30)

    _wire(monkeypatch, db, job, failed)
    monkeypatch.setattr(consumer, "_restart_process", lambda: restarts.append(1))
    assert asyncio.run(consumer.claim_and_run()) is True
    assert failed == [("job-1", "INTERNAL_ERROR")] and restarts == [1]
    assert db.releases() == []


def test_pipeline_timeout_error_is_still_a_failure(monkeypatch):
    """A TimeoutError raised BY the pipeline while draining is the pipeline's, not ours."""
    db, failed = _FakeDB(), []

    async def job(_job_id):
        drain.request("SIGTERM")
        raise TimeoutError("socket timed out")

    _wire(monkeypatch, db, job, failed)
    assert asyncio.run(consumer.claim_and_run()) is True
    assert failed == [("job-1", "INTERNAL_ERROR")] and db.releases() == []


def test_release_never_raises_when_the_db_is_down(monkeypatch):
    async def boom(_url):
        raise OSError("connection refused")

    monkeypatch.setattr(
        consumer,
        "psycopg",
        types.SimpleNamespace(AsyncConnection=types.SimpleNamespace(connect=boom)),
    )
    assert asyncio.run(consumer.release_for_drain("job-1")) is False


def test_release_of_a_job_no_longer_in_flight_is_a_noop(monkeypatch):
    db = _FakeDB(release_row=None)
    monkeypatch.setattr(consumer, "psycopg", db.module)
    assert asyncio.run(consumer.release_for_drain("job-1")) is False


# --------------------------------------------------------------------------- poll_loop


def _quiet_startup(monkeypatch):
    async def nothing():
        return 0

    monkeypatch.setattr(consumer.tmpdirs, "sweep_stale", lambda: 0)
    monkeypatch.setattr(consumer, "reap_stale_jobs", nothing)
    monkeypatch.setattr(consumer, "reap_stale_requests", nothing)
    monkeypatch.setattr(consumer, "sweep_expired", nothing)
    monkeypatch.setattr(consumer, "start_r2_lifecycle_check", lambda: None)
    monkeypatch.setattr(consumer, "start_artifact_audit", lambda: None)
    monkeypatch.setattr(consumer, "start_fetch_canary", lambda: None)


def test_poll_loop_returns_after_the_job_in_hand_and_cuts_nothing(monkeypatch):
    _quiet_startup(monkeypatch)
    calls = {"jobs": 0, "cuts": 0}

    async def a_job():
        calls["jobs"] += 1
        drain.request("SIGTERM")  # arrives while this job runs
        return True

    async def a_cut():
        calls["cuts"] += 1
        return True

    monkeypatch.setattr(consumer, "claim_and_run", a_job)
    monkeypatch.setattr(consumer, "claim_and_cut", a_cut)

    async def bounded():
        await asyncio.wait_for(consumer.poll_loop(), timeout=5)

    asyncio.run(bounded())
    assert calls == {"jobs": 1, "cuts": 0}


def test_idle_poll_loop_returns_on_drain(monkeypatch):
    _quiet_startup(monkeypatch)

    async def nothing():
        return False

    monkeypatch.setattr(consumer, "claim_and_run", nothing)
    monkeypatch.setattr(consumer, "claim_and_cut", nothing)
    monkeypatch.setattr(consumer, "POLL_INTERVAL", 0.01)

    async def scenario():
        asyncio.get_running_loop().call_later(0.05, drain.request, "SIGINT")
        await asyncio.wait_for(consumer.poll_loop(), timeout=5)

    asyncio.run(scenario())


def test_signal_during_an_empty_claim_starts_no_loop_cut(monkeypatch):
    """Review F-2: the drain arrives while `claim_and_run` finds no job. The loop-cut claim
    that would normally follow must not start either."""
    _quiet_startup(monkeypatch)
    calls = {"jobs": 0, "cuts": 0}

    async def no_job_but_a_signal():
        calls["jobs"] += 1
        drain.request("SIGTERM")
        return False

    async def a_cut():
        calls["cuts"] += 1
        return True

    monkeypatch.setattr(consumer, "claim_and_run", no_job_but_a_signal)
    monkeypatch.setattr(consumer, "claim_and_cut", a_cut)

    async def bounded():
        await asyncio.wait_for(consumer.poll_loop(), timeout=5)

    asyncio.run(bounded())
    assert calls == {"jobs": 1, "cuts": 0}


def test_signal_during_the_claim_still_bounds_the_job(monkeypatch):
    """Review F-2: the signal lands AFTER claim_and_run's own drain check (here: inside the
    claim's DB round trip) but BEFORE the job's budget block is entered. The budget must arm
    on entry, or the job runs unbounded into Fly's SIGKILL."""
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0.1")
    db, failed = _FakeDB(), []
    real_connect = db.module.AsyncConnection.connect

    async def connect_then_signal(url):
        conn = await real_connect(url)
        if db.connects == 1:  # the claim, not the release
            drain.request("SIGTERM")
        return conn

    async def job(_job_id):
        await asyncio.sleep(30)

    _wire(monkeypatch, db, job, failed)
    monkeypatch.setattr(
        consumer,
        "psycopg",
        types.SimpleNamespace(AsyncConnection=types.SimpleNamespace(connect=connect_then_signal)),
    )
    t0 = time.monotonic()
    assert asyncio.run(consumer.claim_and_run()) is True
    assert time.monotonic() - t0 < 5, "a signal received before the budget block was ignored"
    assert len(db.releases()) == 1 and failed == []


def test_budget_entered_after_the_signal_expires_on_schedule(monkeypatch):
    """The arm-on-entry half of `_Budget`, without the consumer around it."""
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0.05")

    async def scenario():
        drain.request("SIGTERM")
        b = drain.budget()
        with pytest.raises(TimeoutError):
            async with b:
                await asyncio.sleep(5)
        assert b.expired()

    t0 = time.monotonic()
    asyncio.run(scenario())
    assert time.monotonic() - t0 < 2


# --------------------------------------------------------------------------- Klangio (F-3)


def test_no_klangio_claim_once_abandoned(monkeypatch):
    """Review F-3: once the budget is spent no new paid POST starts, and the sentinel is not
    written (the rerun must be free to submit)."""

    def no_db():
        raise AssertionError("the claim touched the database after the budget was spent")

    monkeypatch.setattr(pipeline, "_db", no_db)
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0")
    drain.request("SIGTERM")
    with pytest.raises(pipeline._ChordSubmitAbandonedForDrain):
        pipeline._KlangioJobLedger("job-1").claim()


def test_abandoned_chord_stage_writes_no_tombstone_and_no_sentry(monkeypatch, tmp_path):
    """The chord hook treats the abandon as 'the rerun will do it', not as a failure."""
    from worker import chord_source

    tombstones, captured, posts = [], [], []
    audio = tmp_path / "other.wav"
    audio.write_bytes(b"x")

    class _Provider:
        def recognize(self, _path, stem, ledger):
            ledger.claim()  # what klangio._submit does before its POST
            posts.append(stem)
            raise AssertionError("POST reached")

    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setattr(pipeline, "_existing_play_chords", lambda _j: False)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: None)
    monkeypatch.setattr(pipeline, "_choose_chord_input", lambda *a, **k: ("other", str(audio)))
    monkeypatch.setattr(pipeline, "_write_chords_tombstone", lambda *a, **k: tombstones.append(a))
    monkeypatch.setattr(
        pipeline.sentry_sdk, "capture_exception", lambda *a, **k: captured.append(a)
    )
    monkeypatch.setattr(pipeline, "_db", lambda: (_ for _ in ()).throw(AssertionError("db")))
    monkeypatch.setattr(chord_source, "get_chord_source", lambda _name: _Provider())
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0")
    drain.request("SIGTERM")
    pipeline._maybe_run_chord_recognition("job-1", {"other": str(audio)}, ["other"])
    assert posts == [] and tombstones == [] and captured == []


# --------------------------------------------------------------------------- retain_stems


def test_retain_stems_stops_without_a_sentry_report_once_abandoned(monkeypatch, tmp_path):
    """The incident's "stem retention incomplete 1/6" was the orphaned retention thread
    reporting the files the drain had deleted. Once abandoned it uploads and reports nothing."""
    uploads, reports = [], []
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a: uploads.append(a))
    monkeypatch.setattr(pipeline, "_encode_stem_opus", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_message", lambda *a, **k: reports.append(a))
    stems = {}
    for name in pipeline.ALL_STEMS:
        p = tmp_path / f"{name}.wav"
        p.write_bytes(b"x")
        stems[name] = str(p)
    monkeypatch.setenv("WORKER_DRAIN_SECONDS", "0")
    drain.request("SIGTERM")
    report = pipeline.retain_stems("job-1", stems)
    assert report["abandoned"] is True and report["complete"] is False
    assert uploads == [] and reports == []


def test_retain_stems_unchanged_when_not_draining(monkeypatch, tmp_path):
    uploads, reports = [], []
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a: uploads.append(a))
    monkeypatch.setattr(pipeline, "_encode_stem_opus", lambda *a, **k: a[0])
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_message", lambda *a, **k: reports.append(a))
    stems = {}
    for name in pipeline.ALL_STEMS:
        p = tmp_path / f"{name}.wav"
        p.write_bytes(b"x")
        stems[name] = str(p)
    report = pipeline.retain_stems("job-1", stems)
    assert report["complete"] is True and "abandoned" not in report
    assert len(uploads) == 2 * len(pipeline.ALL_STEMS) and reports == []


# --------------------------------------------------------------------------- config / uvicorn


def test_fly_kill_timeout_fits_the_drain_budget():
    cfg = tomllib.loads((WORKER_DIR / "fly.toml").read_text())
    kill_timeout = cfg["kill_timeout"]
    assert isinstance(kill_timeout, int), "keep kill_timeout in plain seconds"
    # Fly's documented maximum (fly.io/docs/blueprints/long-running-tasks).
    assert kill_timeout <= shutdown.FLY_MAX_KILL_TIMEOUT_S == 300
    assert kill_timeout >= shutdown.DRAIN_BUDGET_DEFAULT + shutdown.DRAIN_EXIT_MARGIN_S
    # A typical job is 2-4 minutes; a budget under 4 min would release most of them.
    assert shutdown.DRAIN_BUDGET_DEFAULT >= 240
    from worker import main

    assert cfg["kill_signal"] in {s.name for s in main.DRAIN_SIGNALS}


def test_uvicorn_still_routes_serve_through_capture_signals():
    """`main._Server` disables uvicorn's signal capture by overriding `capture_signals`. If a
    uvicorn upgrade renamed it, the override would be dead and the KeyboardInterrupt back."""
    assert "self.capture_signals()" in inspect.getsource(uvicorn.Server.serve)


def test_server_leaves_the_process_signal_handlers_alone():
    from worker import main

    def mine(*_):
        return None

    old = signal.signal(signal.SIGTERM, mine)
    try:
        server = main._Server(uvicorn.Config(main.app))
        with server.capture_signals():
            assert signal.getsignal(signal.SIGTERM) is mine
        assert server._captured_signals == []
    finally:
        signal.signal(signal.SIGTERM, old)


# --------------------------------------------------------------------------- real signals

_HARNESS = textwrap.dedent("""
    import asyncio, sys, time, types
    import uvicorn
    from worker import consumer, main

    STOCK = sys.argv[1] == "stock"
    JOB_S = float(sys.argv[2])
    # "thread": the job blocks a worker THREAD, as every real pipeline stage does
    # (asyncio.to_thread). A drain cannot cancel it, only orphan it -- which is why main.py
    # exits with os._exit: a plain return would join that thread in asyncio.run's teardown.
    IN_THREAD = sys.argv[3] == "thread"
    if STOCK:
        # main.serve exactly as it was before QA-63.
        async def _old_serve():
            config = main.uvicorn.Config(main.app, host="0.0.0.0", port=8000, log_level="info")
            server = uvicorn.Server(config)
            await asyncio.gather(server.serve(), consumer.poll_loop())
        main.serve = _old_serve

    _Config = uvicorn.Config
    main.uvicorn = types.SimpleNamespace(
        Config=lambda app, **kw: _Config(app, host="127.0.0.1", port=0, log_level="warning"),
        Server=uvicorn.Server,
    )

    released = []

    class _Cur:
        def __init__(self, row): self._row = row
        async def fetchone(self): return self._row

    class _Conn:
        claimed = False
        async def __aenter__(self): return self
        async def __aexit__(self, *e): return False
        async def commit(self): pass
        async def execute(self, sql, params=None):
            if "status='downloading'" in sql:
                row = None if _Conn.claimed else ("job-1",)
                _Conn.claimed = True
                return _Cur(row)
            released.append(params[0])
            print("RELEASED", params[0], flush=True)
            return _Cur(("job-1",))

    async def connect(_url): return _Conn()
    consumer.psycopg = types.SimpleNamespace(
        AsyncConnection=types.SimpleNamespace(connect=connect))

    async def brake(_url): return types.SimpleNamespace(engaged=False)
    async def nothing(*a, **k): return 0
    async def no_cut(): return False
    async def failed(job_id, code, msg): print("FAILED", job_id, code, flush=True)

    async def pipeline(job_id):
        print("JOB_STARTED", flush=True)
        if IN_THREAD:
            await asyncio.to_thread(time.sleep, JOB_S)
        else:
            await asyncio.sleep(JOB_S)
        print("JOB_FINISHED", flush=True)

    consumer.brake_state = brake
    consumer.run_pipeline = pipeline
    consumer.mark_failed = failed
    consumer.claim_and_cut = no_cut
    consumer.reap_stale_jobs = nothing
    consumer.reap_stale_requests = nothing
    consumer.sweep_expired = nothing
    consumer.tmpdirs.sweep_stale = lambda: 0
    consumer.start_r2_lifecycle_check = lambda: None
    consumer.start_artifact_audit = lambda: None
    consumer.start_fetch_canary = lambda: None
    consumer.POLL_INTERVAL = 0.05

    asyncio.run(main._run())
    print("RETURNED_NORMALLY", flush=True)
""")


def _run_harness(sig, *, mode="drain", job_s=1.0, drain_s="270", in_thread=False):
    env = {
        **os.environ,
        "WORKER_DRAIN_SECONDS": drain_s,
        "FETCH_CANARY_INTERVAL_SECONDS": "0",
        "PYTHONPATH": str(WORKER_DIR / "src"),
    }
    env.pop("SENTRY_DSN", None)
    env.pop("DATABASE_URL", None)
    proc = subprocess.Popen(
        [sys.executable, "-c", _HARNESS, mode, str(job_s), "thread" if in_thread else "loop"],
        cwd=WORKER_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    # Bounded wait: a worker that never starts its poll loop must FAIL here, not hang.
    ready, _, _ = select.select([proc.stdout], [], [], 30)
    if not ready:
        proc.kill()
        _, err = proc.communicate()
        pytest.fail("the worker never started a job (is main.serve running poll_loop?)\n" + err)
    line = proc.stdout.readline()
    if line.strip() != "JOB_STARTED":
        proc.kill()
        out, err = proc.communicate()
        pytest.fail(f"expected JOB_STARTED, got {line!r}\n{out}\n{err}")
    time.sleep(0.2)  # the signal lands mid-job, as a deploy's does
    proc.send_signal(sig)
    try:
        out, err = proc.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        pytest.fail(f"the worker did not exit within 60 s of {sig!r}\n{out}\n{err}")
    return proc.returncode, line + out, err


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM], ids=["SIGINT", "SIGTERM"])
def test_signal_mid_job_finishes_the_job_and_exits_zero(sig):
    code, out, err = _run_harness(sig, job_s=1.0)
    assert code == 0, (code, out, err)
    assert "JOB_FINISHED" in out
    assert "RELEASED" not in out and "FAILED" not in out
    assert "KeyboardInterrupt" not in err and "Traceback" not in err, err
    assert "worker_exit_drained" in err


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM], ids=["SIGINT", "SIGTERM"])
def test_signal_mid_long_job_releases_it_and_exits_zero(sig):
    # The job holds a worker thread for 60 s (review F-1). Exiting well inside the 60 s
    # communicate() timeout proves the orphaned thread is not joined on the way out.
    t0 = time.monotonic()
    code, out, err = _run_harness(sig, job_s=60.0, drain_s="0.5", in_thread=True)
    assert time.monotonic() - t0 < 30, "the exit waited on the orphaned pipeline thread"
    assert code == 0, (code, out, err)
    assert "RELEASED job-1" in out
    assert "JOB_FINISHED" not in out and "FAILED" not in out
    assert "KeyboardInterrupt" not in err and "Traceback" not in err, err


def test_harness_sees_the_bug_with_stock_uvicorn():
    """Control: with the pre-QA-63 `main.serve` restored, SIGINT reproduces the incident
    (the job never finishes; KeyboardInterrupt, non-zero exit). If this ever passes clean,
    the two tests above are no longer evidence of anything."""
    code, out, err = _run_harness(signal.SIGINT, mode="stock", job_s=5.0)
    assert code != 0
    assert "JOB_FINISHED" not in out
    assert "KeyboardInterrupt" in err
