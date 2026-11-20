"""Every path that gives up on a job returns its credit, exactly once (QA C-05 / C-06, 2026-11-18).

Before this fix only ``pipeline._fail`` refunded. Reproduced on a scratch PG by
/home/claude/s17/qa/c_states.py:

  C-05  ``reap_stale_jobs`` failed a credit-funded job that had run out of attempts
        (INTERNAL_ERROR, our fault) and wrote 0 credit_adjustments rows.
  C-06  a job queued while the spend brake was engaged stayed ``queued``; at expires_at + 1 h
        the retention sweep deleted or anonymised it, never failed, never refunded.
  C-06  no per-job wall-clock budget: a hung stage blocked the inline queue indefinitely, and
        the stem download's per-read timeout never tripped on a slow trickle.

Each test asserts the state transition AND exactly one refund row (provider
'worker_job_failed', the same key the pipeline path uses), and re-runs the path to prove a
second pass cannot refund twice.

Local throwaway DB only (INSERTs into auth.users).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
import uuid
from pathlib import Path

import psycopg
import pytest

from worker import consumer, job_failure, pipeline, reaper
from worker.errors import InternalError
from worker.job_failure import JobNoLongerActive

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="INSERTs into auth.users; local throwaway DB only")

EMAIL_PREFIX = "test-refund-reaped-"
IP = "test-refund-reaped-ip"
# See test_failed_job_credit_refund.py: another suite can leave v_credit_balance without the
# credit_adjustments term; 023 is the full idempotent view definition. 023 also re-creates the
# one-refund-per-charge UNIQUE index that 024 dropped, so 024 is re-applied right after it to
# leave the post-024 schema (test_zz_schema_matches_fresh_migration checks this).
_MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
MIGRATION_023 = _MIGRATIONS / "023_v3_credit_adjustments.sql"
MIGRATION_024 = _MIGRATIONS / "024_v3_credit_adjustments_partial_refund_index.sql"


def _cleanup(c) -> None:
    c.rollback()
    like = f"(SELECT id FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%')"
    c.execute(f"DELETE FROM public.credit_adjustments WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.credit_purchases WHERE user_id IN {like}")
    c.execute("DELETE FROM public.jobs WHERE client_ip_hash = %s", (IP,))
    c.execute(f"DELETE FROM auth.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.execute(
        "INSERT INTO kill_switches(scope, enabled) VALUES ('spend_global', false) "
        "ON CONFLICT (scope) DO UPDATE SET enabled = false"
    )
    c.commit()


@pytest.fixture
def conn(monkeypatch):
    for mod in (consumer, reaper, pipeline):
        monkeypatch.setattr(mod, "DATABASE_URL", DB)
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(MIGRATION_023.read_text())
        c.execute(MIGRATION_024.read_text())
        c.commit()
        _cleanup(c)
        yield c
        _cleanup(c)


@pytest.fixture(autouse=True)
def restarts(monkeypatch) -> list[int]:
    """Record the post-deadline process exit instead of killing pytest (SF-2)."""
    calls: list[int] = []
    monkeypatch.setattr(consumer, "_restart_process", lambda: calls.append(1))
    return calls


def _user(c) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email) VALUES (%s, %s)",
        (uid, f"{EMAIL_PREFIX}{uid.hex[:8]}@example.test"),
    )
    c.execute(
        "INSERT INTO public.credit_purchases (user_id, provider, provider_charge_id, pack_code,"
        " credits_granted, amount_cad_cents) VALUES (%s, 'stripe', %s, 'credits_20', 20, 1000)",
        (uid, f"ch_{uid.hex}"),
    )
    c.commit()
    return uid


def _job(
    c,
    uid: uuid.UUID | None,
    status: str,
    *,
    attempts: int = 0,
    stale_s: int = 0,
    pred: str | None = "pred_paid",
    charge: bool = True,
) -> uuid.UUID:
    jid = uuid.uuid4()
    c.execute(
        "INSERT INTO public.jobs (id, input_kind, upload_r2_key, status, user_id,"
        " replicate_prediction_id, loop_length_bars, requested_stems, client_ip_hash,"
        " attempts, updated_at)"
        " VALUES (%s, 'upload', %s, %s, %s, %s, 4, ARRAY['drums'], %s, %s,"
        "         now() - (%s * interval '1 second'))",
        (jid, f"{jid}/_input.mp3", status, uid, pred, IP, attempts, stale_s),
    )
    if charge and uid is not None:
        c.execute(
            "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)", (uid, jid)
        )
    c.commit()
    return jid


def _state(c, jid) -> tuple[str, str | None]:
    c.commit()
    return c.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone()


def _refunds(c, jid) -> list[tuple]:
    c.commit()
    return c.execute(
        "SELECT credits_delta, reason, provider FROM public.credit_adjustments"
        " WHERE provider_event_id=%s",
        (str(jid),),
    ).fetchall()


def _balance(c, uid) -> int:
    c.commit()
    return c.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id=%s", (uid,)
    ).fetchone()[0]


ONE_REFUND = [(1, "adjustment", "worker_job_failed")]


def _reap() -> dict[str, int]:
    return asyncio.run(reaper.reap_stale_jobs())


# --------------------------------------------------------------------------- C-05: the reaper
def test_a_reaped_poison_job_is_failed_and_refunded_exactly_once(conn):
    uid = _user(conn)
    jid = _job(
        conn, uid, "separating", attempts=reaper.MAX_ATTEMPTS, stale_s=reaper.STALE_SECONDS + 60
    )
    assert _balance(conn, uid) == 19
    assert _reap()["failed"] >= 1
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == ONE_REFUND, "the reaper failed the job and kept the credit"
    assert _balance(conn, uid) == 20
    # A second reap, and the pipeline's own failure path on the same job, refund nothing more.
    _reap()
    asyncio.run(pipeline._fail(str(jid), "INTERNAL_ERROR", "msg"))
    asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", "msg"))
    assert _refunds(conn, jid) == ONE_REFUND
    assert _balance(conn, uid) == 20


def test_a_job_the_reaper_requeues_is_not_refunded(conn):
    uid = _user(conn)
    jid = _job(conn, uid, "extracting", attempts=0, stale_s=reaper.STALE_SECONDS + 60)
    _reap()
    assert _state(conn, jid) == ("queued", None)
    assert _refunds(conn, jid) == []
    assert _balance(conn, uid) == 19


def test_a_reaped_job_that_spent_no_credit_gets_no_adjustment(conn):
    uid = _user(conn)
    jid = _job(
        conn,
        uid,
        "uploading",
        attempts=reaper.MAX_ATTEMPTS,
        stale_s=reaper.STALE_SECONDS + 60,
        charge=False,
    )
    _reap()
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == []


# ------------------------------------------------- C-06: queued behind the brake past retention
def test_a_job_queued_behind_the_brake_past_retention_is_failed_and_refunded(conn):
    uid = _user(conn)
    conn.execute("UPDATE kill_switches SET enabled = true WHERE scope = 'spend_global'")
    conn.commit()
    # pred set: a paid separation already happened on an earlier attempt, so only an
    # our-fault STORED code refunds it (kills a user-fault code in this branch, review R3).
    jid = _job(conn, uid, "queued", pred="pred_paid")
    # The brake holds it: the consumer claims nothing.
    assert asyncio.run(consumer.claim_and_run()) is False
    assert _state(conn, jid) == ("queued", None)
    # 30 h later (c_states.py step 4): past expires_at, before the sweep's +1 h in-flight grace.
    conn.execute(
        "UPDATE jobs SET created_at = now() - interval '30 hours',"
        " expires_at = now() - interval '6 hours' WHERE id = %s",
        (jid,),
    )
    conn.commit()
    result = _reap()
    assert result["expired_queued"] >= 1
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    msg = conn.execute("SELECT error_message_user FROM jobs WHERE id=%s", (jid,)).fetchone()[0]
    assert "couldn't start processing" in msg
    assert _refunds(conn, jid) == ONE_REFUND
    assert _balance(conn, uid) == 20
    _reap()
    assert _refunds(conn, jid) == ONE_REFUND


def test_a_queued_job_inside_its_retention_is_left_waiting(conn):
    """However stale its updated_at, a queued job inside its TTL is waiting, not abandoned."""
    uid = _user(conn)
    jid = _job(conn, uid, "queued", stale_s=10**6)
    _reap()
    assert _state(conn, jid) == ("queued", None)
    assert _refunds(conn, jid) == []


def test_terminal_jobs_past_retention_are_not_touched(conn):
    uid = _user(conn)
    done = _job(conn, uid, "done")
    conn.execute("UPDATE jobs SET expires_at = now() - interval '6 hours' WHERE id = %s", (done,))
    conn.commit()
    _reap()
    assert _state(conn, done) == ("done", None)
    assert _refunds(conn, done) == []


# ------------------------------------------------------ C-06: per-job wall-clock deadline
def _claimable(c, uid) -> uuid.UUID:
    """A queued credit-funded job, oldest in the table so claim_and_run takes it first."""
    jid = _job(c, uid, "queued")
    c.execute("UPDATE jobs SET created_at = '2000-01-01T00:00:00Z' WHERE id = %s", (jid,))
    c.commit()
    return jid


@pytest.mark.parametrize("hang", ["coroutine", "thread"])
def test_a_hung_job_is_failed_and_refunded_at_the_wall_clock_deadline(
    conn, monkeypatch, restarts, hang
):
    uid = _user(conn)
    jid = _claimable(conn, uid)
    monkeypatch.setenv("JOB_WALL_TIMEOUT_SECONDS", "0.5")

    async def hung_pipeline(job_id: str) -> None:
        if hang == "coroutine":
            await asyncio.sleep(5)  # bounded, so a regression fails instead of hanging
        else:  # a worker thread that never returns in time (the _fetch_stems trickle)
            await asyncio.to_thread(time.sleep, 3)

    monkeypatch.setattr(consumer, "run_pipeline", hung_pipeline)

    async def claim_timed() -> tuple[bool, float]:
        # Timed inside the loop: asyncio.run's teardown joins the abandoned worker thread,
        # which production's never-ending poll loop does not do.
        t0 = time.monotonic()
        return await consumer.claim_and_run(), time.monotonic() - t0

    claimed, elapsed = asyncio.run(claim_timed())
    assert claimed is True
    assert elapsed < 2.5, "the deadline did not bound the job"
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    msg = conn.execute("SELECT error_message_user FROM jobs WHERE id=%s", (jid,)).fetchone()[0]
    assert msg == consumer.JOB_WALL_TIMEOUT_MESSAGE
    assert _refunds(conn, jid) == ONE_REFUND
    assert _balance(conn, uid) == 20
    # SF-2: the abandoned thread is reclaimed by restarting the process, AFTER the commit.
    assert restarts == [1]


def test_the_default_wall_clock_budget_is_ninety_minutes(monkeypatch):
    """At least the web's ONE_JOB_WORST_CASE_S (3962 s since #317, 4442 s before; deployed values): a healthy job is
    never cut off. The cross-check against job-poll.ts is in job-stall-derivation.test.mjs."""
    monkeypatch.delenv("JOB_WALL_TIMEOUT_SECONDS", raising=False)
    assert consumer._job_wall_timeout() == 5400.0
    for bad in ("0", "-5", "inf", "nan", "abc"):
        monkeypatch.setenv("JOB_WALL_TIMEOUT_SECONDS", bad)
        assert consumer._job_wall_timeout() == 5400.0, bad


def test_an_exception_escaping_the_pipeline_is_refunded_by_the_consumer(
    conn, monkeypatch, restarts
):
    """consumer.mark_failed used to write status='failed' with no refund."""
    uid = _user(conn)
    jid = _claimable(conn, uid)

    async def broken_pipeline(job_id: str) -> None:
        raise RuntimeError("escaped the pipeline's own handlers")

    monkeypatch.setattr(consumer, "run_pipeline", broken_pipeline)
    assert asyncio.run(consumer.claim_and_run()) is True
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == ONE_REFUND
    assert restarts == [], "only the wall deadline restarts the process"


def test_a_timeout_raised_by_the_pipeline_is_not_reported_as_the_wall_deadline(conn, monkeypatch):
    """socket.timeout IS TimeoutError: it must not be mistaken for our own deadline."""
    uid = _user(conn)
    jid = _claimable(conn, uid)

    async def socket_timeout(job_id: str) -> None:
        raise TimeoutError("timed out")

    monkeypatch.setattr(consumer, "run_pipeline", socket_timeout)
    assert asyncio.run(consumer.claim_and_run()) is True
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    msg = conn.execute("SELECT error_message_user FROM jobs WHERE id=%s", (jid,)).fetchone()[0]
    assert msg == InternalError.user_message
    assert _refunds(conn, jid) == ONE_REFUND


@pytest.mark.parametrize("pred", ["pred_paid", None])
def test_a_finished_job_is_never_failed_or_refunded(conn, pred):
    """pred=None matters: with no paid call the no-spend rule alone would refund it, so only
    the `status = 'failed'` condition in REFUND_SQL protects a delivered job."""
    uid = _user(conn)
    jid = _job(conn, uid, "done", pred=pred)
    marked = asyncio.run(job_failure.fail_job(DB, str(jid), "INTERNAL_ERROR", "late deadline"))
    assert marked is False
    assert _state(conn, jid) == ("done", None)
    assert _refunds(conn, jid) == []


# ------------------------------------------------ C-06: total-time cap on a stem download
# The real-socket trickle test moved to test_worker_input_hardening.py (#300 review R3-1,
# QA-54). Here it served http://127.0.0.1, which the B-09 allow-list refuses before any
# fetch, so it passed without exercising the deadline; and this module skips without a DB,
# while that test needs none.


def test_the_default_stem_download_budget_is_nine_minutes(monkeypatch):
    monkeypatch.delenv("STEM_FETCH_DEADLINE_SEC", raising=False)
    assert pipeline._stem_fetch_deadline_sec() == 540.0


# ------------------------------------------- review MF-1: a zombie run never resurrects a job
def _poison(c, uid) -> uuid.UUID:
    return _job(
        c, uid, "separating", attempts=reaper.MAX_ATTEMPTS, stale_s=reaper.STALE_SECONDS + 60
    )


def test_a_live_run_cannot_overwrite_a_reaper_failure(conn):
    """Second machine / deploy overlap: the reaper fails and refunds a job whose run is still
    alive. That run's next status write must not resurrect it (result AND credit)."""
    uid = _user(conn)
    jid = _poison(conn, uid)
    _reap()
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    for status in ("extracting", "uploading", "done"):
        with pytest.raises(JobNoLongerActive):
            asyncio.run(pipeline.set_status(str(jid), status))
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == ONE_REFUND
    assert _balance(conn, uid) == 20


