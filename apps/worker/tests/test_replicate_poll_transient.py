"""Transient Replicate poll failures must not kill a healthy prediction.

Prod 2026-11-14: two jobs got SEPARATION_FAILED (job_events reason 'poll_http_502') because
poll_until_done allowed ONE 5xx retry per poll, then cancelled the prediction. Replicate 502s
come in bursts. These tests pin the replacement behaviour:

  * 5xx / 429 / transport errors on the poll GET are retried with 2, 4, 8, 8... s backoff,
    honouring Retry-After on 429, and the run counter resets after any successful poll;
  * a run longer than POLL_TRANSIENT_BUDGET_S ends the poll as a RETRYABLE SeparationTimeout
    (no cancel); the cancel only happens once the whole SEPARATION_MAX_ATTEMPTS budget is spent;
  * a non-429 4xx (e.g. 404) stays terminal: cancel + SeparationFailedError;
  * our-fault typed failures now reach Sentry at warning level with low-cardinality tags.

No database and no network: Replicate HTTP, the clock and every DB-touching helper are faked.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest

from worker import pipeline
from worker import replicate_client as rc
from worker.errors import (
    DownloadBlockedError,
    SeparationFailedError,
    UploadFailedError,
    UploadTooLongError,
)

URL = "https://api.replicate.com/v1/predictions/pred-1"
OK_DONE = {
    "status": "succeeded",
    "output": {"drums": "https://r/d.wav", "piano": "https://r/p.wav"},
    "metrics": {"predict_time": 10.0},
}
PROCESSING = {"status": "processing"}


class FakeClock:
    """Stands in for the `time` module inside replicate_client: sleeps advance the clock."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, s: float) -> None:
        self.sleeps.append(round(s, 3))
        self.now += s


