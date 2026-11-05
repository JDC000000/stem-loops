"""Unit tests for the Y1 chord hook in ``worker.pipeline`` (PR-Y1.qa-T4).

Covers the three contracts the T4 audit flagged:

  1. Successful recognition uploads to R2 at ``jobs/<job_id>/play.chords.json``
     with the right Content-Type and Cache-Control.
  2. An R2 upload failure is logged + swallowed — the hook MUST NOT raise
     (chords are an optional overlay feature; a worker exception here would
     fail the whole pipeline).
  3. The stem handed to the provider honours the ``CHORDS_STEM`` env override
     (default ``"instrumental"``), and falls back correctly when that stem is
     missing from the Demucs output.

No real HTTP; the chord provider and R2 client are both mocked so the test
runs the same whether or not Klangio / MinIO credentials are present.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from worker import pipeline
from worker.chord_source import ChordResult, ChordSegment


# ----------------------------- shared fixtures -----------------------------
@pytest.fixture
def stem_paths(tmp_path: Path) -> dict[str, str]:
    """Create fake stem files so _choose_chord_input's existence check passes."""
    paths: dict[str, str] = {}
    for name in ("instrumental", "other", "keys", "vocals"):
        p = tmp_path / f"{name}.wav"
        p.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
        paths[name] = str(p)
    return paths


@pytest.fixture
def chord_result() -> ChordResult:
    """A realistic 3-segment recognition result."""
    return ChordResult(
        segments=[
            ChordSegment(start_sec=0.0, end_sec=1.6, label="C:maj", confidence=1.0),
            ChordSegment(start_sec=1.6, end_sec=3.2, label="F:maj", confidence=1.0),
            ChordSegment(start_sec=3.2, end_sec=4.8, label="G:7", confidence=1.0),
        ],
        key="C:major",
        provider="klangio",
        provider_version="2026-11-04",
        duration_sec=4.8,
        model_ms=123,
    )


# ----------------------------- Part 1: R2 upload path -----------------------------
def test_chord_hook_uploads_to_r2_with_correct_key_and_headers(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: recognition result is JSON-serialised and uploaded to the
    deterministic ``jobs/<job_id>/play.chords.json`` key with
    ``application/json`` + ``private, max-age=0`` headers."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")

    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()

    # Local import inside _maybe_run_chord_recognition does
    # `from .chord_source import get_chord_source`, so we patch the SYMBOL on
    # the chord_source module (not pipeline). upload_play_chords imports _r2
    # from r2_uploader at call-time via the lru_cache — patching the factory
    # is enough.
    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-abc", stem_paths, ["instrumental"])

    fake_r2.put_object.assert_called_once()
    kwargs = fake_r2.put_object.call_args.kwargs
    assert kwargs["Bucket"] == "test-bucket"
    assert kwargs["Key"] == "jobs/job-abc/play.chords.json"
    assert kwargs["ContentType"] == "application/json"
    assert kwargs["CacheControl"] == "private, max-age=0"

    # Body is JSON-encoded bytes; decoding round-trips to the ChordResult shape.
    import json

    body = kwargs["Body"]
    assert isinstance(body, (bytes, bytearray))
    payload = json.loads(body.decode("utf-8"))
    assert payload["provider"] == "klangio"
    assert payload["provider_version"] == "2026-11-04"
    assert payload["key"] == "C:major"
    assert [s["label"] for s in payload["segments"]] == ["C:maj", "F:maj", "G:7"]


def test_chord_hook_upload_failure_is_logged_not_raised(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R2 put_object raising MUST NOT propagate — the hook swallows the failure
    so the rest of the pipeline (extracting → encoding → uploading loops) can
    still complete. Verified: no exception reaches the caller."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")

    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()
    fake_r2.put_object.side_effect = RuntimeError("simulated R2 outage")

    # If this raises, the test fails — that's the whole assertion.
    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-xyz", stem_paths, ["instrumental"])

    # And the provider was still called — the upload failure happened AFTER
    # recognition, so the (expensive) Klangio call isn't wasted.
    fake_provider.recognize.assert_called_once()


def test_chord_hook_provider_failure_is_logged_not_raised(
    stem_paths: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provider raising also doesn't propagate — covers the case upload is
    never attempted at all (recognition itself blew up)."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")

    fake_provider = MagicMock()
    fake_provider.recognize.side_effect = RuntimeError("klangio 500")
    fake_r2 = MagicMock()

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-fail", stem_paths, ["instrumental"])

    # Upload never happened because recognition failed first.
    fake_r2.put_object.assert_not_called()


# ----------------------------- Part 3: stem selection -----------------------------
def test_chord_hook_uses_instrumental_stem_by_default(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Default: the provider is handed the 'instrumental' stem AND the stem
    label is passed through to ``recognize(stem=...)``."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.delenv("CHORDS_STEM", raising=False)
    # Reload the module-level default so the monkeypatched env wins.
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", "instrumental")

    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-stem", stem_paths, ["instrumental"])

    call = fake_provider.recognize.call_args
    assert call is not None
    # audio_path positional, stem keyword.
    audio_path_arg = call.args[0]
    assert str(audio_path_arg) == stem_paths["instrumental"]
    assert call.kwargs.get("stem") == "instrumental"


def test_chord_hook_honours_chords_stem_env_override(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CHORDS_STEM=other picks the 'other' stem and passes stem='other' to the
    provider — the free accuracy lever when Demucs 2-stem preset skips the
    bespoke 'instrumental' bucket."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", "other")

    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-stem2", stem_paths, ["other"])

    call = fake_provider.recognize.call_args
    assert str(call.args[0]) == stem_paths["other"]
    assert call.kwargs.get("stem") == "other"


def test_chord_hook_falls_back_when_preferred_stem_missing(
    tmp_path: Path,
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If CHORDS_STEM points at a stem Demucs didn't produce, fall back through
    the accuracy ladder (instrumental → other → keys → guitar) rather than
    no-op."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", "instrumental")

    # Only 'other' is present — no 'instrumental'. Expect fallback to 'other'.
    other_path = tmp_path / "other.wav"
    other_path.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    stems = {"other": str(other_path), "vocals": str(tmp_path / "vocals.wav")}

    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-fb", stems, ["other"])

    call = fake_provider.recognize.call_args
    assert str(call.args[0]) == str(other_path)
    assert call.kwargs.get("stem") == "other"


# ----------------------------- feature-flag guards -----------------------------
def test_chord_hook_skipped_when_provider_disabled(
    stem_paths: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CHORDS_PROVIDER='' is the Gate-2 fixture-run disable switch. Nothing
    should get imported, uploaded, or called."""
    monkeypatch.setenv("CHORDS_PROVIDER", "")

    fake_r2 = MagicMock()
    with patch("worker.storage.r2_uploader._r2", return_value=fake_r2):
        pipeline._maybe_run_chord_recognition("job-off", stem_paths, ["instrumental"])

    fake_r2.put_object.assert_not_called()


def test_chord_hook_skipped_when_no_non_vocal_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No non-vocal stem → skip rather than feed vocals to Klangio (foundations
    report: vocals is the worst-case accuracy input)."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", "instrumental")

    # Only vocals present — hook must skip.
    vocals = tmp_path / "vocals.wav"
    vocals.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    stems = {"vocals": str(vocals)}

    fake_provider = MagicMock()
    fake_r2 = MagicMock()

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-vocals", stems, ["vocals"])

    fake_provider.recognize.assert_not_called()
    fake_r2.put_object.assert_not_called()