def test_set_status_never_reopens_a_finished_job(conn):
    uid = _user(conn)
    jid = _job(conn, uid, "done")
    with pytest.raises(JobNoLongerActive):
        asyncio.run(pipeline.set_status(str(jid), "extracting"))
    assert _state(conn, jid) == ("done", None)


class _Harness:
    """Runs the REAL pipeline._run_pipeline with every external stage faked (no audio, no
    Replicate, no R2), recording which stages ran and whether a heartbeat was held."""

    def __init__(self, monkeypatch, on_extract=None):
        self.ran: list[str] = []
        self.beating: list[str] = []
        self._active = 0
        mp = monkeypatch
        mp.delenv("STUB_MODE", raising=False)
        mp.delenv("STEMLOOPS_AUDIO_URL", raising=False)
        mp.delenv("STEMLOOPS_AUDIO_FILE", raising=False)
        mp.setattr(
            pipeline,
            "_fetch_job",
            lambda jid: (None, ["drums"], 4, "upload", f"{jid}/_input.mp3", "song.mp3"),
        )
        mp.setattr(pipeline, "_prepare_upload_source", lambda jid, key: ("https://in", None))
        mp.setattr(pipeline, "_record_title", lambda jid, title: None)
        mp.setattr(pipeline, "submit_or_reattach", lambda jid, src: "pred_h")
        mp.setattr(pipeline, "poll_until_done", lambda jid, pred: ({"drums": "u"}, 0.01))
        mp.setattr(pipeline, "_fetch_stems", self._stage("fetch_stems", {"drums": "/x"}))

        def extract(*a):
            self._note("extract")
            if on_extract:
                on_extract()
            return [], {}, None, None

        mp.setattr(pipeline, "extract_and_tag", extract)
        mp.setattr(pipeline, "_maybe_run_chord_recognition", self._stage("chords", None))
        mp.setattr(pipeline, "record_loops", self._stage("record_loops", 0))
        mp.setattr(pipeline, "retain_stems", self._stage("retain_stems", {}))

        @contextlib.asynccontextmanager
        async def heartbeat(job_id):
            self._active += 1
            try:
                yield
            finally:
                self._active -= 1

        mp.setattr(pipeline, "_stage_heartbeat", heartbeat)

    def _note(self, name):
        self.ran.append(name)
        if self._active:
            self.beating.append(name)

    def _stage(self, name, result):
        def f(*a, **k):
            self._note(name)
            return result

        return f


