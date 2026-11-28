"""Klangio submit resilience during an outage (issue #457).

K-1: a submit POST that provably sent nothing (ConnectError / ConnectTimeout / PoolTimeout)
releases the per-job ledger claim; any transport error after the request may have been
written (WriteError / WriteTimeout / ReadError / ReadTimeout / protocol error) keeps the
'submitting' claim (no double bill). The quota slot is never refunded.

K-2: the process-wide submit circuit breaker: thresholds, half-open trial, disable,
skipped submits take no claim and no quota slot and send nothing, transition logs once,
Sentry on open, and thread safety. Plus the pipeline marker ``provider_paused``.

No real HTTP, no DB: httpx.MockTransport, an in-memory ledger and the file quota store.
"""

from __future__ import annotations

import contextlib
import json
import threading
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest
import sentry_sdk

from worker import pipeline
from worker.chord_providers import klangio as kg
from worker.chord_source import (
    ChordProviderPaused,
    ChordQuotaExceeded,
    ChordSubmitUnanswered,
    ChordSubmitUncertain,
)

KLANGIO_JOB = "kl-job-1"


# ------------------------------------------------------------------ fixtures / helpers


class _Ledger:
    def __init__(self, *, claim_exc: Exception | None = None) -> None:
        self.state: str | None = None
        self.claims = 0
        self.releases = 0
        self.claim_exc = claim_exc
        self.release_exc: Exception | None = None

    def existing(self):
        return self.state

    def claim(self):
        self.claims += 1
        if self.claim_exc is not None:
            raise self.claim_exc
        assert self.state is None
        self.state = "submitting"

    def record(self, provider_job_id):
        self.state = provider_job_id

    def release(self):
        self.releases += 1
        if self.release_exc is not None:
            raise self.release_exc
        if self.state == "submitting":
            self.state = None


class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test-key-123")
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "quota.json"))
    for name in ("KLANGIO_MONTHLY_CAP", "KLANGIO_WARN_FRACTION", "KLANGIO_BILLING_DAY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)
    clock = _Clock()
    monkeypatch.setattr(kg, "_breaker_now", clock)
    logs: list[tuple[str, str, dict]] = []
    real_log = kg.log_structured

    def rec(level, event, **fields):
        logs.append((level, event, fields))
        real_log(level, event, **fields)

    monkeypatch.setattr(kg, "log_structured", rec)
    sentry = MagicMock()
    monkeypatch.setattr(sentry_sdk, "capture_message", sentry)
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * 8000 * 6)

    class Env:
        pass

    e = Env()
    e.clock, e.logs, e.sentry, e.wav = clock, logs, sentry, wav
    e.quota = lambda: (
        json.loads((tmp_path / "quota.json").read_text())["count"]
        if (tmp_path / "quota.json").exists()
        else 0
    )
    e.events = lambda name: [entry for entry in logs if entry[1] == name]
    with patch.object(kg.time, "sleep"):
        yield e


def _raiser(exc_type):
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc_type("boom", request=request)

    return handler


def _answer(status: int = 200, body: dict | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body if body is not None else {"job_id": KLANGIO_JOB})

    return handler


class _Counting:
    """Mock transport handler that counts requests and delegates."""

    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return self.handler(request)


def _submit(env, handler, ledger: _Ledger | None = None):
    client = httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))
    return kg.KlangioChordSource()._submit(client, env.wav, "mix", ledger=ledger)


def _no_answer(env, ledger: _Ledger | None = None):
    with pytest.raises(kg.ChordSubmitNoAnswer):
        _submit(env, _raiser(httpx.ReadTimeout), ledger)


# ------------------------------------------------------------------ K-1


@pytest.mark.parametrize("exc_type", [httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout])
def test_k1_not_sent_releases_the_claim(env, exc_type):
    ledger = _Ledger()
    with pytest.raises(kg.ChordSubmitNotSent, match="nothing was sent") as caught:
        _submit(env, _raiser(exc_type), ledger)
    assert ledger.state is None and ledger.releases == 1
    # Not an "unanswered" submit: the pipeline reports it as provider_failed.
    assert not isinstance(caught.value, ChordSubmitUnanswered)
    assert isinstance(caught.value, kg.ChordProviderError)
    # Quota: reserved before the POST and NOT refunded (no refund path).
    assert env.quota() == 1


