"""Replicate spend safety: abandoned predictions are cancelled, spend is booked once, and a
crash between 'POST' and 'persist prediction id' cannot cause a second paid POST.

Replicate HTTP is faked; job_events / jobs are real Postgres (skips without DATABASE_URL).
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import psycopg
import pytest

from worker import replicate_client as rc
from worker.errors import SeparationFailedError

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


class Resp:
    def __init__(self, body, status=200):
        self._body, self.status_code = body, status

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "err", request=httpx.Request("GET", "http://x"), response=self  # type: ignore[arg-type]
            )


class FakeReplicate:
    """Records every call; `status` is what GET /predictions/{id} returns."""

    def __init__(self, pred):
        self.pred = pred
        self.posts: list[str] = []
        self.cancels: list[str] = []
        self.cancel_result = None  # override the cancel response body
        self.list_results: list[dict] = []
        self.post_exc: Exception | None = None

    def get(self, url, **kw):
        if url.endswith("/predictions"):
            return Resp({"results": self.list_results})
        return Resp(self.pred)

    def post(self, url, **kw):
        if url.endswith("/cancel"):
            self.cancels.append(url)
            return Resp(self.cancel_result or {**self.pred, "status": "canceled"})
        self.posts.append(url)
        if self.post_exc:
            raise self.post_exc
        return Resp({"id": "pred-new"})


@pytest.fixture
def job():
    job_id = str(uuid.uuid4())
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(
            "INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars, status, "
            "client_ip_hash, client_fingerprint) VALUES(%s,'u',%s,4,'separating','t','t')",
            (job_id, ["drums"]),
        )
        c.commit()
    yield job_id
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        c.commit()


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("REPLICATE_API_TOKEN", "t")
    monkeypatch.setenv("DATABASE_URL", DB)  # type: ignore[arg-type]
    monkeypatch.setattr(rc, "HARD_DEADLINE", 0.2)
    monkeypatch.setattr(rc, "POLL_INTERVAL", 0.05)
    monkeypatch.setattr(rc, "REPLICATE_USD_PER_SECOND", 0.0014)
    getattr(rc, "_timeouts", {}).clear()
    f = FakeReplicate({"status": "processing"})
    monkeypatch.setattr(rc.httpx, "get", f.get)
    monkeypatch.setattr(rc.httpx, "post", f.post)
    return f


def _events(job_id):
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        return c.execute(
            "SELECT phase, detail FROM job_events WHERE job_id=%s ORDER BY id", (job_id,)
        ).fetchall()


def _total_cost(job_id) -> float:
    return sum(float(d["cost_usd"]) for _, d in _events(job_id) if d and "cost_usd" in d)


# --------------------------------------------------------------- cancel on abandonment
def test_timeout_budget_exhausted_cancels_prediction_and_books_spend_once(fake, job, monkeypatch):
    monkeypatch.setattr(rc, "SEPARATION_MAX_ATTEMPTS", 2, raising=False)
    started = _iso(datetime.now(UTC) - timedelta(seconds=100))
    fake.pred = {
        "status": "processing",
        "started_at": started,
        "created_at": _iso(datetime.now(UTC)),
    }
    fake.cancel_result = {
        "status": "canceled",
        "started_at": started,
        "metrics": {"predict_time": 100.0},
    }

    # Attempt 1: still inside the retry budget -> retryable timeout, NOT cancelled.
    with pytest.raises(rc.SeparationTimeout):
        rc.poll_until_done(job, "pred-1")
    assert fake.cancels == []

    # Attempt 2 spends the budget -> terminal failure AND the prediction is cancelled.
    with pytest.raises(SeparationFailedError):
        rc.poll_until_done(job, "pred-1")
    assert len(fake.cancels) == 1 and fake.cancels[0].endswith("/predictions/pred-1/cancel")
    assert _total_cost(job) == pytest.approx(100 * 0.0014)

    # A later rerun that hits the same prediction must not book it again.
    rc.record_prediction_cost(job, "pred-1", 100 * 0.0014, "poll_budget_exhausted")
    assert _total_cost(job) == pytest.approx(100 * 0.0014)
    assert len([e for e in _events(job) if e[1] and "cost_usd" in e[1]]) == 1


def test_failed_prediction_still_books_the_time_it_ran(fake, job):
    fake.pred = {"status": "failed", "error": "OOM", "metrics": {"predict_time": 20.0}}
    with pytest.raises(SeparationFailedError):
        rc.poll_until_done(job, "pred-f")
    assert fake.cancels == [], "already terminal: nothing to cancel"
    assert _total_cost(job) == pytest.approx(20 * 0.0014)


def test_http_error_while_polling_cancels(fake, job, monkeypatch):
    monkeypatch.setattr(rc.httpx, "get", lambda *a, **k: Resp({}, 404))
    with pytest.raises(SeparationFailedError):
        rc.poll_until_done(job, "pred-404")
    assert len(fake.cancels) == 1


def test_cancel_that_loses_the_race_uses_the_finished_result(fake, job, monkeypatch):
    monkeypatch.setattr(rc, "SEPARATION_MAX_ATTEMPTS", 1, raising=False)
    fake.cancel_result = {
        "status": "succeeded",
        "output": {"drums": "http://u", "piano": "http://p"},
        "metrics": {"predict_time": 10.0},
    }
    stems, remaining = rc.poll_until_done(job, "pred-race")
    assert stems == {"drums": "http://u", "keys": "http://p"}
    assert remaining == 0.0 and _total_cost(job) == pytest.approx(10 * 0.0014)


# ----------------------------------------------------------- cost idempotency across reruns
def test_success_books_cost_and_a_rerun_adds_nothing(fake, job):
    fake.pred = {"status": "succeeded", "output": {"drums": "u"}, "metrics": {"predict_time": 10}}
    _, remaining = rc.poll_until_done(job, "pred-ok")
    assert remaining == 0.0, "already booked: pipeline.py's own event must add nothing"
    assert _total_cost(job) == pytest.approx(0.014)
    # Reaper reruns the whole job: same prediction re-attached, polled to success again.
    _, remaining2 = rc.poll_until_done(job, "pred-ok")
    assert remaining2 == 0.0
    assert _total_cost(job) == pytest.approx(0.014), "a rerun must not write a second cost"


def test_rerun_after_an_earlier_pipeline_cost_event_does_not_double_count(fake, job):
    """First run: pipeline.py emitted separating/completed cost 0.014 then crashed."""
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(
            "INSERT INTO job_events(job_id, stage, phase, pct, detail) "
            "VALUES(%s,'separating','completed',100,'{\"cost_usd\": 0.014}')",
            (job,),
        )
        c.commit()
    fake.pred = {"status": "succeeded", "output": {"drums": "u"}, "metrics": {"predict_time": 10}}
    _, remaining = rc.poll_until_done(job, "pred-ok")
    assert remaining == 0.0 and _total_cost(job) == pytest.approx(0.014)


# ------------------------------------------------- marker before POST (orphaned prediction)
def _pred_id_col(job_id):
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        return c.execute(
            "SELECT replicate_prediction_id FROM jobs WHERE id=%s", (job_id,)
        ).fetchone()[0]


def test_marker_is_written_before_the_post(fake, job):
    seen = {}
    real_post = fake.post

    def spy(url, **kw):
        seen["col"] = _pred_id_col(job)
        return real_post(url, **kw)

    rc.httpx.post = spy
    assert rc.submit_or_reattach(job, "https://r2/x/a.wav?sig=1") == "pred-new"
    assert seen["col"].startswith("pending:"), "marker must exist before the paid POST"
    assert _pred_id_col(job) == "pred-new"


def test_crash_after_post_before_persist_does_not_resubmit(fake, job, monkeypatch):
    # Run 1: POST succeeds, then the process dies before set_prediction_id.
    def boom(*a, **k):
        raise KeyboardInterrupt("worker killed")

    monkeypatch.setattr(rc, "set_prediction_id", boom)
    with pytest.raises(KeyboardInterrupt):
        rc.submit_or_reattach(job, "https://r2/x/a.wav?sig=1")
    assert len(fake.posts) == 1 and _pred_id_col(job).startswith("pending:")
    monkeypatch.undo()
    monkeypatch.setenv("REPLICATE_API_TOKEN", "t")
    monkeypatch.setenv("DATABASE_URL", DB)  # type: ignore[arg-type]

    # Run 2 (reaper rerun): Replicate's list shows no match -> FAIL CLOSED, no second POST.
    monkeypatch.setattr(rc.httpx, "get", fake.get)
    monkeypatch.setattr(rc.httpx, "post", fake.post)
    with pytest.raises(SeparationFailedError):
        rc.submit_or_reattach(job, "https://r2/x/a.wav?sig=2")
    assert len(fake.posts) == 1, "must not pay for a second prediction"


def test_pending_marker_adopts_the_orphaned_prediction_when_it_can_be_found(fake, job):
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(
            "UPDATE jobs SET replicate_prediction_id=%s WHERE id=%s",
            ("pending:" + datetime.now(UTC).isoformat(), job),
        )
        c.commit()
    fake.list_results = [
        {
            "id": "pred-orphan",
            "version": rc.MODEL_VERSION,
            "created_at": _iso(datetime.now(UTC)),
            "input": {"audio": "https://r2/x/a.wav?sig=OLD"},
        },
        {  # someone else's prediction on another file
            "id": "pred-other",
            "version": rc.MODEL_VERSION,
            "created_at": _iso(datetime.now(UTC)),
            "input": {"audio": "https://r2/y/b.wav?sig=1"},
        },
    ]
    assert rc.submit_or_reattach(job, "https://r2/x/a.wav?sig=NEW") == "pred-orphan"
    assert fake.posts == [] and _pred_id_col(job) == "pred-orphan"


def test_definite_post_rejection_clears_the_marker_so_a_retry_can_submit(fake, job):
    fake.post_exc = httpx.HTTPStatusError(
        "bad", request=httpx.Request("POST", "http://x"), response=Resp({}, 422)  # type: ignore[arg-type]
    )
    with pytest.raises(httpx.HTTPStatusError):
        rc.submit_or_reattach(job, "https://r2/x/a.wav")
    assert _pred_id_col(job) is None


def test_fresh_process_rerun_does_not_get_a_fresh_retry_budget(fake, job, monkeypatch):
    """Reaper rerun: in-process timeout counter is 0, but Replicate says the prediction has been
    alive for far longer than the whole budget -> cancel on the first timeout."""
    monkeypatch.setattr(rc, "SEPARATION_MAX_ATTEMPTS", 3, raising=False)
    old = _iso(datetime.now(UTC) - timedelta(seconds=600))
    fake.pred = {"status": "processing", "created_at": old, "started_at": old}
    with pytest.raises(SeparationFailedError):
        rc.poll_until_done(job, "pred-old")
    assert len(fake.cancels) == 1