def test_the_real_pipeline_holds_a_heartbeat_through_stem_download_and_extraction(
    conn, monkeypatch
):
    """Review SF-3 (R1/R2): neither stage bumps updated_at itself, and a 540 s stem budget
    outlasts the reaper's 300 s stale window: without the heartbeat a second machine's reaper
    requeues a LIVE job and the rerun pays again."""
    uid = _user(conn)
    jid = _job(conn, uid, "downloading", pred=None)
    h = _Harness(monkeypatch)
    asyncio.run(pipeline.run_pipeline(str(jid)))
    assert _state(conn, jid) == ("done", None)
    assert h.ran == ["fetch_stems", "extract", "chords", "record_loops", "retain_stems"]
    assert {"fetch_stems", "extract"} <= set(h.beating), h.beating
    assert _refunds(conn, jid) == []


def test_the_real_pipeline_stops_writing_once_the_reaper_has_failed_the_job(conn, monkeypatch):
    """MF-1 end to end: the reaper fails and refunds the job while extraction is running.
    The run stops at its next status write: no loops recorded, never 'done', one refund."""
    uid = _user(conn)
    jid = _job(conn, uid, "downloading")

    def reaper_strikes():
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            c.execute(
                "UPDATE jobs SET attempts=%s, updated_at=now() - interval '1 hour' WHERE id=%s",
                (reaper.MAX_ATTEMPTS, jid),
            )
            c.commit()
        asyncio.run(reaper.reap_stale_jobs())  # this worker thread has no running loop

    h = _Harness(monkeypatch, on_extract=reaper_strikes)
    with pytest.raises(JobNoLongerActive):
        asyncio.run(pipeline.run_pipeline(str(jid)))
    assert "record_loops" not in h.ran and "retain_stems" not in h.ran, h.ran
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == ONE_REFUND
    assert _balance(conn, uid) == 20