@pytest.mark.parametrize(
    "exc_type",
    [
        httpx.ReadTimeout,
        httpx.ReadError,
        httpx.WriteTimeout,
        httpx.WriteError,
        httpx.RemoteProtocolError,
    ],
)
def test_k1_possibly_sent_keeps_the_claim(env, exc_type):
    ledger = _Ledger()
    with pytest.raises(kg.ChordSubmitNoAnswer, match="a billed job may exist"):
        _submit(env, _raiser(exc_type), ledger)
    assert ledger.state == "submitting" and ledger.releases == 0
    assert env.quota() == 1


@pytest.mark.parametrize("status", [500, 503, 429, 400])
def test_k1_an_http_error_answer_keeps_the_claim(env, status):
    ledger = _Ledger()
    with pytest.raises(kg.ChordProviderError) as caught:
        _submit(env, _answer(status, {}), ledger)
    assert not isinstance(caught.value, kg.ChordSubmitNotSent)
    assert ledger.state == "submitting" and ledger.releases == 0


@pytest.mark.parametrize("status", [500, 502, 503, 599, 429])
def test_k1_a_5xx_or_429_post_is_unanswered(env, status):
    """#462 item 3: Klangio may have created (and billed) the job behind a 5xx/429, so the
    POST is classed like a lost answer: ``ChordSubmitNoAnswer`` (pipeline reason
    ``submit_unanswered``), claim kept, quota slot spent."""
    ledger = _Ledger()
    with pytest.raises(
        kg.ChordSubmitNoAnswer, match=f"HTTP {status} .*a billed job may exist"
    ) as caught:
        _submit(env, _answer(status, {}), ledger)
    assert isinstance(caught.value, ChordSubmitUnanswered)
    assert ledger.state == "submitting" and ledger.releases == 0
    assert env.quota() == 1


@pytest.mark.parametrize("status", [400, 401, 404, 422, 499])
def test_k1_a_4xx_post_is_not_unanswered(env, status):
    with pytest.raises(kg.ChordProviderError) as caught:
        _submit(env, _answer(status, {}), _Ledger())
    assert not isinstance(caught.value, ChordSubmitUnanswered)


@pytest.mark.parametrize("status", [500, 503, 429])
def test_k1_retried_get_5xx_is_not_unanswered(env, status):
    client = httpx.Client(
        base_url="https://api.klang.io", transport=httpx.MockTransport(_answer(status, {}))
    )
    with pytest.raises(kg.ChordProviderError) as caught:
        kg._request_with_retry(client, method="GET", url="/job/x/status")
    assert type(caught.value) is kg.ChordProviderError


def test_k1_a_released_job_can_submit_again(env):
    ledger = _Ledger()
    with pytest.raises(kg.ChordSubmitNotSent):
        _submit(env, _raiser(httpx.ConnectError), ledger)
    assert _submit(env, _answer(), ledger) == KLANGIO_JOB
    assert ledger.state == KLANGIO_JOB and ledger.claims == 2
    assert env.quota() == 2  # both attempts counted; the first is not refunded


def test_k1_release_failure_keeps_the_original_error(env):
    ledger = _Ledger()
    ledger.release_exc = RuntimeError("db down")
    with pytest.raises(kg.ChordSubmitNotSent):
        _submit(env, _raiser(httpx.ConnectError), ledger)
    assert ledger.state == "submitting"  # the safe side: skip chords, never re-bill
    assert env.events("klangio_claim_release_failed")


def test_k1_without_a_ledger(env):
    with pytest.raises(kg.ChordSubmitNotSent):
        _submit(env, _raiser(httpx.ConnectError), None)


def test_k1_retried_gets_are_unchanged(env):
    client = httpx.Client(
        base_url="https://api.klang.io", transport=httpx.MockTransport(_raiser(httpx.ConnectError))
    )
    with pytest.raises(kg.ChordProviderError) as caught:
        kg._request_with_retry(client, method="GET", url="/job/x/status")
    assert type(caught.value) is kg.ChordProviderError


# ------------------------------------------------------------------ K-2 thresholds


