"""PR-Y1.1: unit tests for ChordSource interface + KlangioChordSource.

Mocked end-to-end — no real Klangio call is ever issued. Covers:
  * Factory default behaviour (CHORDS_PROVIDER env).
  * Harte-syntax validation against the 24-quality alphabet + slash bass + N/X.
  * Klangio: job/poll/json round-trip wiring + response → ChordResult mapping.
  * Klangio: 429 → exponential backoff retry.
  * Klangio: 402 → ChordQuotaExceeded surfaces without retry.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from worker.chord_providers.klangio import (
    ChordProviderError,
    KlangioChordSource,
    _parse_klangio_response,
)
from worker.chord_source import (
    ChordQuotaExceeded,
    ChordResult,
    ChordSegment,
    get_chord_source,
    is_valid_harte_label,
)


# ----------------------------- fixtures -----------------------------
@pytest.fixture
def tiny_wav(tmp_path: Path) -> Path:
    """Minimal WAV so KlangioChordSource.recognize sees a real file to open."""
    path = tmp_path / "tiny.wav"
    # 44-byte canonical RIFF/WAVE header + zero samples — not played, just read.
    path.write_bytes(
        b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00"
        b"\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00"
        b"\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    return path


def _mock_response(
    *, status_code: int = 200, json_body: dict | None = None, headers: dict | None = None
) -> MagicMock:
    """Build a response object shaped like httpx.Response for _request_with_retry."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = json.dumps(json_body) if json_body is not None else ""
    resp.json = MagicMock(return_value=json_body if json_body is not None else {})
    return resp


# ----------------------------- factory -----------------------------
def test_factory_defaults_to_klangio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CHORDS_PROVIDER", raising=False)
    src = get_chord_source()
    assert isinstance(src, KlangioChordSource)


def test_factory_env_override_to_klangio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    src = get_chord_source()
    assert isinstance(src, KlangioChordSource)


def test_factory_explicit_argument_wins_over_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHORDS_PROVIDER", "replicate")
    # Even with env set to a NotImplemented provider, explicit argument wins.
    src = get_chord_source("klangio")
    assert isinstance(src, KlangioChordSource)


def test_factory_replicate_is_not_implemented_yet() -> None:
    with pytest.raises(NotImplementedError):
        get_chord_source("replicate")


def test_factory_internal_is_not_implemented_yet() -> None:
    with pytest.raises(NotImplementedError):
        get_chord_source("internal")


def test_factory_unknown_provider_raises_value_error() -> None:
    with pytest.raises(ValueError):
        get_chord_source("not-a-provider")


# ----------------------------- Harte label validation -----------------------------
@pytest.mark.parametrize(
    "label",
    [
        "C:maj",
        "C#:min",
        "Db:maj7",
        "F#:7",
        "G:dim7",
        "A:hdim7",
        "B:sus4",
        "Eb:minmaj7",
        "N",
        "X",
        "C",  # bare root accepted — Klangio sometimes omits quality
        # extended qualities (were silently dropped by the legacy 14-quality set)
        "C:maj9",
        "D:min9",
        "G:9",
        "G:11",
        "G:13",
        "C:add9",
        "C:add11",
        "C:add6",
        "C:aug7",
        "C:5",
        "C:sus2",
        "C:maj6",
        "C:min6",
        # slash chords: bass is a scale degree
        "C:maj/3",
        "G:7/5",
        "A:min/b3",
        "C:maj/1",
        "F:maj7/5",
        "C/3",
        "C:maj/#5",
        "G:7/b7",
        "C:maj/13",
    ],
)
def test_chord_segment_label_validates_harte_syntax_accepts(label: str) -> None:
    assert is_valid_harte_label(label), f"should accept Harte label {label!r}"


