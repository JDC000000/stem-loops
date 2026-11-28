"""#491: videos longer than ~36 minutes, and the R2 PUT that stages a link's input.

1. A video whose full fetch cannot fit the per-attempt ceiling (QK-1: TIMEOUT + 2.5 s per
   declared minute, capped at TIMEOUT_CEILING_S, so past 36 min at the shipped values) failed
   DOWNLOAD_TIMEOUT every time, although Jon's rule is that a long song is converted from its
   first 5 minutes, never refused. Such a video is now cut AT DOWNLOAD (yt-dlp
   ``--download-sections``, same yt-dlp run, same sticky proxy string, so the same exit IP), and
   the user is still told the song was trimmed and from what length. Every video whose full
   fetch fits keeps the proven full-fetch path, unchanged.
2. The R2 PUT of the staged link WAV had no wall-clock bound. It now has one; past it the job
   fails INTERNAL_ERROR, the existing our-fault path (in OUR_FAULT_CODES: song given back).

Offline: subprocess, gates and R2 are faked at the seams the other fetch tests use.
"""

from __future__ import annotations

import asyncio
import math
import struct
import threading
import time
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from worker import downloader, job_failure, pipeline
from worker.downloader import ytdlp_client
from worker.errors import DownloadTimeoutError, FetchProxyFailedError, SeparationFailedError

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "00000000-0000-4000-8000-0000000d0491"
PROXY = "http://someuser:s3cr3tpass@geo.iproyal.com:12321"


@pytest.fixture(autouse=True)
def _clean_declared(monkeypatch):
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    ytdlp_client.set_declared_duration(None)
    yield
    ytdlp_client.set_declared_duration(None)
    # A faked fetch_audio_file never consumes download_audio's stall-cut flag: clear it so it
    # cannot leak into a later test on this thread.
    ytdlp_client.begin_attempt(stall_cut=False)


def _wav(path: Path, secs: float, sr: int = 8000) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(struct.pack("<h", int(3000 * math.sin(i / 20))) for i in range(int(sr * secs)))
        )
    return path


# ------------------------------------------------------------- when to cut at download


@pytest.mark.parametrize(
    ("declared", "cap", "expected"),
    [
        (2400, 300.0, 300.0),  # 40 min: the full fetch cannot fit the 120 s ceiling
        (2161, 300.0, 300.0),  # just past 36 min
        (36000, 300.0, 300.0),  # 10-hour mix
        (float("inf"), 300.0, 300.0),
        (2160, 300.0, None),  # 36 min exactly: its bound IS the ceiling, so it fits
        (1800, 300.0, None),  # 30 min: the proven full fetch, unchanged
        (600, 300.0, None),
        (200, 300.0, None),  # under the cap: nothing to cut
        (None, 300.0, None),  # unknown length: as before
        (float("nan"), 300.0, None),
        (2400, None, None),  # no cap passed: nothing to cut to
        (2400, 0.0, None),
        (2400, -5.0, None),
        (2400, float("nan"), None),
        (2400, float("inf"), None),
        (2400, "garbage", None),
    ],
)
def test_download_trim_sec(declared, cap, expected):
    assert ytdlp_client.download_trim_sec(declared, cap) == expected


def test_download_trim_sec_reads_what_was_set_for_this_thread():
    ytdlp_client.set_declared_duration(2400, 137.0)
    assert ytdlp_client.download_trim_sec() == 137.0
    ytdlp_client.set_declared_duration(None)
    assert ytdlp_client.download_trim_sec() is None  # the cap is cleared with the length


# ------------------------------------------------------------- fetch_audio_file


@pytest.fixture
def fake_download(monkeypatch, tmp_path):
    box: dict = {"script": [], "cmds": [], "timeouts": [], "deadlines": []}

    def fake_run(cmd, timeout_s, first_byte_deadline):
        box["cmds"].append(cmd)
        box["timeouts"].append(timeout_s)
        box["deadlines"].append(first_byte_deadline)
        kind = box["script"].pop(0)
        if kind == "timeout_no_progress":
            return ytdlp_client.DownloadRun(ytdlp_client.TIMED_OUT, None, "", None)
        (tmp_path / "dQw4w9WgXcQ.wav").write_bytes(b"RIFF")
        return ytdlp_client.DownloadRun(ytdlp_client.EXITED, 0, "", time.monotonic())

    monkeypatch.setattr(ytdlp_client, "_run_download", fake_run)
    monkeypatch.setattr(ytdlp_client, "_reject_if_live", lambda url, proxy: None)
    monkeypatch.setattr(ytdlp_client.tmpdirs, "mkdtemp", lambda prefix: str(tmp_path))
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    monkeypatch.delenv("FETCH_FIRST_BYTE_DEADLINE_SEC", raising=False)
    return box


