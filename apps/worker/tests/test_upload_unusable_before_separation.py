"""Uploads that can never yield a loop are refused BEFORE the paid Replicate call (W3, TRIAGE 4.7).

Reproduced on the local stack against worker 602d0ce (overnight/W3 cases C01, C02, C04): a 1 s
clip, a 5 s clip and 3 minutes of digital silence were each normalised, SENT TO REPLICATE
(separation billed), and only then failed EXTRACTION_FAILED in the extractor's beat/length
guard. The tester lost a credit and got nothing; we paid for GPU seconds that could not have
produced anything.

Both checks here are deterministic consequences of the extractor's own guard, so they can only
refuse what the extractor would refuse anyway:
  * Too short: the extractor needs MIN_BARS bars and accepts tempos up to MAX_TRACKER_BPM, so
    anything shorter than MIN_BARS * 4 beats at that tempo can never pass.
  * Digital silence: no onsets, so no beats (peak at or below 2 LSB of 16-bit PCM).
Real ffmpeg is used (a worker dependency); no DB, no network.
"""

from __future__ import annotations

import math
import shutil
import struct
import wave
from pathlib import Path

import pytest

from worker import pipeline
from worker.errors import ExtractionFailedError
from worker.extractor import loop_extractor

JOB = "00000000-0000-4000-8000-0000000d0001"
SR = 22050


def _wav(path: Path, secs: float, *, silent: bool = False, clicks_bpm: float = 120.0) -> Path:
    n = int(SR * secs)
    period = int(SR * 60 / clicks_bpm)
    frames = bytearray()
    for i in range(n):
        if silent:
            v = 0
        else:
            k = i % period
            v = int(12000 * math.exp(-k / 300) * math.sin(2 * math.pi * 80 * k / SR))
            v += int(1500 * math.sin(2 * math.pi * 220 * i / SR))
        frames += struct.pack("<h", max(-32768, min(32767, v)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    return path


@pytest.fixture
def staged(monkeypatch: pytest.MonkeyPatch):
    uploaded: list[str] = []
    source = {"path": None}
    monkeypatch.setattr(
        pipeline, "download_object", lambda _k, dest: shutil.copy(source["path"], dest)
    )
    monkeypatch.setattr(
        pipeline, "upload_input", lambda jid, p: uploaded.append(p) or "https://presigned"
    )
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    return source, uploaded


def test_floor_is_derived_from_the_extractor_guard() -> None:
    floor = loop_extractor.MIN_BARS * 4 * 60.0 / loop_extractor.MAX_TRACKER_BPM
    assert pipeline._min_usable_upload_sec() == pytest.approx(floor)
    assert 7.0 < floor < 8.0  # 8 bars at 250 BPM = 7.68 s


@pytest.mark.parametrize("secs", [1.0, 5.0])
def test_too_short_upload_is_refused_before_replicate(staged, tmp_path: Path, secs: float) -> None:
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "short.wav", secs)
    with pytest.raises(ExtractionFailedError):
        pipeline._prepare_upload_source(JOB, f"{JOB}/_input.wav")
    assert uploaded == [], "a too-short upload was staged for Replicate (separation is billed)"


def test_digital_silence_is_refused_before_replicate(staged, tmp_path: Path) -> None:
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "silence.wav", 30.0, silent=True)
    with pytest.raises(ExtractionFailedError):
        pipeline._prepare_upload_source(JOB, f"{JOB}/_input.wav")
    assert uploaded == []


def test_normal_short_track_still_reaches_replicate(staged, tmp_path: Path) -> None:
    source, uploaded = staged
    source["path"] = _wav(tmp_path / "ok.wav", 20.0)
    assert pipeline._prepare_upload_source(JOB, f"{JOB}/_input.wav") == "https://presigned"
    assert len(uploaded) == 1


def test_quiet_but_not_silent_track_still_reaches_replicate(staged, tmp_path: Path) -> None:
    # A very quiet recording is NOT silence: librosa's onset envelope is relative to the max,
    # so it may still track. Only true digital silence is refused.
    source, uploaded = staged
    p = _wav(tmp_path / "quiet.wav", 20.0)
    with wave.open(str(p)) as r:
        raw = r.readframes(r.getnframes())
    quiet = b"".join(
        struct.pack("<h", s // 100) for (s,) in struct.iter_unpack("<h", raw)
    )  # about -40 dB
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(quiet)
    source["path"] = p
    assert pipeline._prepare_upload_source(JOB, f"{JOB}/_input.wav") == "https://presigned"