@pytest.mark.parametrize(
    "label",
    [
        "",
        "H:maj",  # H is a German/Scandinavian B — not in Harte subset
        "C:maj/",  # empty bass
        "C:/3",  # bass without quality
        "C:maj/99",  # not a degree
        "C:maj/0",
        "C:maj/14",
        "C:maj/x",
        "C:maj/E",  # note names are not Harte bass tokens
        "C:maj/3/5",  # two slashes
        "N/3",  # N takes no bass
        "X/3",
        "C:maj99",
        "C:MAJ",  # case-sensitive
        "cmaj",  # missing colon
        "c:maj",  # lowercase root
        "C#b:maj",  # both accidentals
        "C:maj:7",  # second colon
        " C:maj",  # leading space
    ],
)
def test_chord_segment_label_validates_harte_syntax_rejects(label: str) -> None:
    assert not is_valid_harte_label(label), f"should reject {label!r}"


def _load_alphabet():
    """Load apps/training/model/alphabet.py by path (no torch/package deps)."""
    import importlib.util

    path = Path(__file__).resolve().parents[2] / "training" / "model" / "alphabet.py"
    spec = importlib.util.spec_from_file_location("_alphabet_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    import sys

    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_ROUND_TRIP_LABELS = [
    "C:maj/3",
    "G:7/5",
    "A:min/b3",
    "C:maj/1",
    "F:maj7/5",
    "C/3",
    "C:maj/#5",
    "G:7/b7",
    "C:maj",
    "E:min7",
    "A:7",
    "C",
    "N",
]


@pytest.mark.parametrize("label", _ROUND_TRIP_LABELS)
def test_validator_accepts_what_encoder_encodes(label: str) -> None:
    alphabet = _load_alphabet()
    assert is_valid_harte_label(label)
    triple = alphabet.encode_factored(label)
    assert triple is not None, f"validator accepts {label!r} but encoder returns None"
    assert len(triple) == 3


def test_slash_bass_indices_match_encoder() -> None:
    alphabet = _load_alphabet()
    assert alphabet.encode_factored("C:maj/1")[2] == alphabet.BASS_SAME_INDEX
    assert alphabet.encode_factored("C:maj/3")[2] == 4
    assert alphabet.encode_factored("G:7/5")[2] == 7
    assert alphabet.encode_factored("A:min/b3")[2] == 3


def test_every_alphabet_quality_is_valid_and_encodable() -> None:
    """Guards against _HARTE_QUALITIES drifting from alphabet.QUALITY_LABELS."""
    alphabet = _load_alphabet()
    for quality in alphabet.QUALITY_LABELS:
        if quality == "N":
            continue
        label = f"C:{quality}"
        assert is_valid_harte_label(label), f"validator rejects alphabet quality {label!r}"
        assert alphabet.encode_factored(label) is not None
        assert is_valid_harte_label(f"C:{quality}/5")


@pytest.mark.parametrize(
    "label", ["C:maj/", "C:/3", "C:maj/99", "C:maj/x", "H:maj", "C:maj/0", "N/3"]
)
def test_malformed_labels_rejected_by_validator(label: str) -> None:
    # The encoder is lenient on junk bass (unparseable bass collapses to "same"),
    # so the VALIDATOR is the gate; it must reject these.
    assert not is_valid_harte_label(label)


# ----------------------------- response parsing -----------------------------
def test_parse_klangio_response_maps_chords_and_key() -> None:
    payload = {
        "key": "C:major",
        "chords": [
            {"start": 0.0, "end": 2.4, "name": "C:maj"},
            {"start": 2.4, "end": 4.8, "name": "F:maj"},
            {"start": 4.8, "end": 7.2, "name": "G:7"},
        ],
    }
    result = _parse_klangio_response(payload, model_ms=123)
    assert isinstance(result, ChordResult)
    assert result.key == "C:major"
    assert result.provider == "klangio"
    assert result.model_ms == 123
    assert result.duration_sec == 7.2
    assert [seg.label for seg in result.segments] == ["C:maj", "F:maj", "G:7"]
    assert all(seg.confidence == 1.0 for seg in result.segments)


def test_parse_klangio_response_maps_unknown_quality_to_X() -> None:
    payload = {
        "key": "C:major",
        "chords": [
            {"start": 0.0, "end": 2.0, "name": "C:maj99"},  # not a real quality
            {"start": 2.0, "end": 4.0, "name": "C:maj"},
        ],
    }
    result = _parse_klangio_response(payload, model_ms=0)
    assert result.segments[0].label == "X"
    assert result.segments[1].label == "C:maj"


def test_parse_klangio_response_preserves_slash_and_extended_chords() -> None:
    payload = {
        "chords": [
            {"start": 0.0, "end": 1.0, "name": "C:maj/3"},
            {"start": 1.0, "end": 2.0, "name": "G:7/5"},
            {"start": 2.0, "end": 3.0, "name": "C:maj9"},
            {"start": 3.0, "end": 4.0, "name": "C:maj/x"},
        ],
    }
    labels = [s.label for s in _parse_klangio_response(payload, model_ms=0).segments]
    assert labels == ["C:maj/3", "G:7/5", "C:maj9", "X"]


def test_parse_klangio_response_handles_missing_key() -> None:
    payload = {"chords": [{"start": 0, "end": 1, "name": "N"}]}
    result = _parse_klangio_response(payload, model_ms=0)
    assert result.key is None


# ----------------------------- end-to-end mocked recognize() -----------------------------
def test_klangio_source_recognize_mocked(tiny_wav: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """submit → poll (processing → completed) → fetch JSON → ChordResult."""
    monkeypatch.setenv("KLANGIO_API_KEY", "test-key-abc123")

    responses = [
        # POST /transcription/chords
        _mock_response(json_body={"job_id": "job-42"}),
        # GET /job/job-42 (still processing)
        _mock_response(json_body={"status": "processing"}),
        # GET /job/job-42 (completed)
        _mock_response(json_body={"status": "completed"}),
        # GET /job/job-42/json
        _mock_response(
            json_body={
                "key": "G:major",
                "chords": [
                    {"start": 0.0, "end": 1.6, "name": "G:maj"},
                    {"start": 1.6, "end": 3.2, "name": "C:maj"},
                    {"start": 3.2, "end": 4.8, "name": "D:7"},
                ],
            }
        ),
    ]

    # Patch the retry wrapper so we don't need to stub httpx.Client internals.
    with (
        patch(
            "worker.chord_providers.klangio._request_with_retry",
            side_effect=responses,
        ),
        patch("worker.chord_providers.klangio.time.sleep"),  # skip the poll delay
    ):
        result = KlangioChordSource().recognize(tiny_wav, stem="instrumental")

    assert result.key == "G:major"
    assert result.provider == "klangio"
    assert [s.label for s in result.segments] == ["G:maj", "C:maj", "D:7"]
    assert result.duration_sec == 4.8
    assert result.model_ms >= 0


def test_klangio_source_missing_api_key_raises(
    tiny_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("KLANGIO_API_KEY", raising=False)
    with pytest.raises(ChordProviderError, match="KLANGIO_API_KEY"):
        KlangioChordSource().recognize(tiny_wav)


def test_klangio_source_missing_file_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_API_KEY", "x")
    with pytest.raises(ChordProviderError, match="audio file not found"):
        KlangioChordSource().recognize(tmp_path / "does-not-exist.wav")


# ----------------------------- 429 retry (exponential backoff) -----------------------------
def test_klangio_source_handles_429_with_exponential_backoff() -> None:
    """429 → backoff → 429 → backoff → 200. Sleep is called twice with growing waits."""
    from worker.chord_providers import klangio as kg

    client = MagicMock(spec=httpx.Client)
    client.request.side_effect = [
        _mock_response(status_code=429, headers={}),
        _mock_response(status_code=429, headers={}),
        _mock_response(status_code=200, json_body={"ok": True}),
    ]
    sleeps: list[float] = []
    with patch.object(kg.time, "sleep", side_effect=lambda s: sleeps.append(s)):
        resp = kg._request_with_retry(client, method="GET", url="/job/1")
    assert resp.status_code == 200
    assert client.request.call_count == 3
    # Two retries → two sleeps. Second sleep must be >= the first (same jitter
    # window + larger base), proving the exponential growth — not just a constant
    # retry loop.
    assert len(sleeps) == 2
    assert sleeps[1] >= sleeps[0]


def test_klangio_source_handles_429_retry_after_header() -> None:
    """A Retry-After header is honoured (wins over the computed backoff)."""
    from worker.chord_providers import klangio as kg

    client = MagicMock(spec=httpx.Client)
    client.request.side_effect = [
        _mock_response(status_code=429, headers={"Retry-After": "3"}),
        _mock_response(status_code=200, json_body={"ok": True}),
    ]
    sleeps: list[float] = []
    with patch.object(kg.time, "sleep", side_effect=lambda s: sleeps.append(s)):
        kg._request_with_retry(client, method="GET", url="/x")
    assert sleeps == [3.0]


def test_klangio_source_handles_429_eventually_gives_up() -> None:
    """After MAX_RETRIES 429s in a row we raise ChordProviderError, not infinite loop."""
    from worker.chord_providers import klangio as kg

    client = MagicMock(spec=httpx.Client)
    client.request.return_value = _mock_response(status_code=429)
    with (
        patch.object(kg.time, "sleep"),
        patch.object(kg, "MAX_RETRIES", 2),
        pytest.raises(ChordProviderError, match="429"),
    ):
        kg._request_with_retry(client, method="GET", url="/x")
    # 1 initial + 2 retries = 3 calls
    assert client.request.call_count == 3


# ----------------------------- 402 → ChordQuotaExceeded -----------------------------
def test_klangio_source_handles_402_as_quota_exceeded() -> None:
    """402 raises ChordQuotaExceeded on the FIRST response — never retried."""
    from worker.chord_providers import klangio as kg

    client = MagicMock(spec=httpx.Client)
    client.request.return_value = _mock_response(
        status_code=402, json_body={"detail": "quota exceeded"}
    )
    with pytest.raises(ChordQuotaExceeded):
        kg._request_with_retry(client, method="GET", url="/job/1")
    # Exactly ONE call — no retry burned on a 402.
    assert client.request.call_count == 1


def test_klangio_source_4xx_other_is_terminal() -> None:
    """A non-402/429 4xx is a terminal ChordProviderError on first response."""
    from worker.chord_providers import klangio as kg

    client = MagicMock(spec=httpx.Client)
    client.request.return_value = _mock_response(status_code=403, json_body={"detail": "forbidden"})
    with pytest.raises(ChordProviderError, match="403"):
        kg._request_with_retry(client, method="GET", url="/job/1")
    assert client.request.call_count == 1


# ----------------------------- ChordSegment basic shape -----------------------------
def test_chord_segment_is_frozen_dataclass() -> None:
    from dataclasses import FrozenInstanceError  # noqa: PLC0415

    seg = ChordSegment(start_sec=0.0, end_sec=1.0, label="C:maj", confidence=0.95)
    with pytest.raises(FrozenInstanceError):
        seg.label = "D:maj"  # type: ignore[misc]
    assert seg.end_sec - seg.start_sec == 1.0


def test_chord_result_defaults() -> None:
    result = ChordResult()
    assert result.segments == []
    assert result.key is None
    assert result.provider == "klangio"
    assert result.duration_sec == 0.0
    assert result.model_ms == 0


# ----------------------------- defensive: make sure we never hit the network -----------------------------
def test_recognize_never_calls_httpx_directly(
    tiny_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Guardrail: the test suite must never issue a real httpx.Client().request()."""
    monkeypatch.setenv("KLANGIO_API_KEY", "x")

    # Replace _request_with_retry with a sentinel so any direct httpx usage would
    # route through the untouched client and fail.
    sentinel_calls: list[str] = []

    def _fake(_client, *, method, url, **kwargs):  # noqa: ANN001
        sentinel_calls.append(f"{method} {url}")
        if url == "/transcription/chords":
            return _mock_response(json_body={"job_id": "j"})
        if url == "/job/j":
            return _mock_response(json_body={"status": "completed"})
        if url == "/job/j/json":
            return _mock_response(json_body={"key": "C:major", "chords": []})
        raise AssertionError(f"unexpected url {url}")

    with (
        patch("worker.chord_providers.klangio._request_with_retry", side_effect=_fake),
        patch("worker.chord_providers.klangio.time.sleep"),
    ):
        KlangioChordSource().recognize(tiny_wav)
    assert sentinel_calls == [
        "POST /transcription/chords",
        "GET /job/j",
        "GET /job/j/json",
    ]
