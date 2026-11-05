"""Klangio provider vs the REAL API contract (measured against the live service 2026-11-05).

The earlier tests passed against an invented shape (dict body, ``chords`` key, Bearer
auth, no ``vocabulary``). These tests drive ``recognize()`` through a real
``httpx.Client`` wired to ``httpx.MockTransport``, so the actual wire format (URL,
query string, header, multipart field) is asserted — not just our own helpers.
NO live calls are made.
"""

from __future__ import annotations

import json
import math
import threading
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from worker.chord_providers import klangio as kg
from worker.chord_source import ChordQuotaExceeded

# ---- exact payloads from the live characterisation ----
SUBMIT_OK = {
    "job_id": "817a59d1-0000-4000-8000-000000000000",
    "creation_date": "2026-11-05",
    "deletion_date": "2026-12-05",
    "status_endpoint_url": "https://api.klang.io/job/817a59d1-0000-4000-8000-000000000000/status",
}
JOB = SUBMIT_OK["job_id"]
RESULT_10S = [[0.0, 10.0, "N"]]
FAILED_SHORT = {"status": "FAILED", "error": "Audio file must be longer than 5 seconds!"}
BLOB_404 = {"code": "KL003", "description": "Blob does not exist"}
MISSING_VOCAB_422 = {
    "detail": [
        {"type": "missing", "loc": ["query", "vocabulary"], "msg": "Field required"},
    ]
}
# Shape of a real song result: 14 triples, labels E:min7 / A:7 / E:7 / A.
SONG_14 = [
    [0.0, 2.1, "N"],
    [2.1, 4.2, "E:min7"],
    [4.2, 6.3, "A:7"],
    [6.3, 8.4, "E:min7"],
    [8.4, 10.5, "A:7"],
    [10.5, 12.6, "E:7"],
    [12.6, 14.7, "A"],
    [14.7, 16.8, "E:7"],
    [16.8, 18.9, "A"],
    [18.9, 21.0, "E:min7"],
    [21.0, 23.1, "A:7"],
    [23.1, 25.2, "E:7"],
    [25.2, 27.3, "A"],
    [27.3, 29.4, "N"],
]


def _wav(path: Path, seconds: float) -> Path:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * int(8000 * seconds))
    return path


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test-key-123")
    # Spend accounting writes a counter file: never let tests touch the real one.
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "quota" / "klangio_quota.json"))
    monkeypatch.delenv("KLANGIO_MONTHLY_CAP", raising=False)
    monkeypatch.delenv("KLANGIO_VOCABULARY", raising=False)
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "POLL_INTERVAL_SEC", 0.0)


class FakeKlangio:
    """Records every request and answers like the live service."""

    def __init__(self, *, status_script: list[dict], result: object = RESULT_10S) -> None:
        self.requests: list[httpx.Request] = []
        self._statuses = list(status_script)
        self._result = result

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "POST" and path == "/chord-recognition":
            if "vocabulary" not in request.url.params:
                return httpx.Response(422, json=MISSING_VOCAB_422)
            return httpx.Response(200, json=SUBMIT_OK)
        if request.method == "GET" and path == f"/job/{JOB}/status":
            return httpx.Response(200, json=self._statuses.pop(0))
        if request.method == "GET" and path == f"/job/{JOB}/json":
            return httpx.Response(200, json=self._result)
        return httpx.Response(404, json=BLOB_404)

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        real_client = httpx.Client
        transport = httpx.MockTransport(self.handler)

        def factory(*args: object, **kwargs: object) -> httpx.Client:
            return real_client(*args, transport=transport, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(kg.httpx, "Client", factory)


# ------------------------------ wire format ------------------------------
def test_submit_includes_vocabulary_full_by_default_and_hits_real_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeKlangio(status_script=[{"status": "IN_PROGRESS"}, {"status": "COMPLETED"}])
    fake.install(monkeypatch)
    result = kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))

    post = fake.requests[0]
    assert (post.method, post.url.path) == ("POST", "/chord-recognition")
    assert post.url.params["vocabulary"] == "full"
    assert [(r.method, r.url.path) for r in fake.requests[1:]] == [
        ("GET", f"/job/{JOB}/status"),
        ("GET", f"/job/{JOB}/status"),
        ("GET", f"/job/{JOB}/json"),
    ]
    assert [(s.start_sec, s.end_sec, s.label) for s in result.segments] == [(0.0, 10.0, "N")]
    assert result.duration_sec == 10.0


