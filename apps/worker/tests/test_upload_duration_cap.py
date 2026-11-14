"""Upload duration cap: over-length audio is TRIMMED to its first N seconds before any paid call.

Until 2026-11-14 an upload over ``MAX_UPLOAD_DURATION_SEC`` failed ``UPLOAD_TOO_LONG``. Jon:
a song over 5 minutes "should still be converted to a play along" using its first 5
minutes. The decode now runs with ``-t N``; what reaches Replicate is still at most N s.

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

from worker import pipeline
from worker.errors import (
    ALL_ERROR_CODES,
    InternalError,
    SeparationFailedError,
    UploadInvalidError,
    UploadTooLongError,
)

# jobs.id is a uuid column; a non-uuid id fails at the first real DB statement.
JOB_LONG = "00000000-0000-4000-8000-0000000c0001"  # 12 s upload against a 9 s cap


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


def test_default_cap_is_300_seconds_and_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    # 600.0 until 2026-11-11. Lowered to 300.0 so the upload cap, the chord cap and the
    # player's MAX_TRACK_SEC are ONE number: above 300 s the chord overlay is always a
    # `too_long` tombstone and the web player refuses the track outright, so a 301-600 s
    # upload could only ever buy a paid Replicate separation the visitor cannot play.
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    assert pipeline._max_upload_duration_sec() == 300.0
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "900")
    assert pipeline._max_upload_duration_sec() == 900.0
    for bad in ("abc", "0", "-5", "inf", ""):
        monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", bad)
        assert pipeline._max_upload_duration_sec() == 300.0


def test_upload_cap_is_not_looser_than_the_chord_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """The drift gate, not a restatement of the line above.

    Asserting `== 300.0` twice would still pass if someone raised ONLY the upload cap back
    to 600 and left chords at 300 -- which is exactly the state this PR removed. This
    compares the two knobs to each other, so re-opening the gap fails here even if both
    literals change together. Compared on the DEFAULTS with the env cleared: an operator
    who deliberately raises both via env is out of scope for a unit test.
    """
    for name in ("MAX_UPLOAD_DURATION_SEC", "CHORDS_MAX_AUDIO_SEC"):
        monkeypatch.delenv(name, raising=False)
    assert pipeline._max_upload_duration_sec() <= pipeline._chords_max_audio_sec()


def test_error_code_is_registered_and_message_names_the_limit() -> None:
    # No longer raised for length (2026-11-14), but still defined: old failed rows carry it.
    assert "UPLOAD_TOO_LONG" in ALL_ERROR_CODES
    err = UploadTooLongError("x", max_seconds=600.0)
    assert err.error_code == "UPLOAD_TOO_LONG"
    assert "10 minutes" in err.user_message
    # …and the cap actually in force now renders as the 5 minutes the landing promises.
    assert "5 minutes" in UploadTooLongError(max_seconds=300.0).user_message
    assert "1 minute" in UploadTooLongError(max_seconds=60.0).user_message
    assert "30 seconds" in UploadTooLongError(max_seconds=30.0).user_message
    assert "Trim" in UploadTooLongError().user_message  # no-limit default still actionable


def _wav_secs(path: str) -> float:
    """Stdlib read-back of a PCM WAV's length -- independent of the code under test."""
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def test_over_limit_is_trimmed_not_refused(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source, uploaded = staged
    # 12 s at a 9 s cap: the trimmed 9 s still clears the 7.68 s "too short" floor.
    source["path"] = _wav(tmp_path / "long.wav", 12.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "9")
    url, trim = pipeline._prepare_upload_source("j1", "uploads/k")
    assert url == "https://presigned"
    assert len(uploaded) == 1
    assert _wav_secs(uploaded[0]) == pytest.approx(9.0, abs=0.01)
    assert _wav_secs(uploaded[0]) <= 9.0 + pipeline.TRIM_TOLERANCE_SEC
    assert trim == {"trimmed": True, "source_sec": 12.0, "used_sec": 9.0}


def test_the_decode_is_bounded_at_the_cap_not_cap_plus_one(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Header says nothing (probe -> None), so only the decode bounds it: exactly `-t cap`.
    The trim is still reported, from an unknown original length."""
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "long.wav", 14.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "9")
    real_probe = pipeline._probe_duration_sec
    monkeypatch.setattr(
        pipeline,
        "_probe_duration_sec",
        lambda p: None if p.endswith("raw_input") else real_probe(p),
    )
    seen: list[list[str]] = []
    real_run = subprocess.run

    def spy(cmd, **kw):
        seen.append(cmd)
        return real_run(cmd, **kw)

    monkeypatch.setattr(pipeline.subprocess, "run", spy)
    _url, trim = pipeline._prepare_upload_source("j2", "uploads/k")
    assert seen[0][seen[0].index("-t") + 1] == "9.000"
    assert _wav_secs(uploaded[0]) == pytest.approx(9.0, abs=0.01)  # cap, not 14 s
    assert trim == {"trimmed": True, "source_sec": None, "used_sec": 9.0}


def test_a_decode_that_ignored_the_trim_fails_closed(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """If ffmpeg ever produced more than the cap, it must not be staged for Replicate."""
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "long.wav", 12.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "9")

    def ignores_t(cmd, **kw):
        _wav(Path(cmd[-1]), 12.0)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", ignores_t)
    with pytest.raises(InternalError):
        pipeline._prepare_upload_source("j2b", "uploads/k")
    assert uploaded == []


@pytest.mark.parametrize("declared", [300.5, 612.0, 3600.0])
def test_the_shipped_default_trims_at_300(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, declared: float
) -> None:
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "long.wav", 1.0)
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    monkeypatch.setattr(
        pipeline,
        "_probe_duration_sec",
        lambda p: declared if p.endswith("raw_input") else 300.0,
    )
    monkeypatch.setattr(pipeline, "_reject_unusable_upload", lambda *a: None)
    seen: list[list[str]] = []

    def fake_ffmpeg(cmd, **kw):
        seen.append(cmd)
        Path(cmd[-1]).write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_ffmpeg)
    _url, trim = pipeline._prepare_upload_source("j2c", "uploads/k")
    assert seen[0][seen[0].index("-t") + 1] == "300.000"
    assert trim == {"trimmed": True, "source_sec": round(declared, 1), "used_sec": 300.0}


def test_within_limit_passes_through(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source, uploaded = staged
    # 9 s under a 10 s cap: must also clear the pre-separation "too short to ever cut a loop"
    # floor (pipeline._min_usable_upload_sec, 7.68 s), which refuses a 2 s clip before Replicate.
    source["path"] = _wav(tmp_path / "ok.wav", 9.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "10")
    assert pipeline._prepare_upload_source("j3", "uploads/k") == ("https://presigned", None)
    assert len(uploaded) == 1
    assert _wav_secs(uploaded[0]) == pytest.approx(9.0, abs=0.01)  # untouched length


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


def test_over_length_upload_is_trimmed_and_the_job_event_says_so(
    staged, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Full pipeline: a 12 s upload at a 9 s cap is NOT failed. It reaches the first billed
    call with a staged WAV of at most 9 s, and downloading/completed carries the trim."""
    source, uploaded = staged
    # CI sets STUB_MODE=true; _run_pipeline would then skip the real path entirely.
    monkeypatch.delenv("STUB_MODE", raising=False)
    source["path"] = _wav(tmp_path / "long.wav", 12.0)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "9")
    monkeypatch.setattr(
        pipeline,
        "submit_or_reattach",
        MagicMock(side_effect=SeparationFailedError("sentinel: reached the billed call")),
    )
    row = ("", ["drums"], 4, "upload", "uploads/k", "long.mp3")
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)

    async def noop(*a, **k):
        return None

    events: list[tuple] = []

    async def record_event(job_id, stage, phase, pct=None, detail=None):
        events.append((stage, phase, detail))

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", record_event)
    monkeypatch.setattr(pipeline, "_fail", noop)

    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB_LONG))

    pipeline.submit_or_reattach.assert_called_once_with(JOB_LONG, "https://presigned")
    assert _wav_secs(uploaded[0]) <= 9.0 + pipeline.TRIM_TOLERANCE_SEC
    assert (
        "downloading",
        "completed",
        {"trimmed": True, "source_sec": 12.0, "used_sec": 9.0},
    ) in events