def test_k2_opens_after_three_unanswered_and_skips_without_claim_quota_or_http(env):
    for _ in range(3):
        _no_answer(env, _Ledger())
    assert env.quota() == 3
    assert [e[0] for e in env.events("chords_breaker_open")] == ["WARN"]
    env.sentry.assert_called_once()
    ledger = _Ledger()
    counting = _Counting(_answer())
    with pytest.raises(ChordProviderPaused, match="no request sent"):
        _submit(env, counting, ledger)
    assert counting.calls == 0
    assert ledger.claims == 0 and ledger.state is None
    assert env.quota() == 3  # no slot reserved for the skipped job


def test_k2_two_unanswered_do_not_open(env):
    for _ in range(2):
        _no_answer(env)
    assert _submit(env, _answer()) == KLANGIO_JOB
    assert not env.events("chords_breaker_open")


@pytest.mark.parametrize("status", [200, 400, 404])
def test_k2_any_answer_resets_the_streak(env, status):
    _no_answer(env)
    _no_answer(env)
    with contextlib.suppress(kg.ChordProviderError):
        _submit(env, _answer(status))
    _no_answer(env)
    _no_answer(env)
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED
    _no_answer(env)
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN


def test_k2_not_sent_counts_toward_the_streak(env):
    """#467 item 2, Jon E3 = (a): a POST that never connects counts like an unanswered one
    (each still spends a quota slot, no refund), so a connect outage trips the breaker."""
    _no_answer(env)
    _no_answer(env)
    with pytest.raises(kg.ChordSubmitNotSent):
        _submit(env, _raiser(httpx.ConnectError))
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    ((_lvl, _ev, fields),) = env.events("chords_breaker_open")
    assert fields["trigger"] == kg.OUTCOME_NOT_SENT and fields["consecutive_no_answer"] == 3


@pytest.mark.parametrize("exc_type", [httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout])
def test_k2_a_connect_outage_alone_opens_and_then_spends_nothing(env, exc_type):
    for i in range(3):
        assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED, i
        ledger = _Ledger()
        with pytest.raises(kg.ChordSubmitNotSent):
            _submit(env, _raiser(exc_type), ledger)
        assert ledger.state is None  # K-1 still releases the claim
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    assert env.quota() == 3  # no refund change: each attempt spent its slot
    env.sentry.assert_called_once()
    counting = _Counting(_answer())
    with pytest.raises(ChordProviderPaused):
        _submit(env, counting, _Ledger())
    assert counting.calls == 0 and env.quota() == 3


def test_k2_two_not_sent_do_not_open(env):
    for _ in range(2):
        with pytest.raises(kg.ChordSubmitNotSent):
            _submit(env, _raiser(httpx.ConnectError))
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED
    assert _submit(env, _answer()) == KLANGIO_JOB
    assert kg._BREAKER.consecutive_no_answer == 0


@pytest.mark.parametrize("status", [500, 503, 429])
def test_k2_a_5xx_or_429_post_counts_toward_the_streak(env, status):
    """#462 item 3: an error status on the POST is "unanswered" for the breaker too."""
    for _ in range(3):
        with pytest.raises(kg.ChordSubmitNoAnswer):
            _submit(env, _answer(status, {}))
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    assert env.events("chords_breaker_open")[0][2]["trigger"] == kg.OUTCOME_NO_ANSWER


@pytest.mark.parametrize("status", [500, 429])
def test_k2_a_5xx_half_open_trial_reopens(env, status):
    _open(env)
    env.clock.t += 1800
    with pytest.raises(kg.ChordSubmitNoAnswer):
        _submit(env, _answer(status, {}))
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    assert kg._BREAKER.open_until == env.clock.t + 1800


def test_k2_quota_refusal_does_not_count(env, monkeypatch):
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "0")
    for _ in range(5):
        with pytest.raises(ChordQuotaExceeded):
            _submit(env, _raiser(httpx.ReadTimeout))
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED


def test_k2_custom_threshold_and_pause(env, monkeypatch):
    monkeypatch.setenv("KLANGIO_BREAKER_FAILURES", "1")
    monkeypatch.setenv("KLANGIO_BREAKER_PAUSE_SEC", "60")
    _no_answer(env)
    assert kg._BREAKER.open_until == env.clock.t + 60
    env.clock.t += 59.9
    with pytest.raises(ChordProviderPaused):
        _submit(env, _answer())
    env.clock.t += 0.1
    assert _submit(env, _answer()) == KLANGIO_JOB