def test_multipart_file_field_is_named_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeKlangio(status_script=[{"status": "COMPLETED"}])
    fake.install(monkeypatch)
    kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))
    post = fake.requests[0]
    assert post.headers["content-type"].startswith("multipart/form-data")
    body = post.read()
    assert b'name="file"' in body
    assert b"audio_file" not in body
    assert b'name="stem"' not in body  # Klangio has no stem parameter


def test_auth_header_is_kl_api_key_on_every_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeKlangio(status_script=[{"status": "IN_QUEUE"}, {"status": "COMPLETED"}])
    fake.install(monkeypatch)
    kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))
    assert len(fake.requests) == 4
    for req in fake.requests:
        assert req.headers["kl-api-key"] == "kl-test-key-123"
        assert "authorization" not in req.headers


@pytest.mark.parametrize("vocab", ["root", "major-minor", "full"])
def test_vocabulary_is_configurable_via_env(
    vocab: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_VOCABULARY", vocab)
    fake = FakeKlangio(status_script=[{"status": "COMPLETED"}])
    fake.install(monkeypatch)
    kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))
    assert fake.requests[0].url.params["vocabulary"] == vocab


def test_invalid_vocabulary_rejected_before_any_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_VOCABULARY", "bogus")
    fake = FakeKlangio(status_script=[])
    fake.install(monkeypatch)
    with pytest.raises(kg.ChordProviderError, match="KLANGIO_VOCABULARY"):
        kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))
    assert fake.requests == []


def test_missing_vocabulary_is_a_422_terminal_error() -> None:
    """Documents why the param is mandatory: the live service 422s without it."""
    client = httpx.Client(
        base_url="https://api.klang.io",
        transport=httpx.MockTransport(lambda r: httpx.Response(422, json=MISSING_VOCAB_422)),
    )
    with pytest.raises(kg.ChordProviderError, match="422"):
        kg._request_with_retry(client, method="POST", url="/chord-recognition")


# ------------------------------ result parsing ------------------------------
def test_array_result_parses_14_triples_with_correct_values() -> None:
    result = kg._parse_klangio_response(SONG_14, model_ms=5)
    assert len(result.segments) == 14
    assert result.segments[1].label == "E:min7"
    assert (result.segments[1].start_sec, result.segments[1].end_sec) == (2.1, 4.2)
    assert [s.label for s in result.segments[:7]] == [
        "N",
        "E:min7",
        "A:7",
        "E:min7",
        "A:7",
        "E:7",
        "A",
    ]
    assert result.duration_sec == 29.4
    assert result.key is None
    # Every label in the real song is inside the Harte subset — none demoted to X.
    assert "X" not in {s.label for s in result.segments}


def test_unknown_label_in_array_maps_to_X() -> None:
    # "C:maj9" was the original example here, written when HARTE_RE carried
    # only 14 of 24 qualities. #121 widened the validator and maj9 became a
    # first-class alphabet member, so it now correctly passes through — the
    # test premise went stale, not the behaviour. "C:maj99" is not a real
    # quality in any vocabulary, so it is a stable example of the real thing.
    result = kg._parse_klangio_response([[0.0, 1.0, "C:maj99"], [1.0, 2.0, "G"]], model_ms=0)
    assert [s.label for s in result.segments] == ["X", "G"]


def test_extended_and_slash_labels_survive_the_array_path() -> None:
    """Counterpart to the test above: the widened vocabulary must pass through.

    Guards the direction the stale test was accidentally asserting against —
    that real extended/slash chords are NOT discarded to X.
    """
    payload = [[0.0, 1.0, "C:maj9"], [1.0, 2.0, "G:7/5"], [2.0, 3.0, "A:min/b3"]]
    result = kg._parse_klangio_response(payload, model_ms=0)
    assert [s.label for s in result.segments] == ["C:maj9", "G:7/5", "A:min/b3"]


def test_malformed_rows_are_skipped_not_fatal() -> None:
    payload = [[0.0, 1.0, "C"], [1.0], "junk", ["a", "b", "G"], {"start": 0}, [2.0, 3.0, "D"]]
    result = kg._parse_klangio_response(payload, model_ms=0)
    assert [s.label for s in result.segments] == ["C", "D"]