def _section_args(cmd: list[str]) -> list[str] | None:
    if "--download-sections" not in cmd:
        return None
    i = cmd.index("--download-sections")
    return cmd[i : i + 2]


def test_a_very_long_video_is_cut_at_download_in_the_same_proxied_run(fake_download):
    ytdlp_client.set_declared_duration(2400, 300.0)
    fake_download["script"] = ["ok"]
    ytdlp_client.begin_attempt(stall_cut=True)
    ytdlp_client.fetch_audio_file(URL)
    (cmd,) = fake_download["cmds"]
    assert _section_args(cmd) == ["--download-sections", "*0-300"]
    # an option, before the `--` that ends option parsing, never after it
    assert cmd.index("--download-sections") < cmd.index("--")
    # the same single run carries the sticky proxy string (same exit IP for every request)
    assert "--proxy" in cmd and "_session-" in cmd[cmd.index("--proxy") + 1]
    # ffmpeg's section download reports no progress until it ends: never a first-byte cut
    assert fake_download["deadlines"] == [None]
    assert fake_download["timeouts"] == [pytest.approx(ytdlp_client.TIMEOUT_CEILING_S)]


@pytest.mark.parametrize("declared", [None, 200, 600, 1800, 2160])
def test_every_video_whose_full_fetch_fits_keeps_the_full_fetch(fake_download, declared):
    ytdlp_client.set_declared_duration(declared, 300.0)
    fake_download["script"] = ["ok"]
    ytdlp_client.begin_attempt(stall_cut=True)
    ytdlp_client.fetch_audio_file(URL)
    (cmd,) = fake_download["cmds"]
    assert _section_args(cmd) is None
    assert fake_download["deadlines"] == [ytdlp_client.FIRST_BYTE_DEADLINE_DEFAULT_S]


def test_a_cut_at_download_run_that_times_out_stays_download_timeout(fake_download):
    """No new refund route: the section run shows no progress, so a timeout cannot be shown to
    be our exit's fault. It fails as every >36 min video failed before (DOWNLOAD_TIMEOUT, not
    in OUR_FAULT_CODES), and is not mislabelled a first-byte stall."""
    ytdlp_client.set_declared_duration(2400, 300.0)
    fake_download["script"] = ["timeout_no_progress"]
    with pytest.raises(DownloadTimeoutError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert not isinstance(ei.value, FetchProxyFailedError)
    assert ei.value.error_code not in job_failure.OUR_FAULT_CODES
    assert ei.value.failure_reason is None


# ------------------------------------------------------------- download_audio / gate 0c


@pytest.fixture
def chain(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(downloader.fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(downloader.fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: False)
    monkeypatch.setattr(downloader.fetch_gates, "log_attempt", lambda **kw: None)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")

    def fake_fetch(_u):
        seen["trim_sec"] = ytdlp_client.download_trim_sec()
        return "/tmp/a.wav"

    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", fake_fetch)
    return seen


def _probe(duration):
    return lambda _u: ytdlp_client.LinkMetadata(duration_sec=duration, title="t")


def test_download_audio_arms_the_cut_and_reports_the_source_length(chain, monkeypatch):
    monkeypatch.setattr(downloader.ytdlp_client, "probe_metadata", _probe(2400.0))
    meta: dict = {}
    assert downloader.download_audio(URL, JOB, 300.0, meta=meta) == ("/tmp/a.wav", "ytdlp")
    assert chain["trim_sec"] == 300.0
    assert meta["download_trimmed_from_sec"] == 2400.0
    assert ytdlp_client.download_trim_sec() is None  # never carried into the next job


@pytest.mark.parametrize("declared", [None, 120.0, 1800.0])
def test_download_audio_does_not_cut_what_fits(chain, monkeypatch, declared):
    monkeypatch.setattr(downloader.ytdlp_client, "probe_metadata", _probe(declared))
    meta: dict = {}
    downloader.download_audio(URL, JOB, 300.0, meta=meta)
    assert chain["trim_sec"] is None
    assert "download_trimmed_from_sec" not in meta


# ------------------------------------------------------------- the trim detail


def test_a_file_cut_at_download_is_still_reported_as_trimmed(monkeypatch, tmp_path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "first_three.wav", 3.0))
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", MagicMock(side_effect=AssertionError("re-cut")))
    path, trim = pipeline._trim_link_source(JOB, src, 2400.0)
    assert path == src
    assert trim == {"trimmed": True, "source_sec": 2400.0, "used_sec": 3.0}


def test_a_file_cut_at_download_that_overshot_is_recut_and_reports_the_source(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "overshot.wav", 3.5))
    path, trim = pipeline._trim_link_source(JOB, src, 2400.0)
    assert path != src
    assert trim == {"trimmed": True, "source_sec": 2400.0, "used_sec": 3.0}


def test_without_a_download_cut_the_trim_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "short.wav", 2.0))
    assert pipeline._trim_link_source(JOB, src) == (src, None)


