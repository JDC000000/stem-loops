"""A credit spent on a job that fails for OUR reasons is returned (overnight QA W3, 2026-11-12).

The web route debits one credit inside the jobs-INSERT transaction (credits.ts
consumeCreditInTx -> credit_consumption). Nothing ever gave it back, so on the beta path
(testers hold credit packs) every provider outage cost the tester a credit:

  * Replicate prediction `failed` / poll budget exhausted -> SEPARATION_FAILED
  * Replicate returns stem URLs that 404 -> INTERNAL_ERROR
  * R2 write failure -> UPLOAD_FAILED

Reproduced on the local stack against worker 602d0ce (overnight/W3 cases D01, D02, D04):
credits 3 -> 2 and the job failed with no output.

Policy implemented by ``pipeline._fail`` and pinned here:
  1. Our-fault codes (SEPARATION_FAILED, UPLOAD_FAILED, INTERNAL_ERROR) -> refund.
  2. Any failure BEFORE a paid provider call (no ``replicate_prediction_id``: a corrupt or
     over-length upload) -> refund. Nothing was spent, so a refund cannot be farmed.
  3. An input-caused failure AFTER paid separation (EXTRACTION_FAILED on a beatless or
     too-short track) -> NO refund: refunding it would let anyone burn Replicate spend for
     free with silence uploads.
  4. Idempotent: the reaper can run a job twice; ``credit_adjustments`` is
     UNIQUE (provider, provider_event_id) and the job id is the event id.
  5. Only a job that actually consumed a credit is refunded (quota / anonymous jobs: no row).

Local throwaway DB only (INSERTs into auth.users).
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="INSERTs into auth.users; local throwaway DB only")

EMAIL_PREFIX = "test-failed-job-refund-"
# test_credit_balance_view_clamp.py re-applies 022, which leaves v_credit_balance WITHOUT the
# credit_adjustments term for every later test in the session. 023 is the full, idempotent
# view definition ("re-running 023 never regresses the view"), so re-apply it here.
MIGRATION_023 = Path(__file__).resolve().parents[1] / "migrations" / "023_v3_credit_adjustments.sql"


def _cleanup(c) -> None:
    c.rollback()
    like = f"(SELECT id FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%')"
    c.execute(f"DELETE FROM public.credit_adjustments WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.credit_purchases WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.jobs WHERE user_id IN {like}")
    c.execute(f"DELETE FROM auth.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.commit()


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(MIGRATION_023.read_text())
        c.commit()
        _cleanup(c)
        yield c
        _cleanup(c)


@pytest.fixture(autouse=True)
def _pipeline_db(monkeypatch: pytest.MonkeyPatch):
    from worker import pipeline

    monkeypatch.setattr(pipeline, "DATABASE_URL", DB)
    return pipeline


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
    return uid


def _job(c, uid: uuid.UUID, *, pred: str | None, charge: bool = True) -> uuid.UUID:
    jid = uuid.uuid4()
    c.execute(
        "INSERT INTO public.jobs (id, input_kind, upload_r2_key, status, user_id,"
        " replicate_prediction_id, loop_length_bars, requested_stems, client_ip_hash)"
        " VALUES (%s, 'upload', %s, 'extracting', %s, %s, 4, ARRAY['drums'], 'w3test')",
        (jid, f"{jid}/_input.mp3", uid, pred),
    )
    if charge:
        c.execute(
            "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)", (uid, jid)
        )
    c.commit()
    return jid


def _balance(c, uid) -> int:
    c.commit()
    return c.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id=%s", (uid,)
    ).fetchone()[0]


def _refund_rows(c, jid) -> int:
    c.commit()
    return c.execute(
        "SELECT count(*) FROM public.credit_adjustments WHERE provider_event_id=%s", (str(jid),)
    ).fetchone()[0]


def _fail(pipeline, jid, code):
    asyncio.run(pipeline._fail(str(jid), code, "msg"))


@pytest.mark.parametrize("code", ["SEPARATION_FAILED", "UPLOAD_FAILED", "INTERNAL_ERROR"])
def test_our_fault_failure_after_paid_call_returns_the_credit(conn, _pipeline_db, code):
    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc")
    assert _balance(conn, uid) == 19
    _fail(_pipeline_db, jid, code)
    assert _balance(conn, uid) == 20, f"{code}: the credit spent on this job was not returned"
    row = conn.execute(
        "SELECT credits_delta, reason, provider FROM public.credit_adjustments"
        " WHERE provider_event_id=%s",
        (str(jid),),
    ).fetchone()
    assert row == (1, "adjustment", "worker_job_failed")
    assert conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone() == (
        "failed",
        code,
    )


@pytest.mark.parametrize("code", ["UPLOAD_INVALID", "UPLOAD_TOO_LONG", "EXTRACTION_FAILED"])
def test_failure_before_any_paid_call_returns_the_credit(conn, _pipeline_db, code):
    uid = _user(conn)
    jid = _job(conn, uid, pred=None)
    _fail(_pipeline_db, jid, code)
    assert _balance(conn, uid) == 20


def test_input_caused_failure_after_paid_separation_keeps_the_credit(conn, _pipeline_db):
    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_paid")
    _fail(_pipeline_db, jid, "EXTRACTION_FAILED")
    assert _balance(conn, uid) == 19
    assert _refund_rows(conn, jid) == 0


def test_refund_is_idempotent_across_reaper_reruns(conn, _pipeline_db):
    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc")
    _fail(_pipeline_db, jid, "SEPARATION_FAILED")
    _fail(_pipeline_db, jid, "SEPARATION_FAILED")
    _fail(_pipeline_db, jid, "INTERNAL_ERROR")
    assert _refund_rows(conn, jid) == 1
    assert _balance(conn, uid) == 20


def test_job_that_spent_no_credit_gets_no_adjustment(conn, _pipeline_db):
    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc", charge=False)
    _fail(_pipeline_db, jid, "SEPARATION_FAILED")
    assert _refund_rows(conn, jid) == 0
    assert _balance(conn, uid) == 20