# ---------------- parse hardening: structurally invalid rows ----------------
def _summary(capsys: pytest.CaptureFixture[str]) -> dict:
    """Last klangio_parse_summary event's detail, decoded from the stderr JSON line."""
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line.strip()]
    ev = [e for e in events if e["event"] == "klangio_parse_summary"][-1]
    return {"level": ev["level"], **json.loads(ev["detail"])}


def _spans(result) -> list[tuple[float, float, str]]:
    return [(s.start_sec, s.end_sec, s.label) for s in result.segments]


def test_reversed_row_is_dropped_not_kept(capsys: pytest.CaptureFixture[str]) -> None:
    r = kg._parse_klangio_response([[0.0, 1.0, "C"], [6, 5, "A:min"], [1.0, 2.0, "G"]], model_ms=0)
    assert _spans(r) == [(0.0, 1.0, "C"), (1.0, 2.0, "G")]
    s = _summary(capsys)
    assert s["rows_dropped_malformed"] == 1
    assert s["dropped_by_reason"] == {"end_not_after_start": 1}
    assert s["level"] == "WARNING"


def test_zero_duration_row_is_dropped() -> None:
    r = kg._parse_klangio_response([[0.0, 1.0, "C"], [1.0, 1.0, "G"], [1.0, 2.0, "F"]], model_ms=0)
    assert _spans(r) == [(0.0, 1.0, "C"), (1.0, 2.0, "F")]


def test_non_numeric_start_is_dropped_and_counted(capsys: pytest.CaptureFixture[str]) -> None:
    r = kg._parse_klangio_response([[0.0, 1.0, "C"], ["x", 9, "G"], [1.0, 2.0, "D"]], model_ms=0)
    assert [s.label for s in r.segments] == ["C", "D"]
    s = _summary(capsys)
    assert s["rows_dropped_malformed"] == 1
    assert s["dropped_by_reason"] == {"non_numeric_or_non_finite_time": 1}
    assert s["bad_row_samples"] and "'x'" in s["bad_row_samples"][0]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), True, None])
def test_non_finite_and_bool_times_are_dropped(bad) -> None:
    r = kg._parse_klangio_response([[0.0, 1.0, "C"], [bad, 2.0, "G"], [1.0, bad, "F"]], model_ms=0)
    assert _spans(r) == [(0.0, 1.0, "C")]
    # The surviving result must serialise to STRICT JSON (no NaN / Infinity tokens).
    json.dumps([vars(s) for s in r.segments] + [r.duration_sec], allow_nan=False)


def test_nan_really_arrives_via_json_parse_and_is_neutralised() -> None:
    payload = json.loads('[[0, 1, "C"], [NaN, 2, "G"], [1, Infinity, "F"]]')
    assert any(math.isnan(x) for x in (payload[1][0],))  # json.loads accepts NaN by default
    r = kg._parse_klangio_response(payload, model_ms=0)
    assert _spans(r) == [(0.0, 1.0, "C")]
    json.dumps({"d": r.duration_sec}, allow_nan=False)


def test_negative_start_is_clamped_negative_end_is_dropped(
    capsys: pytest.CaptureFixture[str],
) -> None:
    r = kg._parse_klangio_response(
        [[-0.02, 1.0, "C"], [-3.0, -1.0, "G"], [1.0, 2.0, "F"]], model_ms=0
    )
    assert _spans(r) == [(0.0, 1.0, "C"), (1.0, 2.0, "F")]
    s = _summary(capsys)
    assert s["repaired_by_kind"]["clamped_negative_start"] == 1
    assert s["dropped_by_reason"] == {"negative_end": 1}


def test_out_of_order_rows_are_sorted(capsys: pytest.CaptureFixture[str]) -> None:
    r = kg._parse_klangio_response([[2.0, 3.0, "F"], [0.0, 1.0, "C"], [1.0, 2.0, "G"]], model_ms=0)
    assert _spans(r) == [(0.0, 1.0, "C"), (1.0, 2.0, "G"), (2.0, 3.0, "F")]
    assert _summary(capsys)["repaired_by_kind"]["reordered"] == 1


def test_overlap_trims_earlier_segment(capsys: pytest.CaptureFixture[str]) -> None:
    r = kg._parse_klangio_response([[0.0, 3.0, "C"], [2.0, 4.0, "G"]], model_ms=0)
    assert _spans(r) == [(0.0, 2.0, "C"), (2.0, 4.0, "G")]
    assert _summary(capsys)["repaired_by_kind"]["overlap_trimmed"] == 1


