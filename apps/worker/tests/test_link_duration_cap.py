"""Link (YouTube) duration cap: an over-length video is TRIMMED to its first N seconds.

HISTORY. Until 2026-11-14 a linked video longer than ``MAX_UPLOAD_DURATION_SEC`` (300 s)
failed ``UPLOAD_TOO_LONG``: gate 0c refused it from metadata and
``pipeline._enforce_link_duration`` refused the staged file. Jon, 2026-11-14: "If a song is
more than 5 minutes, it should still be converted to a play along, but it just [processes
the first] 5 minutes of the song." So the ceiling stays, but it now CUTS instead of refusing.

WHAT MUST STILL HOLD (the money path): Replicate is never handed more than N seconds.
  * yt-dlp leg: the staged file is cut with ``ffmpeg -t N`` on bytes we hold
    (``pipeline._trim_link_source``), re-measured, and fails CLOSED if it cannot be.
  * Cobalt leg: returns a URL and no bytes, so it cannot be trimmed. It is tried only when
    gate 0c READ a length at or under N -- never for an unknown or a long video.

Every length here is produced independently of the code under test: a WAV of N seconds is
written frame by frame with the stdlib ``wave`` module, and the output length is read back
with the stdlib too (``_wav_secs``), not with ``_probe_duration_sec``.
"""

from __future__ import annotations

import asyncio
import math
import struct
import subprocess
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from worker import downloader, pipeline
from worker.downloader import ytdlp_client
from worker.errors import (
    ALL_ERROR_CODES,
    DownloadBlockedError,
    LinkTooLongError,
    LinkUnmeasurableError,
    SeparationFailedError,
    UploadTooLongError,
)

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
# jobs.id is a uuid column; a non-uuid id fails at the first real DB statement.
JOB = "00000000-0000-4000-8000-0000000d0001"


