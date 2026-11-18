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
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
import pytest

from worker import consumer, job_failure, pipeline, reaper
from worker.errors import InternalError

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
    jid = _job(conn, uid, "queued", pred=None)
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
def test_a_hung_job_is_failed_and_refunded_at_the_wall_clock_deadline(conn, monkeypatch, hang):
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


def test_the_default_wall_clock_budget_is_thirty_minutes(monkeypatch):
    monkeypatch.delenv("JOB_WALL_TIMEOUT_SECONDS", raising=False)
    assert consumer._job_wall_timeout() == 1800.0
    for bad in ("0", "-5", "inf", "nan", "abc"):
        monkeypatch.setenv("JOB_WALL_TIMEOUT_SECONDS", bad)
        assert consumer._job_wall_timeout() == 1800.0, bad


def test_an_exception_escaping_the_pipeline_is_refunded_by_the_consumer(conn, monkeypatch):
    """consumer.mark_failed used to write status='failed' with no refund."""
    uid = _user(conn)
    jid = _claimable(conn, uid)

    async def broken_pipeline(job_id: str) -> None:
        raise RuntimeError("escaped the pipeline's own handlers")

    monkeypatch.setattr(consumer, "run_pipeline", broken_pipeline)
    assert asyncio.run(consumer.claim_and_run()) is True
    assert _state(conn, jid) == ("failed", "INTERNAL_ERROR")
    assert _refunds(conn, jid) == ONE_REFUND


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


def test_a_finished_job_is_never_failed_or_refunded(conn):
    uid = _user(conn)
    jid = _job(conn, uid, "done")
    marked = asyncio.run(job_failure.fail_job(DB, str(jid), "INTERNAL_ERROR", "late deadline"))
    assert marked is False
    assert _state(conn, jid) == ("done", None)
    assert _refunds(conn, jid) == []


# ------------------------------------------------ C-06: total-time cap on a stem download
class _Trickle(BaseHTTPRequestHandler):
    """Promises 50 MB, then sends one byte every 50 ms: every read succeeds well inside any
    per-read timeout, so only a TOTAL deadline can end it."""

    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", str(50 * 1024 * 1024))
        self.end_headers()
        try:
            while not self.server.stop.is_set():  # type: ignore[attr-defined]
                self.wfile.write(b"\0")
                self.wfile.flush()
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):  # silence
        pass


@pytest.fixture
def trickle_url():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Trickle)
    srv.stop = threading.Event()  # type: ignore[attr-defined]
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/stem.wav"
    srv.stop.set()  # type: ignore[attr-defined]
    srv.shutdown()
    srv.server_close()


def test_a_trickling_stem_download_hits_its_total_deadline(monkeypatch, trickle_url):
    monkeypatch.setenv("STEM_FETCH_DEADLINE_SEC", "1")
    box: dict = {}

    def run():
        try:
            box["result"] = pipeline._fetch_stems({"drums": trickle_url}, ["drums"])
        except BaseException as exc:  # noqa: BLE001
            box["exc"] = exc

    t = threading.Thread(target=run, daemon=True)
    t0 = time.monotonic()
    t.start()
    t.join(timeout=15)
    assert not t.is_alive(), "a trickling stem download was never cut off"
    assert time.monotonic() - t0 < 5
    assert isinstance(box.get("exc"), InternalError), box
    # INTERNAL_ERROR is our fault: the pipeline's _fail returns the credit.
    assert box["exc"].error_code in job_failure.OUR_FAULT_CODES


def test_the_default_stem_download_budget_is_five_minutes(monkeypatch):
    monkeypatch.delenv("STEM_FETCH_DEADLINE_SEC", raising=False)
    assert pipeline._stem_fetch_deadline_sec() == 300.0