def test_the_consumer_treats_a_zombie_run_as_finished_not_failed(conn, monkeypatch, restarts):
    uid = _user(conn)
    jid = _claimable(conn, uid)

    async def zombie(job_id: str) -> None:
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            c.execute(
                "UPDATE jobs SET status='failed', error_code='EXTRACTION_FAILED' WHERE id=%s",
                (job_id,),
            )
            c.commit()
        await pipeline.set_status(job_id, "done")

    monkeypatch.setattr(consumer, "run_pipeline", zombie)
    assert asyncio.run(consumer.claim_and_run()) is True
    assert _state(conn, jid) == ("failed", "EXTRACTION_FAILED")
    assert _refunds(conn, jid) == []
    assert restarts == []


# --------------------------------- review SF-1: the first failure wins, refund reads the row
def test_a_user_fault_failure_refailed_as_ours_is_not_refunded(conn):
    uid = _user(conn)
    jid = _job(conn, uid, "extracting")  # paid separation happened
    asyncio.run(pipeline._fail(str(jid), "EXTRACTION_FAILED", "too short"))
    assert _refunds(conn, jid) == []
    asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", "deadline"))
    assert _state(conn, jid) == ("failed", "EXTRACTION_FAILED"), "the first failure must win"
    assert _refunds(conn, jid) == []
    assert _balance(conn, uid) == 19