def _wav(path: Path, secs: float, sr: int = 8000) -> Path:
    """A real WAV of exactly ``secs`` seconds. The length is set HERE, by frame count."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(struct.pack("<h", int(3000 * math.sin(i / 20))) for i in range(int(sr * secs)))
        )
    return path


def _wav_secs(path: str) -> float:
    """Length of a PCM WAV read with the stdlib -- independent of the code under test."""
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


# ----------------------- layer 2: the trim, on bytes we hold -----------------------


def test_over_length_staged_file_is_trimmed_not_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "long.wav", 5.0))
    out, detail = pipeline._trim_link_source(JOB, src)
    assert out != src  # a NEW file is staged; the long original is never handed on
    assert _wav_secs(out) == pytest.approx(3.0, abs=0.01)
    assert _wav_secs(out) <= 3.0 + pipeline.TRIM_TOLERANCE_SEC
    assert detail == {"trimmed": True, "source_sec": 5.0, "used_sec": 3.0}


def test_within_length_staged_file_is_untouched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "ok.wav", 2.0))
    boom = MagicMock(side_effect=AssertionError("must not re-encode a track within the cap"))
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", boom)
    assert pipeline._trim_link_source(JOB, src) == (src, None)
    boom.assert_not_called()


def test_exactly_at_the_cap_is_untouched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """300.0 s at a 300.0 s cap is NOT trimmed: the same strict ``>`` the player makes."""
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 300.0)
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", MagicMock(side_effect=AssertionError("cut")))
    assert pipeline._trim_link_source(JOB, "/tmp/never-read.wav") == ("/tmp/never-read.wav", None)


@pytest.mark.parametrize("measured", [300.5, 301.0, 450.0, 612.0, 3600.0, 86400.0])
def test_the_shipped_default_trims_at_every_magnitude(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, measured: float
):
    """At the 300 s DEFAULT, across ratios 1.002x .. 288x, the ffmpeg cut is ALWAYS run, with
    ``-t 300``. No window or plausibility heuristic survives all six (the bug class a reviewer
    landed on the refusal version of this test)."""
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    assert pipeline._max_upload_duration_sec() == 300.0, "the shipped default moved"
    real_probe = pipeline._probe_duration_sec
    monkeypatch.setattr(
        pipeline,
        "_probe_duration_sec",
        lambda p: measured if p.endswith("long.wav") else real_probe(p),
    )
    seen: list[list[str]] = []

    def fake_ffmpeg(cmd, **kw):
        seen.append(cmd)
        _wav(Path(cmd[-1]), 300.0, sr=200)  # what a correct `-t 300` produces
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_ffmpeg)
    out, detail = pipeline._trim_link_source(JOB, str(tmp_path / "long.wav"))
    assert len(seen) == 1
    assert seen[0][seen[0].index("-t") + 1] == "300.000"
    assert detail == {"trimmed": True, "source_sec": round(measured, 1), "used_sec": 300.0}


def test_the_link_trim_is_the_upload_cap_and_moves_with_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """ONE knob governs both inputs: a 5 s track is cut at a 3 s cap, untouched at 30 s."""
    staged = str(_wav(tmp_path / "five.wav", 5.0))
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    out, detail = pipeline._trim_link_source(JOB, staged)
    assert detail is not None and _wav_secs(out) == pytest.approx(3.0, abs=0.01)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "30")
    assert pipeline._trim_link_source(JOB, staged) == (staged, None)


def test_unreadable_staged_file_fails_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture
):
    """Unmeasurable AND un-cuttable: refused, typed, nothing handed on (reviewer's case E)."""
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    junk = tmp_path / "unreadable.wav"
    junk.write_bytes(b"not audio at all")
    # NOT stubbing _probe_duration_sec: soundfile really cannot read these bytes.
    assert pipeline._probe_duration_sec(str(junk)) is None
    with pytest.raises(LinkUnmeasurableError) as ei:
        pipeline._trim_link_source(JOB, str(junk))
    assert ei.value.error_code == "INTERNAL_ERROR"  # typed, no new code
    assert "link_trim_failed" in capsys.readouterr().err
    assert "couldn't read the audio" in ei.value.user_message


def test_unmeasurable_but_decodable_original_is_cut_and_measured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A file whose length cannot be read up front is still bounded: it is cut with -t, the
    OUTPUT is measured, and a long one is reported as trimmed from an unknown length."""
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "hidden.wav", 5.0))
    real_probe = pipeline._probe_duration_sec
    monkeypatch.setattr(
        pipeline, "_probe_duration_sec", lambda p: None if p == src else real_probe(p)
    )
    out, detail = pipeline._trim_link_source(JOB, src)
    assert _wav_secs(out) == pytest.approx(3.0, abs=0.01)
    assert detail == {"trimmed": True, "source_sec": None, "used_sec": 3.0}


def test_unmeasurable_short_original_is_not_reported_as_trimmed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "hidden_short.wav", 2.0))
    real_probe = pipeline._probe_duration_sec
    monkeypatch.setattr(
        pipeline, "_probe_duration_sec", lambda p: None if p == src else real_probe(p)
    )
    out, detail = pipeline._trim_link_source(JOB, src)
    assert detail is None
    assert _wav_secs(out) == pytest.approx(2.0, abs=0.01)


def test_a_cut_that_did_not_hold_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """If ffmpeg ignored `-t` the output would be over the cap; that must never be staged."""
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "long.wav", 5.0))

    def ignores_t(cmd, **kw):
        _wav(Path(cmd[-1]), 5.0)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(pipeline.subprocess, "run", ignores_t)
    with pytest.raises(LinkUnmeasurableError):
        pipeline._trim_link_source(JOB, src)


def test_the_trim_has_a_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    monkeypatch.setenv("FFMPEG_DECODE_TIMEOUT_SEC", "7")
    src = str(_wav(tmp_path / "long.wav", 5.0))
    seen: dict = {}

    def hang(cmd, **kw):
        seen.update(kw)
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout", 0))

    monkeypatch.setattr(pipeline.subprocess, "run", hang)
    with pytest.raises(LinkUnmeasurableError, match="timeout"):
        pipeline._trim_link_source(JOB, src)
    assert seen["timeout"] == 7.0


# ------------------------ layer 1: gate 0c, before a byte is fetched ------------------------


@pytest.fixture
def chain(monkeypatch: pytest.MonkeyPatch):
    """download_audio with its gates open and both fetchers recorded, never run for real."""
    calls: list[str] = []
    monkeypatch.setattr(downloader.fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(downloader.fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: False)
    monkeypatch.setattr(downloader.fetch_gates, "log_attempt", lambda **kw: None)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")
    monkeypatch.setattr(
        downloader.ytdlp_client,
        "fetch_audio_file",
        lambda u: calls.append("ytdlp") or "/tmp/a.wav",
    )
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_url",
        lambda u: calls.append("cobalt") or "https://tunnel",
    )
    return calls


@pytest.mark.parametrize("declared", [300.5, 612.0, 3600.0, 86400.0])
def test_gate_0c_no_longer_refuses_a_long_video(
    chain, monkeypatch: pytest.MonkeyPatch, declared: float
):
    """The new requirement at the gate: a long link is FETCHED (then trimmed), not refused."""
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: declared)
    assert downloader.download_audio(URL, JOB, 300.0) == ("/tmp/a.wav", "ytdlp")
    assert chain == ["ytdlp"]


def test_gate_0c_lets_a_short_video_through(chain, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: 120.0)
    assert downloader.download_audio(URL, JOB, 300.0) == ("/tmp/a.wav", "ytdlp")
    assert chain == ["ytdlp"]


def test_gate_0c_proceeds_on_an_unreadable_length(chain, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: None)
    assert downloader.download_audio(URL, JOB, 300.0) == ("/tmp/a.wav", "ytdlp")
    assert chain == ["ytdlp"]


def _ytdlp_always_blocked(chain, monkeypatch: pytest.MonkeyPatch):
    """yt-dlp exhausts its attempts (as in a datacenter-IP block) and Cobalt is released."""

    def blocked(_u):
        chain.append("ytdlp")
        raise DownloadBlockedError("test: yt-dlp blocked")

    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", blocked)
    monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0.0)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: True)


def test_cobalt_is_not_tried_when_the_length_is_unknown(chain, monkeypatch: pytest.MonkeyPatch):
    """Cobalt returns a URL and no bytes: with no reading it could hand Replicate any length."""
    _ytdlp_always_blocked(chain, monkeypatch)
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: None)
    with pytest.raises(DownloadBlockedError):
        downloader.download_audio(URL, JOB, 300.0)
    assert chain == ["ytdlp", "ytdlp"]


@pytest.mark.parametrize("declared", [300.5, 612.0, 3600.0])
def test_cobalt_cannot_bypass_the_trim_for_a_long_video(
    chain, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture, declared: float
):
    """THE BYPASS THIS CHANGE COULD HAVE OPENED. Gate 0c used to raise for a long video, so
    the Cobalt arm was never reached with one. Now that 0c lets it through, Cobalt -- whose
    URL nothing downstream can trim -- must be skipped explicitly, or a 10-minute video goes
    straight to Replicate whenever yt-dlp is blocked."""
    _ytdlp_always_blocked(chain, monkeypatch)
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: declared)
    with pytest.raises(DownloadBlockedError):
        downloader.download_audio(URL, JOB, 300.0)
    assert chain == ["ytdlp", "ytdlp"]
    assert "cobalt" not in chain
    assert "cobalt_skipped_cannot_trim" in capsys.readouterr().err


@pytest.mark.parametrize("declared", [120.0, 300.0])
def test_cobalt_is_tried_when_the_length_was_read_and_is_within_the_cap(
    chain, monkeypatch: pytest.MonkeyPatch, declared: float
):
    _ytdlp_always_blocked(chain, monkeypatch)
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: declared)
    assert downloader.download_audio(URL, JOB, 300.0) == ("https://tunnel", "cobalt")
    assert chain == ["ytdlp", "ytdlp", "cobalt"]


def test_cobalt_is_still_tried_for_a_caller_that_passes_no_cap(
    chain, monkeypatch: pytest.MonkeyPatch
):
    """No cap means no gate 0c (documented); that must not silently change Cobalt for them."""
    _ytdlp_always_blocked(chain, monkeypatch)
    assert downloader.download_audio(URL, JOB) == ("https://tunnel", "cobalt")


def test_no_cap_passed_means_no_probe_at_all(chain, monkeypatch: pytest.MonkeyPatch):
    """Read with the next test: the capless path is well-behaved, AND production never takes it."""
    probed = MagicMock(side_effect=AssertionError("must not probe without a cap"))
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", probed)
    assert downloader.download_audio(URL, JOB) == ("/tmp/a.wav", "ytdlp")
    probed.assert_not_called()


def _pipeline_link_rig(monkeypatch: pytest.MonkeyPatch, fake_download, events: list, staged: list):
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.setattr(pipeline, "download_audio", fake_download)
    monkeypatch.setattr(
        pipeline, "upload_input", lambda _j, p: staged.append(p) or "https://presigned"
    )
    monkeypatch.setattr(
        pipeline,
        "submit_or_reattach",
        MagicMock(side_effect=SeparationFailedError("sentinel: reached the billed call")),
    )
    monkeypatch.setattr(
        pipeline, "_fetch_job", lambda _j: (URL, ["drums"], 4, "youtube", None, None)
    )

    async def noop(*a, **k):
        return None

    async def record_event(job_id, stage, phase, pct=None, detail=None):
        events.append((stage, phase, detail))

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", record_event)
    monkeypatch.setattr(pipeline, "_fail", noop)


def test_the_pipeline_arms_gate_0c_with_the_cap_in_force(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """The pipeline must HAND the cap down, or Cobalt's only ceiling is dead in production.

    The expected figure is a LITERAL set through the environment; comparing it to a second
    call of ``_max_upload_duration_sec()`` would pass just as happily with the argument dropped.
    """
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "137")  # not 300: a number only this test sets
    seen: dict = {}

    def fake_download(_url, _job, cap=None):
        seen["cap"] = cap
        return str(_wav(tmp_path / "one_second.wav", 1.0)), "ytdlp"

    events: list = []
    staged: list = []
    _pipeline_link_rig(monkeypatch, fake_download, events, staged)
    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["cap"] == 137.0
    # A short track is staged as fetched and its completion event carries no trim detail.
    assert staged == [str(tmp_path / "one_second.wav")]
    assert ("downloading", "completed", None) in events


def test_over_length_link_is_trimmed_and_reaches_replicate_with_at_most_n_seconds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """The whole pipeline on a link job: a 5 s video at a 3 s cap is NOT failed; the file
    staged for Replicate is the cut one, at most 3 s, and the job event records the trim."""
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    long_src = str(_wav(tmp_path / "ten_minutes_in_spirit.wav", 5.0))

    def fake_download(_url, _job, cap=None):
        return long_src, "ytdlp"

    events: list = []
    staged: list = []
    _pipeline_link_rig(monkeypatch, fake_download, events, staged)
    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB))
    pipeline.submit_or_reattach.assert_called_once_with(JOB, "https://presigned")
    assert len(staged) == 1 and staged[0] != long_src
    assert _wav_secs(staged[0]) <= 3.0 + pipeline.TRIM_TOLERANCE_SEC
    assert (
        "downloading",
        "completed",
        {"trimmed": True, "source_sec": 5.0, "used_sec": 3.0},
    ) in events


def test_pipeline_cobalt_arm_hands_the_url_on_only_after_a_length_was_verified(
    monkeypatch: pytest.MonkeyPatch,
):
    """Drives the Cobalt arm with the REAL download_audio: a READ 120 s length may use it."""
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    calls: list[str] = []
    monkeypatch.setattr(downloader.fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(downloader.fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: True)
    monkeypatch.setattr(downloader.fetch_gates, "log_attempt", lambda **kw: None)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")
    monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0.0)
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: 120.0)

    def blocked(_u):
        calls.append("ytdlp_fetch")
        raise DownloadBlockedError("test: blocked")

    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", blocked)
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_url",
        lambda u: calls.append("cobalt_fetch") or "https://tunnel.example/a.mp3",
    )
    monkeypatch.setattr(pipeline, "upload_input", lambda *a: calls.append("R2_STAGE") or "x")

    def submit(job_id, src):
        calls.append(f"REPLICATE_SUBMIT({src})")
        raise SeparationFailedError("sentinel: reached the billed call")

    monkeypatch.setattr(pipeline, "submit_or_reattach", submit)
    monkeypatch.setattr(
        pipeline, "_fetch_job", lambda _j: (URL, ["drums"], 4, "youtube", None, None)
    )

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_fail", noop)

    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert calls == [
        "ytdlp_fetch",
        "ytdlp_fetch",
        "cobalt_fetch",
        "REPLICATE_SUBMIT(https://tunnel.example/a.mp3)",
    ]


def test_pipeline_long_video_with_yt_dlp_blocked_never_reaches_replicate_via_cobalt(
    monkeypatch: pytest.MonkeyPatch,
):
    """The end-to-end form of the Cobalt bypass: REAL download_audio, a 612 s reading, yt-dlp
    blocked twice, Cobalt released. Replicate must see nothing."""
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)
    calls: list[str] = []
    monkeypatch.setattr(downloader.fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(downloader.fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: True)
    monkeypatch.setattr(downloader.fetch_gates, "log_attempt", lambda **kw: None)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")
    monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0.0)
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: 612.0)

    def blocked(_u):
        calls.append("ytdlp_fetch")
        raise DownloadBlockedError("test: blocked")

    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", blocked)
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_url",
        lambda u: calls.append("cobalt_fetch") or "https://tunnel.example/a.mp3",
    )
    submitted = MagicMock(side_effect=AssertionError("Replicate must not be called"))
    monkeypatch.setattr(pipeline, "submit_or_reattach", submitted)
    monkeypatch.setattr(
        pipeline, "_fetch_job", lambda _j: (URL, ["drums"], 4, "youtube", None, None)
    )

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_fail", noop)

    with pytest.raises(DownloadBlockedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    submitted.assert_not_called()
    assert calls == ["ytdlp_fetch", "ytdlp_fetch"]


# ------------------------------ the metadata reader itself ------------------------------


@pytest.mark.parametrize(
    "stdout,rc,expected",
    [
        ("612.0\n", 0, 612.0),
        ("612\n", 0, 612.0),
        ("NA\n", 0, None),  # yt-dlp's own "field absent" output
        ("", 0, None),
        ("0\n", 0, None),
        ("-5\n", 0, None),
        ("inf\n", 0, None),
        ("612.0\n", 1, None),  # a failed probe is unknown, not short
    ],
)
def test_probe_duration_sec_reads_yt_dlp_output(
    monkeypatch: pytest.MonkeyPatch, stdout: str, rc: int, expected: float | None
):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(
        ytdlp_client.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, rc, stdout, ""),
    )
    assert ytdlp_client.probe_duration_sec(URL) == expected


def test_probe_duration_sec_downloads_nothing_and_is_bounded(monkeypatch: pytest.MonkeyPatch):
    seen: dict = {}

    def spy(cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        return subprocess.CompletedProcess(cmd, 0, "100\n", "")

    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", spy)
    ytdlp_client.probe_duration_sec(URL)
    assert "--simulate" in seen["cmd"]  # metadata only: no media request, no bytes
    assert seen["kw"]["timeout"] == 15  # cannot hang the worker thread


def test_probe_timeout_is_unknown_not_short(monkeypatch: pytest.MonkeyPatch):
    def boom(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 15)

    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", boom)
    assert ytdlp_client.probe_duration_sec(URL) is None


# --------------------- the retired codes stay defined (old rows, copy map) ---------------------


def test_the_too_long_codes_stay_defined_for_old_rows():
    assert LinkTooLongError.error_code == "UPLOAD_TOO_LONG"
    assert "UPLOAD_TOO_LONG" in ALL_ERROR_CODES
    assert issubclass(LinkTooLongError, UploadTooLongError)
    assert "5 minutes" in LinkTooLongError(max_seconds=300.0).user_message


def test_nothing_in_the_worker_raises_a_too_long_error_any_more():
    """Item 6 of the change: the codes are defined but no code path raises them for length."""
    import inspect

    from worker import downloader as dl_pkg

    for mod in (pipeline, dl_pkg, ytdlp_client):
        src = inspect.getsource(mod)
        assert "raise LinkTooLongError" not in src, mod.__name__
        assert "raise UploadTooLongError" not in src, mod.__name__