def test_k2_disabled_with_zero(env, monkeypatch):
    monkeypatch.setenv("KLANGIO_BREAKER_FAILURES", "0")
    for _ in range(10):
        _no_answer(env)
    assert _submit(env, _answer()) == KLANGIO_JOB
    assert not env.events("chords_breaker_open")
    env.sentry.assert_not_called()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("KLANGIO_BREAKER_FAILURES", "three"),
        ("KLANGIO_BREAKER_FAILURES", "-1"),
        ("KLANGIO_BREAKER_PAUSE_SEC", "soon"),
        ("KLANGIO_BREAKER_PAUSE_SEC", "-5"),
        ("KLANGIO_BREAKER_PAUSE_SEC", "nan"),
    ],
)
def test_k2_garbage_env_fails_closed_without_http(env, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    counting = _Counting(_answer())
    ledger = _Ledger()
    with pytest.raises(kg.ChordProviderError):
        _submit(env, counting, ledger)
    assert counting.calls == 0 and ledger.claims == 0 and env.quota() == 0


# ------------------------------------------------------------------ K-2 half-open


def _open(env):
    for _ in range(3):
        _no_answer(env)
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN


def test_k2_half_open_success_closes(env):
    _open(env)
    env.clock.t += 1800
    assert _submit(env, _answer()) == KLANGIO_JOB
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED
    assert len(env.events("chords_breaker_half_open")) == 1
    assert len(env.events("chords_breaker_closed")) == 1
    assert all(e[0] == "WARN" for e in env.logs if e[1].startswith("chords_breaker_"))
    # Closed means a fresh streak: two more unanswered do not re-open.
    _no_answer(env)
    _no_answer(env)
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED


@pytest.mark.parametrize("exc_type", [httpx.ReadTimeout, httpx.ConnectError])
def test_k2_half_open_failure_reopens_for_a_new_pause(env, exc_type):
    _open(env)
    env.clock.t += 1800
    with pytest.raises(kg.ChordProviderError):
        _submit(env, _raiser(exc_type))
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    assert kg._BREAKER.open_until == env.clock.t + 1800
    assert len(env.events("chords_breaker_open")) == 2
    assert env.sentry.call_count == 2
    with pytest.raises(ChordProviderPaused):
        _submit(env, _answer())


def test_k2_half_open_admits_exactly_one_trial(env):
    _open(env)
    env.clock.t += 1800
    assert kg._BREAKER.admit() is True  # the trial, in flight
    counting = _Counting(_answer())
    with pytest.raises(ChordProviderPaused, match="trial in flight"):
        _submit(env, counting)
    assert counting.calls == 0
    kg._BREAKER.settle(kg.OUTCOME_ANSWERED, trial=True)
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED


@pytest.mark.parametrize(
    "claim_exc", [ChordSubmitUncertain("held"), pipeline._ChordSubmitAbandonedForDrain("j")]
)
def test_k2_an_aborted_trial_hands_the_slot_on(env, claim_exc):
    _open(env)
    env.clock.t += 1800
    with pytest.raises(type(claim_exc)):
        _submit(env, _answer(), _Ledger(claim_exc=claim_exc))
    assert kg._BREAKER.state == kg._SubmitBreaker.HALF_OPEN
    assert _submit(env, _answer()) == KLANGIO_JOB  # the next job becomes the trial
    assert kg._BREAKER.state == kg._SubmitBreaker.CLOSED
    assert len(env.events("chords_breaker_half_open")) == 1


def test_k2_a_late_non_trial_outcome_does_not_change_an_open_breaker(env):
    trial = kg._BREAKER.admit()  # admitted while closed
    assert trial is False
    _open(env)
    kg._BREAKER.settle(kg.OUTCOME_ANSWERED, trial=False)
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN


def test_k2_reattach_is_not_blocked(env, monkeypatch):
    """A recorded job id is reattached with free GETs: the breaker guards only the POST."""
    _open(env)
    ledger = _Ledger()
    ledger.state = KLANGIO_JOB
    monkeypatch.setattr(kg, "_audio_duration_sec", lambda _p: 10.0)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json=[[0.0, 1.0, "C:maj"]])

    mock_client = httpx.Client(
        base_url="https://api.klang.io", transport=httpx.MockTransport(handler)
    )
    with patch.object(kg.httpx, "Client", return_value=mock_client):
        result = kg.KlangioChordSource().recognize(env.wav, ledger=ledger)
    assert len(result.segments) == 1