def test_duplicate_start_keeps_first_and_drops_second(capsys: pytest.CaptureFixture[str]) -> None:
    r = kg._parse_klangio_response([[0.0, 2.0, "C"], [0.0, 1.0, "G"]], model_ms=0)
    assert _spans(r) == [(0.0, 2.0, "C")]
    assert _summary(capsys)["dropped_by_reason"] == {"duplicate_start": 1}


def test_one_bad_row_among_many_good_keeps_the_rest(capsys: pytest.CaptureFixture[str]) -> None:
    good = [[float(i), float(i + 1), "C" if i % 2 else "G"] for i in range(50)]
    payload = good[:25] + [[9, 8, "A:min"]] + good[25:]
    r = kg._parse_klangio_response(payload, model_ms=0)
    assert len(r.segments) == 50  # no whole-response rejection
    assert [s.start_sec for s in r.segments] == [float(i) for i in range(50)]
    s = _summary(capsys)
    assert (s["rows_total"], s["rows_kept"], s["rows_dropped_malformed"]) == (51, 50, 1)


def test_all_rows_unusable_raises() -> None:
    with pytest.raises(kg.ChordProviderError, match="none were usable"):
        kg._parse_klangio_response([[5, 4, "C"], "junk", ["x", 1, "G"]], model_ms=0)


def test_x_labels_are_counted(capsys: pytest.CaptureFixture[str]) -> None:
    payload = [[0, 1, "C:maj99"], [1, 2, "N.C."], [2, 3, "C:maj7(9)"], [3, 4, "G"]]
    r = kg._parse_klangio_response(payload, model_ms=0)
    assert [s.label for s in r.segments] == ["X", "X", "X", "G"]  # X fallback unchanged
    s = _summary(capsys)
    assert s["labels_mapped_to_x"] == 3
    assert s["x_fraction"] == 0.75
    assert s["rows_dropped_malformed"] == 0
    assert s["level"] == "WARNING"
    assert "N.C." in s["x_label_samples"]


def test_valid_response_unaffected_and_logs_info(capsys: pytest.CaptureFixture[str]) -> None:
    r = kg._parse_klangio_response(SONG_14, model_ms=5)
    assert len(r.segments) == 14
    s = _summary(capsys)
    assert s["level"] == "INFO"
    assert (s["rows_dropped_malformed"], s["labels_mapped_to_x"], s["segments_repaired"]) == (
        0,
        0,
        0,
    )
    assert s["rows_kept"] == 14


def test_parse_json_accepts_array_body() -> None:
    resp = httpx.Response(200, json=RESULT_10S)
    assert kg._parse_json(resp) == RESULT_10S


# ------------------------------ async job states ------------------------------
def test_failed_status_surfaces_error_string(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeKlangio(status_script=[{"status": "IN_QUEUE"}, FAILED_SHORT])
    fake.install(monkeypatch)
    with pytest.raises(kg.ChordProviderError) as exc:
        kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))
    assert "Audio file must be longer than 5 seconds!" in str(exc.value)
    assert JOB in str(exc.value)
    # FAILED means /json would 404; we must not have called it.
    assert all(not r.url.path.endswith("/json") for r in fake.requests)


def test_failed_error_is_bounded_and_key_scrubbed() -> None:
    nasty = "bad file kl-test-key-123 " + "x" * 5000 + "\n\x1b[31m"
    client = httpx.Client(
        base_url="https://api.klang.io",
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200, json={"status": "FAILED", "error": nasty, "extra": "sk_LEAK"}
            )
        ),
    )
    with pytest.raises(kg.ChordProviderError) as exc:
        kg.KlangioChordSource()._poll_until_complete(client, JOB, api_key="kl-test-key-123")
    msg = str(exc.value)
    assert "kl-test-key-123" not in msg
    assert "sk_LEAK" not in msg
    assert "\x1b" not in msg and "\n" not in msg
    assert len(msg) < 400


def test_poll_walks_queue_progress_completed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = [{"status": "IN_QUEUE"}, {"status": "IN_PROGRESS"}, {"status": "COMPLETED"}]
    fake = FakeKlangio(status_script=script, result=SONG_14)
    fake.install(monkeypatch)
    result = kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav", 6.0))
    assert len(result.segments) == 14
    assert sum(r.url.path.endswith("/status") for r in fake.requests) == 3


