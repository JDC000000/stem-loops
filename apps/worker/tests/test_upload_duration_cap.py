"""Upload duration cap: over-length audio is rejected BEFORE any paid call.

The web layer only caps bytes (``MAX_UPLOAD_BYTES = 200 MB`` in apps/web/src/lib/upload.ts,
roughly 3.5 h of 128 kbps mp3), which says nothing about Replicate GPU-seconds or Klangio.
The worker is the only place duration can be measured. Real ffmpeg is used (a worker dependency).
"""

from __future__ import annotations

import asyncio
import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.test_chord_rebill import FakeKlangioServer
from worker import pipeline
from worker.errors import ALL_ERROR_CODES, UploadInvalidError, UploadTooLongError

# jobs.id is a uuid column; a non-uuid id fails at the first real DB statement.
JOB_LONG = "00000000-0000-4000-8000-0000000c0001"  # 5 s upload against a 3 s cap


def _wav(path: Path, secs: float, sr: int = 8000) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(struct.pack("<h", int(3000 * math.sin(i / 20))) for i in range(int(sr * secs)))
        )
    return path


@pytest.fixture
def staged(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """download_object copies a prepared file; upload_input is recorded (never real R2)."""
    uploaded: list[str] = []
    source = {"path": None}

    def fake_download(_key: str, dest: str) -> None:
        shutil.copy(source["path"], dest)

    monkeypatch.setattr(pipeline, "download_object", fake_download)
    monkeypatch.setattr(
        pipeline, "upload_input", lambda jid, p: uploaded.append(p) or "https://presigned"
    )
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    return source, uploaded


def test_default_cap_is_600_seconds_and_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    assert pipeline._max_upload_duration_sec() == 600.0
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "900")
    assert pipeline._max_upload_duration_sec() == 900.0
    for bad in ("abc", "0", "-5", "inf", ""):
        monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", bad)
        assert pipeline._max_upload_duration_sec() == 600.0


def test_error_code_is_registered_and_message_names_the_limit() -> None:
    assert "UPLOAD_TOO_LONG" in ALL_ERROR_CODES
    err = UploadTooLongError("x", max_seconds=600.0)
    assert err.error_code == "UPLOAD_TOO_LONG"
    assert "10 minutes" in err.user_message
    assert "1 minute" in UploadTooLongError(max_seconds=60.0).user_message
    assert "30 seconds" in UploadTooLongError(max_seconds=30.0).user_message
    assert "Trim" in UploadTooLongError().user_message  # no-limit default still actionable


def test_over_limit_is_rejected_from_the_header_without_decoding(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "long.wav", 5.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    boom = MagicMock(side_effect=AssertionError("must not decode an over-length upload"))
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", boom)
    with pytest.raises(UploadTooLongError) as ei:
        pipeline._prepare_upload_source("j1", "uploads/k")
    assert ei.value.error_code == "UPLOAD_TOO_LONG"
    boom.assert_not_called()
    assert uploaded == []


def test_lying_header_is_caught_after_a_bounded_decode(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Header says nothing (probe -> None), so the decode runs, capped at cap+1 s; the decoded
    file is then measured and rejected, and was never allowed to grow past the bound."""
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "long.wav", 8.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    real_probe = pipeline._probe_duration_sec
    monkeypatch.setattr(
        pipeline,
        "_probe_duration_sec",
        lambda p: None if p.endswith("raw_input") else real_probe(p),
    )
    decoded: list[float] = []
    real_run = subprocess.run

    def spy(cmd, **kw):
        out = real_run(cmd, **kw)
        decoded.append(real_probe(cmd[-1]))
        return out

    monkeypatch.setattr(pipeline.subprocess, "run", spy)
    with pytest.raises(UploadTooLongError):
        pipeline._prepare_upload_source("j2", "uploads/k")
    assert decoded and decoded[0] == pytest.approx(4.0, abs=0.1)  # cap + 1 s, not 8 s
    assert uploaded == []


def test_within_limit_passes_through(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "ok.wav", 2.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    assert pipeline._prepare_upload_source("j3", "uploads/k") == "https://presigned"
    assert len(uploaded) == 1


def test_ffmpeg_decode_has_a_timeout(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source, _ = staged
    source["path"] = _wav(tmp_path / "ok.wav", 1.0)
    seen: dict = {}

    def hang(cmd, **kw):
        seen.update(kw)
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout", 0))

    monkeypatch.setattr(pipeline.subprocess, "run", hang)
    monkeypatch.setenv("FFMPEG_DECODE_TIMEOUT_SEC", "7")
    with pytest.raises(UploadInvalidError, match="timeout"):
        pipeline._prepare_upload_source("j4", "uploads/k")
    assert seen["timeout"] == 7.0
    monkeypatch.delenv("FFMPEG_DECODE_TIMEOUT_SEC")
    assert pipeline._ffmpeg_decode_timeout_sec() == 120.0


def test_over_length_upload_reaches_no_paid_provider(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Full pipeline: Replicate and Klangio both see ZERO requests, job fails UPLOAD_TOO_LONG
    with the user-facing message."""
    from worker import replicate_client

    source, _ = staged
    # CI sets STUB_MODE=true; _run_pipeline would then skip the real path (and the duration gate)
    # entirely and write fake loops to Postgres instead.
    monkeypatch.delenv("STUB_MODE", raising=False)
    source["path"] = _wav(tmp_path / "long.wav", 5.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test")
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_test")
    klangio = FakeKlangioServer()
    klangio.install(monkeypatch)
    replicate_posts = MagicMock(side_effect=AssertionError("Replicate must not be called"))
    monkeypatch.setattr(replicate_client.httpx, "post", replicate_posts)
    monkeypatch.setattr(replicate_client, "get_prediction_id", lambda _j: None)

    row = ("", ["drums"], 4, "upload", "uploads/k", "long.mp3")
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)

    async def noop(*a, **k):
        return None

    failed: list[tuple] = []

    async def record_fail(*a):
        failed.append(a)

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_fail", record_fail)

    with pytest.raises(UploadTooLongError):
        asyncio.run(pipeline._run_pipeline(JOB_LONG))

    assert klangio.requests == []
    replicate_posts.assert_not_called()
    assert failed and failed[0][1] == "UPLOAD_TOO_LONG"
    assert failed[0][2] == UploadTooLongError(max_seconds=3.0).user_message
    assert "too long" in failed[0][2] and "3 seconds" in failed[0][2]