def test_the_deadline_firing_inside_a_user_fault_failure_does_not_refund(
    conn, monkeypatch, restarts
):
    uid = _user(conn)
    jid = _claimable(conn, uid)  # pred_paid
    monkeypatch.setenv("JOB_WALL_TIMEOUT_SECONDS", "0.5")

    async def fails_at_the_deadline(job_id: str) -> None:
        await asyncio.sleep(0.3)
        async with await psycopg.AsyncConnection.connect(DB) as c:  # type: ignore[arg-type]
            await c.execute(job_failure._FAIL_SQL, ("EXTRACTION_FAILED", "too short", job_id))
            await c.commit()
        await asyncio.sleep(1)  # the deadline lands here, before pipeline._fail's refund step
        async with await psycopg.AsyncConnection.connect(DB) as c:  # type: ignore[arg-type]
            await job_failure.refund_if_owed(c, job_id)
            await c.commit()

    monkeypatch.setattr(consumer, "run_pipeline", fails_at_the_deadline)
    asyncio.run(consumer.claim_and_run())
    assert _state(conn, jid) == ("failed", "EXTRACTION_FAILED")
    assert _refunds(conn, jid) == []
    assert _balance(conn, uid) == 19


def test_a_refund_that_errored_is_retried_by_a_later_failure_path(conn, monkeypatch):
    uid = _user(conn)
    jid = _job(conn, uid, "uploading")
    real = job_failure.refund_if_owed

    async def broken(c, job_id):
        raise psycopg.errors.QueryCanceled("simulated")

    monkeypatch.setattr(job_failure, "refund_if_owed", broken)
    asyncio.run(pipeline._fail(str(jid), "UPLOAD_FAILED", "r2 down"))
    assert _state(conn, jid) == ("failed", "UPLOAD_FAILED")
    assert _refunds(conn, jid) == []
    monkeypatch.setattr(job_failure, "refund_if_owed", real)
    asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", "again"))
    assert _state(conn, jid) == ("failed", "UPLOAD_FAILED")
    assert _refunds(conn, jid) == ONE_REFUND