def test_poll_deadline_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kg, "POLL_DEADLINE_SEC", 0.05)
    monkeypatch.setattr(kg, "POLL_INTERVAL_SEC", 0.01)
    client = httpx.Client(
        base_url="https://api.klang.io",
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={"status": "IN_PROGRESS"})
        ),
    )
    with pytest.raises(kg.ChordProviderError, match="did not complete"):
        kg.KlangioChordSource()._poll_until_complete(client, JOB)


def test_submit_without_usable_job_id_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = httpx.Client(
        base_url="https://api.klang.io",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"job_id": "../etc"})),
    )
    with pytest.raises(kg.ChordProviderError, match="job_id"):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav", 6.0), "mix")


def test_402_still_raises_quota_exceeded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = httpx.Client(
        base_url="https://api.klang.io",
        transport=httpx.MockTransport(lambda r: httpx.Response(402, json={"detail": "quota"})),
    )
    with pytest.raises(ChordQuotaExceeded):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav", 6.0), "mix")


def test_429_on_submit_is_not_retried(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Submit is billable and Klangio has no idempotency key: exactly one POST, ever."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429)

    client = httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))
    with patch.object(kg.time, "sleep"), pytest.raises(kg.ChordProviderError, match="not retried"):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav", 6.0), "mix")
    assert calls["n"] == 1


# ------------------------------ duration guards ------------------------------
@pytest.mark.parametrize("seconds", [1.0, 5.0])  # 5.0 exactly: API demands strictly > 5 s
def test_too_short_audio_rejected_before_any_http(
    seconds: float, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeKlangio(status_script=[])
    fake.install(monkeypatch)
    with pytest.raises(kg.ChordProviderError, match="too short"):
        kg.KlangioChordSource().recognize(_wav(tmp_path / "s.wav", seconds))
    assert fake.requests == []


def test_too_long_audio_rejected_before_any_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kg, "MAX_AUDIO_SEC", 10.0)  # avoid writing a 300 s file
    fake = FakeKlangio(status_script=[])
    fake.install(monkeypatch)
    with pytest.raises(kg.ChordProviderError, match="too long"):
        kg.KlangioChordSource().recognize(_wav(tmp_path / "l.wav", 11.0))
    assert fake.requests == []


def test_default_bounds_are_5_and_300() -> None:
    assert kg.MIN_AUDIO_SEC == 5.0
    assert kg.MAX_AUDIO_SEC == 300.0
    kg._check_duration_bounds(5.01)
    kg._check_duration_bounds(300.0)
    with pytest.raises(kg.ChordProviderError):
        kg._check_duration_bounds(300.01)


def test_unreadable_audio_fails_closed_without_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bad = tmp_path / "garbage.wav"
    bad.write_bytes(b"not audio at all")
    fake = FakeKlangio(status_script=[])
    fake.install(monkeypatch)
    with pytest.raises(kg.ChordProviderError, match="could not determine audio duration"):
        kg.KlangioChordSource().recognize(bad)
    assert fake.requests == []


# ------------------------------ 2 req/s throttle ------------------------------
def test_throttle_spaces_requests_at_least_interval_apart(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.5)
    monkeypatch.setattr(kg, "_next_request_at", 0.0)
    waits: list[float] = []
    monkeypatch.setattr(kg, "_throttle_sleep", waits.append)
    for _ in range(4):
        kg._throttle()
    # First is free; each following call in the same instant waits one more slot.
    assert waits[0] == pytest.approx(0.5, abs=0.05)
    assert waits[1] == pytest.approx(1.0, abs=0.05)
    assert waits[2] == pytest.approx(1.5, abs=0.05)


def test_throttle_is_thread_safe_unique_slots(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.5)
    monkeypatch.setattr(kg, "_next_request_at", 0.0)
    waits: list[float] = []
    lock = threading.Lock()

    def record(w: float) -> None:
        with lock:
            waits.append(w)

    monkeypatch.setattr(kg, "_throttle_sleep", record)
    threads = [threading.Thread(target=kg._throttle) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    slots = sorted(round(w / 0.5) for w in waits)
    # 8 callers -> 7 waiters occupying distinct 0.5 s slots (first caller is free).
    assert slots == list(range(1, 8))