# ------------------------------------------------------------------ K-2 thread safety


def test_k2_concurrent_failures_open_exactly_once(env):
    barrier = threading.Barrier(20)

    def worker():
        barrier.wait()
        kg._BREAKER.settle(kg.OUTCOME_NO_ANSWER, trial=False)

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    assert len(env.events("chords_breaker_open")) == 1
    env.sentry.assert_called_once()


def test_k2_concurrent_admits_in_half_open_yield_one_trial(env):
    _open(env)
    env.clock.t += 1800
    barrier = threading.Barrier(20)
    results: list[object] = []
    lock = threading.Lock()

    def worker():
        barrier.wait()
        try:
            r: object = kg._BREAKER.admit()
        except ChordProviderPaused:
            r = "paused"
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(True) == 1
    assert results.count("paused") == 19
    assert len(env.events("chords_breaker_half_open")) == 1


# ------------------------------------------------------------------ pipeline marker


def test_pipeline_paused_marker_on_the_extracting_row_and_no_per_job_sentry(monkeypatch):
    """The tombstone/marker mapping itself is in test_chords_marker (parametrize ``paused``);
    here: no per-job Sentry event, and the row detail carries ``chords_reason``."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setattr(pipeline, "upload_play_chords", lambda _j, _b: "k")
    monkeypatch.setattr(pipeline, "_existing_play_chords", lambda _j: False)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 60.0)
    monkeypatch.setattr(pipeline, "_choose_chord_input", lambda *_a, **_k: ("keys", "/x.wav"))
    provider = MagicMock()
    provider.recognize.side_effect = ChordProviderPaused("paused")
    sentry = MagicMock()
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_exception", sentry)
    with patch("worker.chord_source.get_chord_source", return_value=provider):
        out = pipeline._maybe_run_chord_recognition("job-1", {"keys": "/x.wav"}, ["keys"])
    sentry.assert_not_called()
    assert pipeline._with_chords_marker("job-1", None, out) == {
        "chords": "unavailable",
        "chords_reason": "provider_paused",
    }


def test_pipeline_not_sent_is_provider_failed():
    assert not isinstance(kg.ChordSubmitNotSent("x"), ChordSubmitUnanswered)


# ------------------------------------------------------------------ K-2 lock (deterministic)


def _rendezvous_clock(monkeypatch, t: float) -> None:
    """Make ``_breaker_now`` (called INSIDE the breaker's critical sections) a two-thread
    rendezvous. Without the lock both threads reach it and pass the barrier together, so
    they interleave inside the critical section. With the lock the second thread cannot
    enter, the first one's wait times out and it carries on alone. Deterministic either way:
    the GIL cannot hide the race because each thread blocks mid-section."""
    barrier = threading.Barrier(2, timeout=0.5)

    def clock() -> float:
        with contextlib.suppress(threading.BrokenBarrierError):
            barrier.wait()
        return t

    monkeypatch.setattr(kg, "_breaker_now", clock)


def _run_two(fn) -> list[object]:
    results: list[object] = []
    lock = threading.Lock()

    def worker():
        try:
            r = fn()
        except ChordProviderPaused:
            r = "paused"
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    return results


def test_k2_lock_admit_never_hands_out_two_trials(env, monkeypatch):
    _open(env)
    _rendezvous_clock(monkeypatch, env.clock.t + 1800)
    results = _run_two(kg._BREAKER.admit)
    assert sorted(map(str, results)) == ["True", "paused"]
    assert len(env.events("chords_breaker_half_open")) == 1


def test_k2_lock_settle_opens_exactly_once(env, monkeypatch):
    _no_answer(env)
    _no_answer(env)  # streak 2 of 3: the next two settles race to open it
    _rendezvous_clock(monkeypatch, env.clock.t)
    _run_two(lambda: kg._BREAKER.settle(kg.OUTCOME_NO_ANSWER, trial=False))
    assert kg._BREAKER.state == kg._SubmitBreaker.OPEN
    assert len(env.events("chords_breaker_open")) == 1
    env.sentry.assert_called_once()