def test_the_deadline_after_done_leaves_the_job_done_and_unrefunded(conn, monkeypatch, restarts):
    uid = _user(conn)
    jid = _claimable(conn, uid)
    monkeypatch.setenv("JOB_WALL_TIMEOUT_SECONDS", "0.5")

    async def done_then_linger(job_id: str) -> None:
        await pipeline.set_status(job_id, "done")
        await asyncio.sleep(3)

    monkeypatch.setattr(consumer, "run_pipeline", done_then_linger)
    asyncio.run(consumer.claim_and_run())
    assert _state(conn, jid) == ("done", None)
    assert _refunds(conn, jid) == []


# ---------------------------------------------------------- review SF-2: restart, for real
def test_the_restart_flushes_then_hard_exits_with_a_restartable_code(monkeypatch):
    """`os._exit`, not `sys.exit`: interpreter shutdown would join the hung executor thread."""
    monkeypatch.undo()  # the autouse recorder replaced _restart_process; test the real one
    events: list = []
    monkeypatch.setattr(consumer.sentry_sdk, "flush", lambda timeout: events.append("flush"))

    class _Exit(BaseException):
        pass

    def fake_exit(code):
        events.append(("exit", code))
        raise _Exit

    monkeypatch.setattr(consumer.os, "_exit", fake_exit)
    with pytest.raises(_Exit):
        consumer._restart_process()
    assert events == ["flush", ("exit", 75)]
    assert consumer.RESTART_EXIT_CODE != 0


