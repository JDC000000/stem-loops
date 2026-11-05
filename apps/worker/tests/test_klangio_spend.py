"""Klangio spend protection: no double-billing on retry, monthly quota accounting.

Startup tier is real money (500 included requests/month, then $0.20 each), so these
tests pin the guarantees: the billable submit POST is never retried, every submit is
counted before it is sent, the cap refuses instead of incurring overage, a warning fires
at 80%, and the counter resets on the billing day (the 5th). NO live calls are made.
"""

from __future__ import annotations

import json
import threading
import wave
from datetime import UTC, date, datetime
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from worker.chord_providers import klangio as kg
from worker.chord_source import ChordQuotaExceeded

JOB = "817a59d1-0000-4000-8000-000000000000"
SUBMIT_OK = {"job_id": JOB}


def _wav(path: Path, seconds: float = 6.0) -> Path:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * int(8000 * seconds))
    return path


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test-key-123")
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "quota.json"))
    for name in ("KLANGIO_MONTHLY_CAP", "KLANGIO_WARN_FRACTION", "KLANGIO_BILLING_DAY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "POLL_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "_utcnow", lambda: datetime(2026, 11, 20, 12, 0, tzinfo=UTC))


def _client(handler) -> httpx.Client:
    return httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))


def _quota_file(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "quota.json").read_text())


def _events(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    out = []
    for line in capsys.readouterr().err.splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    events = [e for e in out if e.get("event") == "klangio_quota"]
    for e in events:  # log_structured nests the (redacted) fields as a JSON string
        e["detail"] = json.loads(e["detail"])
    return events


# ----------------------------- risk 1: no double-billing -----------------------------
@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(lambda: httpx.Response(500), id="5xx-after-server-success"),
        pytest.param(lambda: httpx.Response(503), id="503"),
        pytest.param(lambda: httpx.Response(429), id="429"),
    ],
)
def test_failed_submit_is_never_retried(failure, tmp_path: Path) -> None:
    """Server may have created (and billed) the job even though we saw an error."""
    posts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return failure()

    with (
        patch.object(kg.time, "sleep") as sleep,
        pytest.raises(kg.ChordProviderError, match="not retried"),
    ):
        kg.KlangioChordSource()._submit(_client(handler), _wav(tmp_path / "a.wav"), "mix")
    assert len(posts) == 1
    sleep.assert_not_called()  # no backoff either: nothing to wait for
    # The failed attempt still counts: it may have been billed.
    assert _quota_file(tmp_path)["count"] == 1


def test_lost_response_after_server_success_does_not_double_submit(tmp_path: Path) -> None:
    """Server accepts job #1, the response is lost (timeout). No second job is created."""
    created: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        created.append(request.url.path)  # server-side success happened here
        raise httpx.ReadTimeout("response lost", request=request)

    with patch.object(kg.time, "sleep"), pytest.raises(kg.ChordProviderError, match="not retried"):
        kg.KlangioChordSource()._submit(_client(handler), _wav(tmp_path / "a.wav"), "mix")
    assert created == ["/chord-recognition"]  # exactly one billed submit


