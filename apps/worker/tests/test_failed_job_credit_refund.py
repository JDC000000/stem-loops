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
  1. Our-fault codes (SEPARATION_FAILED, UPLOAD_FAILED, INTERNAL_ERROR, and since QA-61
     FETCH_PROXY_FAILED) -> refund.
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


@pytest.mark.parametrize(
    "code", ["SEPARATION_FAILED", "UPLOAD_FAILED", "INTERNAL_ERROR", "FETCH_PROXY_FAILED"]
)
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


@pytest.mark.parametrize("code", ["UPLOAD_INVALID", "EXTRACTION_FAILED"])
def test_failure_before_any_paid_call_returns_the_credit(conn, _pipeline_db, code):
    """An empty, corrupt or too-short upload rejected before separation: refunded."""
    uid = _user(conn)
    jid = _job(conn, uid, pred=None)
    _fail(_pipeline_db, jid, code)
    _fail(_pipeline_db, jid, code)  # a second failure path refunds nothing more
    assert _refund_rows(conn, jid) == 1
    assert _balance(conn, uid) == 20


def test_an_over_length_upload_is_never_refunded(conn, _pipeline_db):
    """Jon 2026-11-18 09:23 PT: "No refund for over length." Even with no paid call made."""
    uid = _user(conn)
    jid = _job(conn, uid, pred=None)
    _fail(_pipeline_db, jid, "UPLOAD_TOO_LONG")
    assert conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone() == (
        "failed",
        "UPLOAD_TOO_LONG",
    )
    assert "UPLOAD_TOO_LONG" not in _pipeline_db._OUR_FAULT_CODES
    assert _refund_rows(conn, jid) == 0
    assert _balance(conn, uid) == 19


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


# --------------------------------------------------------------------------- QK-2
def _drive_to_retention(monkeypatch, pipeline, report):
    """The real _run_pipeline on a real job row; every external edge stubbed, the job's
    status writes and its failure (and so the refund) real."""
    from worker import replicate_client

    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_URL", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_FILE", raising=False)
    monkeypatch.setattr(pipeline, "_prepare_upload_source", lambda *a: ("https://in", None))
    monkeypatch.setattr(pipeline, "_record_title", lambda *a: None)
    monkeypatch.setattr(pipeline, "submit_or_reattach", lambda *a: "pred_abc")
    monkeypatch.setattr(pipeline, "poll_until_done", lambda *a: ({"drums": "u"}, 0.01))
    monkeypatch.setattr(pipeline, "_fetch_stems", lambda *a: {"drums": "/x/drums.wav"})
    monkeypatch.setattr(pipeline, "extract_and_tag", lambda *a, **k: ([], {}, None, None))
    monkeypatch.setattr(pipeline, "_maybe_run_chord_recognition", lambda *a: None)
    monkeypatch.setattr(pipeline, "record_loops", lambda *a, **k: 0)
    monkeypatch.setattr(pipeline, "retain_stems", lambda *a: report)
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_exception", lambda *a, **k: None)
    monkeypatch.setattr(replicate_client, "_heartbeat", lambda *_: None)


def test_qk2_zero_playable_stems_fails_and_returns_the_credit_once(conn, _pipeline_db, monkeypatch):
    """Paid separation succeeded, every stem PUT failed: UPLOAD_FAILED, the credit comes back,
    and a second failure path (reaper rerun, consumer) refunds nothing more."""
    from worker.errors import UploadFailedError

    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc")
    assert _balance(conn, uid) == 19
    _drive_to_retention(monkeypatch, _pipeline_db, {"play": [], "download": []})
    with pytest.raises(UploadFailedError):
        asyncio.run(_pipeline_db._run_pipeline(str(jid)))
    assert conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone() == (
        "failed",
        "UPLOAD_FAILED",
    )
    assert _balance(conn, uid) == 20
    _fail(_pipeline_db, jid, "UPLOAD_FAILED")
    _fail(_pipeline_db, jid, "INTERNAL_ERROR")
    assert _refund_rows(conn, jid) == 1
    assert _balance(conn, uid) == 20


def test_490_a_partial_stem_set_fails_and_returns_the_credit_once(conn, _pipeline_db, monkeypatch):
    """#490 (Jon E2 = a): 1 of the 6 htdemucs_6s stems playable is not 'done'. UPLOAD_FAILED
    through the same refund path as 0 stems, exactly one credit back, and the stem objects that
    did upload are deleted."""
    from worker.errors import UploadFailedError

    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc")
    deleted: list = []
    _drive_to_retention(monkeypatch, _pipeline_db, {"play": ["drums"], "download": ["drums"]})
    monkeypatch.setattr(_pipeline_db, "delete_objects", lambda keys: deleted.extend(keys))
    with pytest.raises(UploadFailedError):
        asyncio.run(_pipeline_db._run_pipeline(str(jid)))
    assert conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone() == (
        "failed",
        "UPLOAD_FAILED",
    )
    assert _balance(conn, uid) == 20
    _fail(_pipeline_db, jid, "UPLOAD_FAILED")
    assert _refund_rows(conn, jid) == 1
    assert _balance(conn, uid) == 20
    assert sorted(deleted) == [f"{jid}/_stems/dl/drums.wav", f"{jid}/_stems/play/drums.opus"]


def test_490_a_full_stem_set_finishes_done_and_keeps_the_credit(conn, _pipeline_db, monkeypatch):
    six = list(_pipeline_db.ALL_STEMS)
    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc")
    _drive_to_retention(monkeypatch, _pipeline_db, {"play": six, "download": six})
    asyncio.run(_pipeline_db._run_pipeline(str(jid)))
    assert conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone() == (
        "done",
        None,
    )
    assert _refund_rows(conn, jid) == 0
    assert _balance(conn, uid) == 19


@pytest.mark.parametrize(
    "terminal,code",
    [("done", None), ("failed", "INTERNAL_ERROR")],
    ids=["another_run_finished_done", "reaper_already_failed_it"],
)
def test_490_r1_b1_a_short_report_on_a_terminal_job_deletes_nothing(
    conn, _pipeline_db, monkeypatch, terminal, code
):
    """Review B-1 (R1): a zombie run whose retention comes back short after the job was ended
    by someone else (another run wrote 'done'; the reaper failed it) must not delete the stem
    objects (same deterministic keys as the other run's) and must not change the refund."""
    import psycopg

    from worker.errors import UploadFailedError

    six = list(_pipeline_db.ALL_STEMS)
    uid = _user(conn)
    jid = _job(conn, uid, pred="pred_abc")
    deleted: list = []
    _drive_to_retention(monkeypatch, _pipeline_db, None)

    def retain(job_id, _paths):
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            c.execute(
                "UPDATE jobs SET status=%s, error_code=%s WHERE id=%s", (terminal, code, job_id)
            )
            c.commit()
        if terminal == "failed":  # the reaper's own fail-and-refund
            _fail(_pipeline_db, job_id, "INTERNAL_ERROR")
        return {"play": six[:5], "download": six}

    monkeypatch.setattr(_pipeline_db, "retain_stems", retain)
    monkeypatch.setattr(_pipeline_db, "delete_objects", lambda keys: deleted.extend(keys))
    with pytest.raises(UploadFailedError):
        asyncio.run(_pipeline_db._run_pipeline(str(jid)))
    assert conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (jid,)).fetchone() == (
        terminal,
        code,
    )
    assert deleted == []
    expected_refunds = 0 if terminal == "done" else 1
    assert _refund_rows(conn, jid) == expected_refunds
    assert _balance(conn, uid) == 19 + expected_refunds