# ------------------------------------------------------------- the pipeline


def _rig(monkeypatch, fake_download, events: list, failed: list, upload):
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.setattr(pipeline, "download_audio", fake_download)
    monkeypatch.setattr(pipeline, "upload_input", upload)
    monkeypatch.setattr(
        pipeline,
        "submit_or_reattach",
        MagicMock(side_effect=SeparationFailedError("sentinel: reached the billed call")),
    )
    monkeypatch.setattr(
        pipeline, "_fetch_job", lambda _j: (URL, ["drums"], 4, "youtube", None, None)
    )
    monkeypatch.setattr(pipeline, "_record_title", lambda *a: None)

    async def noop(*a, **k):
        return None

    async def record_event(job_id, stage, phase, pct=None, detail=None):
        events.append((stage, phase, detail))

    async def record_fail(job_id, code, message):
        failed.append(code)

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", record_event)
    monkeypatch.setattr(pipeline, "_fail", record_fail)


def test_pipeline_tells_the_user_a_download_cut_song_was_trimmed(monkeypatch, tmp_path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    src = str(_wav(tmp_path / "cut.wav", 3.0))

    def fake_download(_url, _job, cap=None, meta=None):
        meta["download_trimmed_from_sec"] = 2400.0
        return src, "ytdlp"

    events: list = []
    failed: list = []
    _rig(monkeypatch, fake_download, events, failed, lambda _j, p: "https://presigned")
    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert (
        "downloading",
        "completed",
        {"trimmed": True, "source_sec": 2400.0, "used_sec": 3.0},
    ) in events


def test_the_link_r2_stage_timeout_default():
    assert pipeline.LINK_R2_STAGE_TIMEOUT_SEC_DEFAULT == 120.0


def test_a_hung_r2_put_of_the_link_input_fails_as_our_fault(monkeypatch, tmp_path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    monkeypatch.setenv("LINK_R2_STAGE_TIMEOUT_SEC", "0.2")
    src = str(_wav(tmp_path / "short.wav", 1.0))
    release = threading.Event()

    def hung_upload(_j, _p):
        release.wait(10)  # a PUT that never completes on its own
        return "https://too-late"

    events: list = []
    failed: list = []
    _rig(monkeypatch, lambda *a, **k: (src, "ytdlp"), events, failed, hung_upload)

    async def fail_and_release(job_id, code, message):
        failed.append(code)
        release.set()  # let the abandoned PUT thread end, so asyncio.run can shut down

    monkeypatch.setattr(pipeline, "_fail", fail_and_release)
    t0 = time.monotonic()
    try:
        with pytest.raises(Exception) as ei:
            asyncio.run(asyncio.wait_for(pipeline._run_pipeline(JOB), timeout=5))
        elapsed = time.monotonic() - t0
    finally:
        release.set()
    assert elapsed < 3, "the PUT was not bounded"
    assert ei.value.error_code == "INTERNAL_ERROR"
    assert ei.value.failure_reason == "r2_stage_timeout"
    assert failed == ["INTERNAL_ERROR"]
    assert "INTERNAL_ERROR" in job_failure.OUR_FAULT_CODES  # the song is given back
    pipeline.submit_or_reattach.assert_not_called()  # nothing billed