def test_gets_are_still_retried_through_transient_5xx() -> None:
    """Status/result GETs are idempotent: retrying them is safe and kept."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] == 1 else httpx.Response(200, json=[[0, 6, "N"]])

    with patch.object(kg.time, "sleep"):
        resp = kg._request_with_retry(_client(handler), method="GET", url=f"/job/{JOB}/json")
    assert resp.status_code == 200 and calls["n"] == 2


# ----------------------------- risk 2: quota accounting -----------------------------
def test_successful_submit_increments_quota(tmp_path: Path, capsys) -> None:
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    assert src._submit(client, _wav(tmp_path / "a.wav"), "mix") == JOB
    assert src._submit(client, _wav(tmp_path / "b.wav"), "mix") == JOB
    assert _quota_file(tmp_path) == {"cycle": "2026-11-05", "count": 2}
    ev = _events(capsys)
    assert [e["detail"]["count"] for e in ev] == [1, 2]
    assert ev[-1]["level"] == "INFO" and ev[-1]["detail"]["near_cap"] is False


def test_cap_refuses_at_limit_and_sends_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "2")
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json=SUBMIT_OK)

    src = kg.KlangioChordSource()
    client = _client(handler)
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded, match=r"2/2"):
        src._submit(client, _wav(tmp_path / "c.wav"), "mix")
    assert len(sent) == 2  # the refused submit never hit the network
    assert _quota_file(tmp_path)["count"] == 2  # a refusal does not consume quota


def test_default_cap_is_500(tmp_path: Path) -> None:
    (tmp_path / "quota.json").write_text(json.dumps({"cycle": "2026-11-05", "count": 499}))
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")  # 500th is allowed
    with pytest.raises(ChordQuotaExceeded):
        src._submit(client, _wav(tmp_path / "b.wav"), "mix")  # 501st is refused


def test_warning_fires_at_80_percent_not_before(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    (tmp_path / "quota.json").write_text(json.dumps({"cycle": "2026-11-05", "count": 398}))
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    for name in ("a", "b", "c"):  # reserves #399, #400, #401
        src._submit(client, _wav(tmp_path / f"{name}.wav"), "mix")
    ev = [e["detail"] | {"level": e["level"]} for e in _events(capsys)]
    assert [(e["count"], e["level"]) for e in ev] == [
        (399, "INFO"),
        (400, "WARNING"),  # 80% of 500
        (401, "WARNING"),
    ]
    assert ev[1]["near_cap"] is True and ev[1]["pct"] == 80.0


def test_warning_scales_with_a_custom_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "10")
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    for i in range(8):
        src._submit(client, _wav(tmp_path / f"{i}.wav"), "mix")
    levels = [e["level"] for e in _events(capsys)]
    assert levels == ["INFO"] * 7 + ["WARNING"]


def test_cap_refusal_is_logged_at_error_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "1")
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded):
        src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    last = _events(capsys)[-1]
    assert last["level"] == "ERROR" and last["detail"]["outcome"] == "refused_at_cap"


# ----------------------------- billing-cycle boundary -----------------------------
@pytest.mark.parametrize(
    ("today", "expected"),
    [
        (date(2026, 11, 5), date(2026, 11, 5)),  # renewal day starts the new cycle
        (date(2026, 11, 4), date(2026, 10, 5)),  # day before is still the old cycle
        (date(2026, 12, 4), date(2026, 11, 5)),
        (date(2026, 12, 5), date(2026, 12, 5)),
        (date(2027, 1, 3), date(2026, 12, 5)),  # year rollover
        (date(2027, 1, 5), date(2027, 1, 5)),
    ],
)
def test_billing_cycle_start_anchors_on_the_5th(today: date, expected: date) -> None:
    assert kg.billing_cycle_start(today) == expected


def test_billing_day_is_clamped_to_28() -> None:
    assert kg.billing_cycle_start(date(2026, 2, 28), 31) == date(2026, 2, 28)
    assert kg.billing_cycle_start(date(2026, 2, 27), 31) == date(2026, 1, 28)


def test_counter_resets_when_the_cycle_rolls_over(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "2")
    now = {"v": datetime(2026, 12, 4, 23, 59, tzinfo=UTC)}
    monkeypatch.setattr(kg, "_utcnow", lambda: now["v"])
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))

    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded):  # 2026-12-04 is still the Nov-5 cycle: full
        src._submit(client, _wav(tmp_path / "c.wav"), "mix")
    assert _quota_file(tmp_path) == {"cycle": "2026-11-05", "count": 2}

    now["v"] = datetime(2026, 12, 5, 0, 1, tzinfo=UTC)  # renewal day
    src._submit(client, _wav(tmp_path / "d.wav"), "mix")  # allowed again
    assert _quota_file(tmp_path) == {"cycle": "2026-12-05", "count": 1}


# ----------------------------- fail-closed + concurrency -----------------------------
def test_corrupt_quota_file_fails_closed_without_http(tmp_path: Path) -> None:
    (tmp_path / "quota.json").write_text("{not json")
    sent: list[httpx.Request] = []
    client = _client(lambda r: sent.append(r) or httpx.Response(200, json=SUBMIT_OK))
    with pytest.raises(kg.ChordProviderError, match="corrupt"):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav"), "mix")
    assert sent == []


@pytest.mark.parametrize("name", ["KLANGIO_MONTHLY_CAP", "KLANGIO_WARN_FRACTION"])
def test_garbage_spend_env_fails_closed(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(name, "lots")
    sent: list[httpx.Request] = []
    client = _client(lambda r: sent.append(r) or httpx.Response(200, json=SUBMIT_OK))
    with pytest.raises(kg.ChordProviderError, match=name):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav"), "mix")
    assert sent == []


def test_concurrent_reservations_never_exceed_cap(tmp_path: Path) -> None:
    store = kg.FileQuotaStore(tmp_path / "c.json")
    granted: list[bool] = []

    def worker() -> None:
        granted.append(store.reserve("2026-11-05", 10)[1])

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert granted.count(True) == 10 and granted.count(False) == 30


def test_recognize_end_to_end_counts_one_request_per_transcription(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Polls and the result GET are free; only the submit consumes allowance."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json=SUBMIT_OK)
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json=[[0.0, 6.0, "N"]])

    real_client = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        kg.httpx, "Client", lambda *a, **k: real_client(*a, transport=transport, **k)
    )
    kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav"))
    assert _quota_file(tmp_path)["count"] == 1


# ----------------------------- MIME type -----------------------------
@pytest.mark.parametrize(
    ("name", "mime"),
    [
        ("a.wav", "audio/wav"),
        ("a.MP3", "audio/mpeg"),
        ("a.flac", "audio/flac"),
        ("a.ogg", "audio/ogg"),
        ("a.m4a", "audio/mp4"),
        ("a.weird", "application/octet-stream"),
        ("noext", "application/octet-stream"),
    ],
)
def test_mime_type_follows_extension(name: str, mime: str) -> None:
    assert kg._audio_mime(Path(name)) == mime


def test_submit_sends_inferred_mime_in_multipart(tmp_path: Path) -> None:
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.read())
        return httpx.Response(200, json=SUBMIT_OK)

    path = tmp_path / "song.wav"
    _wav(path)
    mp3 = tmp_path / "song.mp3"
    mp3.write_bytes(path.read_bytes())
    kg.KlangioChordSource()._submit(_client(handler), mp3, "mix")
    assert b"Content-Type: audio/mpeg" in seen[0]