# ---------------------------------------------------- review SF-3: reaper boundary and locks
def test_a_job_out_of_attempts_is_failed_however_long_it_has_been_stale(conn):
    """Kills `attempts < MAX` -> `<=` (R10): with a huge staleness every backoff window is
    passed, so only the bound stops a poison job being requeued forever, never refunded."""
    uid = _user(conn)
    jid = _job(conn, uid, "uploading", attempts=reaper.MAX_ATTEMPTS, stale_s=10**7)
    _reap()
    assert conn.execute("SELECT attempts FROM jobs WHERE id=%s", (jid,)).fetchone()[0] == (
        reaper.MAX_ATTEMPTS
    )
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == ONE_REFUND


def test_an_expired_queued_job_being_claimed_is_skipped_not_failed(conn):
    """Kills SKIP LOCKED removed (R4): a consumer holding the row must win, without the
    reaper blocking on it or failing a job that is about to run."""
    uid = _user(conn)
    jid = _job(conn, uid, "queued")
    conn.execute("UPDATE jobs SET expires_at = now() - interval '1 hour' WHERE id=%s", (jid,))
    conn.commit()
    with psycopg.connect(DB) as other:  # type: ignore[arg-type]
        other.execute("SET lock_timeout = '2s'")
        other.execute("SELECT id FROM jobs WHERE id=%s FOR UPDATE", (jid,)).fetchone()

        async def reap_with_lock_timeout():
            return await asyncio.wait_for(reaper.reap_stale_jobs(), timeout=5)

        assert asyncio.run(reap_with_lock_timeout())["expired_queued"] == 0
        other.execute("UPDATE jobs SET status='downloading' WHERE id=%s", (jid,))
        other.commit()
    _reap()
    assert _state(conn, jid) == ("downloading", None)
    assert _refunds(conn, jid) == []


def test_a_hard_deleted_account_with_an_expired_queued_job_is_failed_without_error(conn):
    uid = _user(conn)
    jid = _job(conn, uid, "queued")
    conn.execute("UPDATE jobs SET expires_at = created_at WHERE id=%s", (jid,))
    conn.execute("DELETE FROM credit_adjustments WHERE user_id=%s", (uid,))
    conn.execute("DELETE FROM auth.users WHERE id=%s", (uid,))
    conn.commit()
    assert _reap()["expired_queued"] >= 1
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == []


# ---------------------------------------------------- review SF-4: one savepoint per job
def test_one_bad_refund_does_not_roll_back_the_rest_of_the_batch(conn, monkeypatch):
    uid = _user(conn)
    bad = _poison(conn, uid)
    good = _poison(conn, uid)
    queued = _job(conn, uid, "queued")
    conn.execute("UPDATE jobs SET expires_at = now() - interval '1 hour' WHERE id=%s", (queued,))
    conn.commit()
    real = reaper.refund_if_owed

    async def flaky(c, job_id):
        if job_id == str(bad):
            raise psycopg.errors.ForeignKeyViolation("simulated")
        return await real(c, job_id)

    monkeypatch.setattr(reaper, "refund_if_owed", flaky)
    result = _reap()
    assert result["failed"] >= 1 and result["expired_queued"] >= 1
    # The bad job is rolled back ALONE: still in flight, so the next reap retries it.
    assert _state(conn, bad) == ("separating", None)
    assert _refunds(conn, bad) == []
    assert _state(conn, good) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, good) == ONE_REFUND
    assert _state(conn, queued) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, queued) == ONE_REFUND
    monkeypatch.setattr(reaper, "refund_if_owed", real)
    _reap()
    assert _state(conn, bad) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, bad) == ONE_REFUND
    assert _balance(conn, uid) == 20 - 3 + 3