class FakeReplicate:
    """`script` is consumed one item per GET; the last item repeats. An item is a dict (200
    body), an int status, a (status, headers) tuple, or an exception instance to raise."""

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.gets = 0
        self.cancels: list[str] = []

    def get(self, url, **_kw):
        item = self.script[min(self.gets, len(self.script) - 1)]
        self.gets += 1
        req = httpx.Request("GET", url)
        if isinstance(item, Exception):
            raise item
        if isinstance(item, dict):
            return httpx.Response(200, json=item, request=req)
        status, headers = item if isinstance(item, tuple) else (item, {})
        return httpx.Response(status, json={"detail": "x"}, headers=headers, request=req)

    def post(self, url, **_kw):
        assert url.endswith("/cancel"), "polling must never POST a new prediction"
        self.cancels.append(url)
        return httpx.Response(200, json={"status": "canceled"}, request=httpx.Request("POST", url))


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("REPLICATE_API_TOKEN", "t")
    monkeypatch.setattr(rc, "HARD_DEADLINE", 55)
    monkeypatch.setattr(rc, "POLL_INTERVAL", 1)
    monkeypatch.setattr(rc, "POLL_TRANSIENT_BUDGET_S", 20.0)
    monkeypatch.setattr(rc, "SEPARATION_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(rc, "HEARTBEAT_SECONDS", 10_000)
    rc._timeouts.clear()
    clock = FakeClock()
    monkeypatch.setattr(rc, "time", clock)
    booked: list[tuple] = []
    monkeypatch.setattr(rc, "_heartbeat", lambda *_: None)
    monkeypatch.setattr(rc, "_book_success", lambda *_a: 0.0)
    monkeypatch.setattr(rc, "record_prediction_cost", lambda *a, **k: booked.append(a) or 0.0)

    def no_db():
        raise AssertionError("these tests must not open a database connection")

    monkeypatch.setattr(rc, "_db", no_db)
    yield clock, booked
    rc._timeouts.clear()


def _install(monkeypatch, script) -> FakeReplicate:
    fake = FakeReplicate(script)
    monkeypatch.setattr(rc.httpx, "get", fake.get)
    monkeypatch.setattr(rc.httpx, "post", fake.post)
    return fake


# ------------------------------------------------------------------ the prod incident
def test_burst_of_three_502s_then_success_completes_without_cancel(env, monkeypatch):
    clock, booked = env
    fake = _install(monkeypatch, [502, 502, 502, OK_DONE])
    stems, cost = rc.poll_until_done("job-1", "pred-1")
    assert stems == {"drums": "https://r/d.wav", "keys": "https://r/p.wav"}
    assert cost == 0.0
    assert fake.cancels == [], "a transient 502 burst must not cancel a healthy prediction"
    assert booked == [], "nothing abandoned, so no failure cost event"
    assert clock.sleeps == [2.0, 4.0, 8.0], "exponential backoff 2, 4, 8 s"


def test_sustained_502_past_budget_is_a_retryable_timeout_not_a_failure(env, monkeypatch):
    clock, booked = env
    fake = _install(monkeypatch, [502])
    with pytest.raises(rc.SeparationTimeout) as caught:
        rc.poll_until_done("job-1", "pred-1")
    assert not isinstance(caught.value, SeparationFailedError)
    assert caught.value.failure_reason == "poll_transient_exhausted"
    assert fake.cancels == [] and booked == []
    # Failures at t=0, 2, 6, 14, 22 -> the 5th is past the 20 s budget: stop, don't sleep.
    assert clock.sleeps == [2.0, 4.0, 8.0, 8.0]
    assert fake.gets == 5


def test_outage_spanning_every_attempt_cancels_only_when_the_budget_is_spent(env, monkeypatch):
    _clock, booked = env
    fake = _install(monkeypatch, [503])
    for _ in range(rc.SEPARATION_MAX_ATTEMPTS - 1):
        with pytest.raises(rc.SeparationTimeout):
            rc.poll_until_done("job-1", "pred-1")
        assert fake.cancels == [], "no cancel while pipeline still has re-poll attempts left"
    with pytest.raises(SeparationFailedError) as caught:
        rc.poll_until_done("job-1", "pred-1")
    assert caught.value.failure_reason == "poll_budget_exhausted"
    assert len(fake.cancels) == 1 and fake.cancels[0].endswith("/predictions/pred-1/cancel")
    assert len(booked) == 1 and booked[0][3] == "poll_budget_exhausted"


def test_recovery_on_a_later_attempt_after_a_transient_timeout(env, monkeypatch):
    """What pipeline.py does: re-poll the SAME prediction after a SeparationTimeout."""
    fake = _install(monkeypatch, [502] * 5 + [OK_DONE])
    with pytest.raises(rc.SeparationTimeout):
        rc.poll_until_done("job-1", "pred-1")
    stems, _ = rc.poll_until_done("job-1", "pred-1")
    assert "keys" in stems and fake.cancels == []


# ------------------------------------------------------------------ 429 / Retry-After
def test_429_honours_retry_after_seconds(env, monkeypatch):
    clock, _ = env
    fake = _install(monkeypatch, [(429, {"Retry-After": "5"}), OK_DONE])
    rc.poll_until_done("job-1", "pred-1")
    assert clock.sleeps == [5.0] and fake.cancels == []


def test_429_without_retry_after_uses_backoff(env, monkeypatch):
    clock, _ = env
    _install(monkeypatch, [429, 429, OK_DONE])
    rc.poll_until_done("job-1", "pred-1")
    assert clock.sleeps == [2.0, 4.0]


def test_retry_after_never_sleeps_past_the_poll_deadline(env, monkeypatch):
    clock, _ = env
    fake = _install(monkeypatch, [(429, {"Retry-After": "600"})])
    with pytest.raises(rc.SeparationTimeout) as caught:
        rc.poll_until_done("job-1", "pred-1")
    assert clock.sleeps == [55.0], "capped at the time left before HARD_DEADLINE"
    assert caught.value.failure_reason == "poll_transient_exhausted"
    assert fake.cancels == []


def test_retry_after_zero_does_not_busy_loop(env, monkeypatch):
    clock, _ = env
    fake = _install(monkeypatch, [(429, {"Retry-After": "0"}), OK_DONE])
    rc.poll_until_done("job-1", "pred-1")
    assert clock.sleeps == [2.0], "Retry-After below the base backoff is floored at 2 s"
    assert fake.cancels == []


def test_retry_after_http_date_is_parsed():
    when = datetime.now(UTC) + timedelta(seconds=30)
    resp = httpx.Response(429, headers={"Retry-After": format_datetime(when, usegmt=True)})
    assert 25 <= rc._retry_after_s(resp) <= 31
    assert rc._retry_after_s(httpx.Response(429, headers={"Retry-After": "junk"})) is None
    assert rc._retry_after_s(httpx.Response(429)) is None


# ------------------------------------------------------------------ transport errors
def test_transport_errors_are_retried_then_succeed(env, monkeypatch):
    clock, _ = env
    req = httpx.Request("GET", URL)
    fake = _install(
        monkeypatch,
        [httpx.ConnectError("dns", request=req), httpx.ReadTimeout("slow", request=req), OK_DONE],
    )
    stems, _ = rc.poll_until_done("job-1", "pred-1")
    assert "drums" in stems and fake.cancels == []
    assert clock.sleeps == [2.0, 4.0]


def test_sustained_transport_errors_are_a_retryable_timeout(env, monkeypatch):
    fake = _install(monkeypatch, [httpx.ReadError("reset", request=httpx.Request("GET", URL))])
    with pytest.raises(rc.SeparationTimeout) as caught:
        rc.poll_until_done("job-1", "pred-1")
    assert caught.value.failure_reason == "poll_transient_exhausted"
    assert fake.cancels == []


# ------------------------------------------------------------------ counter reset
def test_counter_and_budget_reset_between_separate_bursts(env, monkeypatch):
    """Two bursts of 4 failures (22 s each, 44 s in total, both > half the 20 s budget)
    separated by one good poll: each burst starts from scratch, so the job still succeeds.
    Without the reset the second burst's first failure would already be past the budget."""
    clock, _ = env
    fake = _install(monkeypatch, [502] * 4 + [PROCESSING] + [502] * 4 + [OK_DONE])
    stems, _ = rc.poll_until_done("job-1", "pred-1")
    assert "keys" in stems and fake.cancels == []
    #   burst 1 (t=0..22)     POLL_INTERVAL  burst 2: backoff restarts at 2
    assert clock.sleeps == [2.0, 4.0, 8.0, 8.0, 1.0, 2.0, 4.0, 8.0, 8.0]


# ------------------------------------------------------------------ 4xx stays terminal
def test_404_is_still_terminal_and_cancels(env, monkeypatch):
    clock, booked = env
    fake = _install(monkeypatch, [404])
    with pytest.raises(SeparationFailedError) as caught:
        rc.poll_until_done("job-1", "pred-1")
    assert caught.value.failure_reason == "poll_http_404"
    assert len(fake.cancels) == 1 and clock.sleeps == []
    assert booked and booked[0][3] == "poll_http_404"


def test_404_after_a_transient_burst_is_still_terminal(env, monkeypatch):
    fake = _install(monkeypatch, [502, 502, 404])
    with pytest.raises(SeparationFailedError):
        rc.poll_until_done("job-1", "pred-1")
    assert len(fake.cancels) == 1


# ------------------------------------------------------------------ Sentry reporting
@pytest.fixture
def captured(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(
        pipeline.sentry_sdk, "capture_exception", lambda exc, **kw: calls.append((exc, kw))
    )
    return calls


def test_our_fault_typed_error_is_reported_at_warning_with_reason_tag(captured):
    exc = SeparationFailedError("Replicate HTTP 502", failure_reason="poll_http_502")
    pipeline._report_our_fault(exc)
    assert len(captured) == 1
    _, kw = captured[0]
    assert kw["level"] == "warning"
    assert kw["tags"] == {"error_code": "SEPARATION_FAILED", "failure_reason": "poll_http_502"}


def test_upload_failed_is_reported_without_a_reason_tag(captured):
    pipeline._report_our_fault(UploadFailedError("r2 down"))
    assert captured[0][1]["tags"] == {"error_code": "UPLOAD_FAILED"}


@pytest.mark.parametrize("exc", [DownloadBlockedError("x"), UploadTooLongError("x")])
def test_user_caused_typed_errors_stay_out_of_sentry(captured, exc):
    pipeline._report_our_fault(exc)
    assert captured == []


def _async(fn):
    async def run(*a, **k):
        return fn(*a, **k)

    return run


def test_transient_exhaustion_on_every_attempt_fails_the_job_and_reaches_sentry(
    monkeypatch, captured
):
    """End to end through the real _run_pipeline: every poll ends in a transient-exhaustion
    SeparationTimeout; after SEPARATION_MAX_ATTEMPTS the job fails SEPARATION_FAILED and the
    failure is reported once, tagged with the reason - not silently swallowed as before."""
    monkeypatch.delenv("STUB_MODE", raising=False)
    failed: list[tuple] = []
    polls: list[str] = []
    row = ("", ["drums", "bass", "vocals", "other"], 4, "upload", "uploads/x", "song.mp3")
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)
    monkeypatch.setattr(pipeline, "set_status", _async(lambda *_a: None))
    monkeypatch.setattr(pipeline, "emit_event", _async(lambda *_a, **_k: None))
    monkeypatch.setattr(pipeline, "_prepare_upload_source", lambda *a: "https://audio")
    monkeypatch.setattr(pipeline, "submit_or_reattach", lambda *a: "pred")
    monkeypatch.setattr(pipeline, "SEPARATION_MAX_ATTEMPTS", 2)

    def poll(_job, pred_id):
        polls.append(pred_id)
        # pipeline's own binding: test_replicate_cost reloads replicate_client, so rc's class
        # can differ from the one pipeline catches when the whole suite runs.
        raise pipeline.SeparationTimeout("still 502", failure_reason="poll_transient_exhausted")

    monkeypatch.setattr(pipeline, "poll_until_done", poll)
    monkeypatch.setattr(pipeline, "_fail", _async(lambda *a: failed.append(a)))

    with pytest.raises(SeparationFailedError):
        asyncio.run(pipeline._run_pipeline("00000000-0000-4000-8000-00000000502a"))
    assert polls == ["pred", "pred"], "re-polls the SAME prediction, never a new submit"
    assert failed and failed[0][1] == "SEPARATION_FAILED"
    assert len(captured) == 1
    assert captured[0][1]["tags"] == {
        "error_code": "SEPARATION_FAILED",
        "failure_reason": "poll_transient_exhausted",
    }


def test_sentry_failure_never_masks_the_job_failure(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("sentry transport down")

    monkeypatch.setattr(pipeline.sentry_sdk, "capture_exception", boom)
    # Must not raise: reporting may never hide the failure being reported.
    pipeline._report_our_fault(SeparationFailedError("x", failure_reason="poll_http_502"))
