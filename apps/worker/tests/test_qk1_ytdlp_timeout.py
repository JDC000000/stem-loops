"""QK-1: the yt-dlp per-attempt wall-clock bound and how OUR timeout is classified.

``TIMEOUT`` bounds the WHOLE yt-dlp run (extractor + full media download + ffmpeg WAV
conversion; ``_run_download`` kills the process group at ``end_at``), not a socket read. A long
video is fetched in full on purpose, so the bound now grows with the length gate 0c declared,
capped, and a proxied run cut by it AFTER media bytes arrived is FETCH_PROXY_FAILED
(``download_timeout``): retried, and ours (allowance restored) as a final error.

Offline: the subprocess and the gates are faked at the seams the other fetch tests use.
"""

from __future__ import annotations

import time

import pytest

from worker import downloader, fetch_alerts, job_failure
from worker.downloader import fetch_gates, ytdlp_client
from worker.errors import DownloadTimeoutError, FetchProxyFailedError

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "11111111-1111-1111-1111-111111111111"
PROXY = "http://someuser:s3cr3tpass@geo.iproyal.com:12321"


# ------------------------------------------------------------------- attempt_timeout_s


@pytest.fixture(autouse=True)
def _clean_declared():
    ytdlp_client.set_declared_duration(None)
    yield
    ytdlp_client.set_declared_duration(None)


@pytest.mark.parametrize(
    ("declared", "expected"),
    [
        (None, 30.0),  # unknown length: exactly as before
        (0, 30.0),
        (-60, 30.0),
        (float("nan"), 30.0),
        ("garbage", 30.0),
        (240, 40.0),  # 4-min song: 30 + 2.5 * 4
        (900, 67.5),  # 15-min video
        (1800, 105.0),  # 30-min video
        (2160, 120.0),  # 36 min reaches the ceiling
        (36000, 120.0),  # 10-hour mix: capped
        (float("inf"), 120.0),
    ],
)
def test_bound_scales_with_declared_length_and_is_capped(monkeypatch, declared, expected):
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    assert ytdlp_client.attempt_timeout_s(declared) == pytest.approx(expected)


def test_bound_is_never_below_timeout_even_if_ceiling_is(monkeypatch):
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    monkeypatch.setattr(ytdlp_client, "TIMEOUT_CEILING_S", 10.0)
    assert ytdlp_client.attempt_timeout_s(3600) == 30.0
    assert ytdlp_client.attempt_timeout_s(None) == 30.0


def test_bound_reads_the_declared_length_set_for_this_thread(monkeypatch):
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    ytdlp_client.set_declared_duration(1800)
    assert ytdlp_client.attempt_timeout_s() == pytest.approx(105.0)
    ytdlp_client.set_declared_duration(None)
    assert ytdlp_client.attempt_timeout_s() == 30.0


def test_link_stage_paper_worst_case_exceeds_the_stale_window_so_it_must_heartbeat():
    """Review F2: probe 15 + 2 x (live 15 + bound + kill waits 15) + delay 2 + trim (ffprobe 30
    + ffmpeg FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT + ffprobe 30) is already >= 300 s with a ZERO
    bound, before the R2 PUT (bounded since #491). No ceiling makes it fit: the stage heartbeats
    (pinned in test_link_fetch_trim_and_staging_run_inside_the_stage_heartbeat)."""
    from worker import pipeline, reaper  # noqa: PLC0415

    trim = 30 + pipeline.FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT + 30
    worst_zero_bound = 15 + 2 * (15 + 0 + 15) + 2 + trim
    worst = 15 + 2 * (15 + ytdlp_client.TIMEOUT_CEILING_S + 15) + 2 + trim
    assert worst_zero_bound < reaper.STALE_SECONDS < worst


# ------------------------------------------------------------------- fetch_audio_file


@pytest.fixture
def fake_download(monkeypatch, tmp_path):
    box: dict = {"script": [], "timeouts": []}

    def fake_run(cmd, timeout_s, first_byte_deadline):
        box["timeouts"].append(timeout_s)
        kind = box["script"].pop(0)
        now = time.monotonic()
        if kind == "timeout_with_bytes":
            return ytdlp_client.DownloadRun(ytdlp_client.TIMED_OUT, None, "", now)
        if kind == "timeout_no_bytes":
            return ytdlp_client.DownloadRun(ytdlp_client.TIMED_OUT, None, "", None)
        (tmp_path / "dQw4w9WgXcQ.wav").write_bytes(b"RIFF")
        return ytdlp_client.DownloadRun(ytdlp_client.EXITED, 0, "", now)

    monkeypatch.setattr(ytdlp_client, "_run_download", fake_run)
    monkeypatch.setattr(ytdlp_client, "_reject_if_live", lambda url, proxy: None)
    monkeypatch.setattr(ytdlp_client.tmpdirs, "mkdtemp", lambda prefix: str(tmp_path))
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    monkeypatch.delenv("FETCH_FIRST_BYTE_DEADLINE_SEC", raising=False)
    return box


def test_fetch_passes_the_scaled_bound_to_the_run(fake_download):
    ytdlp_client.set_declared_duration(1800)
    fake_download["script"] = ["ok"]
    ytdlp_client.fetch_audio_file(URL)
    assert fake_download["timeouts"] == [pytest.approx(105.0)]


def test_proxied_timeout_with_bytes_is_our_fault_and_retryable(fake_download):
    ytdlp_client.set_declared_duration(900)  # 15 min: bound 67.5 s, under the ceiling
    fake_download["script"] = ["timeout_with_bytes"]
    with pytest.raises(FetchProxyFailedError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    e = ei.value
    assert e.cause == ytdlp_client.DOWNLOAD_TIMEOUT_CAUSE == "download_timeout"
    assert e.retryable
    assert e.error_code in job_failure.OUR_FAULT_CODES  # allowance given back if final
    assert "s3cr3tpass" not in str(e) and "s3cr3tpass" not in (e.detail or "")


def test_proxied_timeout_without_bytes_is_unchanged(fake_download):
    """Review B-1's decision stands: a final attempt that never got a byte stays
    DOWNLOAD_TIMEOUT(first_byte_stall)."""
    ytdlp_client.set_declared_duration(900)
    fake_download["script"] = ["timeout_no_bytes"]
    with pytest.raises(DownloadTimeoutError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert not isinstance(ei.value, FetchProxyFailedError)
    assert ei.value.failure_reason == "first_byte_stall"
    assert ei.value.error_code not in job_failure.OUR_FAULT_CODES


def test_direct_timeout_with_bytes_is_unchanged(fake_download, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    ytdlp_client.set_declared_duration(900)
    fake_download["script"] = ["timeout_with_bytes"]
    with pytest.raises(DownloadTimeoutError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert not isinstance(ei.value, FetchProxyFailedError)


def test_refund_policy_tuple_is_unchanged():
    """QK-1 reuses FETCH_PROXY_FAILED; the money tuple itself is not touched."""
    assert job_failure.OUR_FAULT_CODES == (
        "SEPARATION_FAILED",
        "UPLOAD_FAILED",
        "INTERNAL_ERROR",
        "FETCH_PROXY_FAILED",
    )
    assert "DOWNLOAD_TIMEOUT" not in job_failure.OUR_FAULT_CODES


# ------------------------------------------------------------------- download_audio chain


@pytest.fixture
def gates(monkeypatch):
    attempts: list[dict] = []
    monkeypatch.setattr(fetch_gates, "is_blocklisted", lambda vid: False)
    monkeypatch.setattr(fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(fetch_gates, "cobalt_allowed", lambda: False)
    monkeypatch.setattr(fetch_gates, "log_attempt", lambda **kw: attempts.append(kw))
    monkeypatch.setattr(fetch_gates, "ytdlp_version", lambda: "test")
    monkeypatch.setattr(downloader, "YTDLP_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0)
    monkeypatch.setattr(downloader.time, "sleep", lambda s: None)
    monkeypatch.setattr(downloader.fetch_canary, "outage_confirmed", lambda: None)
    return attempts


def _probe(duration):
    return lambda url, proxy=None: ytdlp_client.LinkMetadata(duration_sec=duration, title="t")


def test_long_video_gets_the_scaled_bound_on_every_attempt(fake_download, gates, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "probe_metadata", _probe(1800.0))
    fake_download["script"] = ["timeout_with_bytes", "ok"]
    path, source = downloader.download_audio(URL, JOB, max_duration_sec=300.0)
    assert source == "ytdlp" and path.endswith(".wav")
    assert fake_download["timeouts"] == [pytest.approx(105.0)] * 2
    assert [r["outcome_class"] for r in gates] == ["FETCH_PROXY_FAILED", "ok"]
    assert getattr(ytdlp_client._attempt, "declared_sec", None) is None, "cleared after the job"


def test_under_cap_video_timing_out_twice_fails_as_ours(fake_download, gates, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "probe_metadata", _probe(1800.0))
    fake_download["script"] = ["timeout_with_bytes", "timeout_with_bytes"]
    with pytest.raises(FetchProxyFailedError) as ei:
        downloader.download_audio(URL, JOB, max_duration_sec=300.0)
    assert ei.value.cause == "download_timeout"
    assert ei.value.error_code in job_failure.OUR_FAULT_CODES
    assert fake_download["timeouts"] == [pytest.approx(105.0)] * 2
    assert getattr(ytdlp_client._attempt, "declared_sec", None) is None, "cleared after a failure"


# ------------------------------------------------------------------- review F1: the cap boundary
# 30 + 2.5 * d / 60 <= 120  <=>  d <= 2160 s (36 min). At or under: the bound was sized for the
# video, a cut with bytes flowing is ours. Over: the ceiling applied, the cut is the video's
# length (Jon 2026-11-18: no refund for over length) -> DOWNLOAD_TIMEOUT, as before QK-1.


@pytest.mark.parametrize(
    ("declared", "fit"),
    [
        (None, False),  # unknown: never ours
        (0, False),
        (float("nan"), False),
        (60, True),
        (2159.0, True),
        (2160.0, True),  # exactly at the ceiling: the bound still covers the length
        (2160.5, False),
        (2161.0, False),
        (36000.0, False),
        (float("inf"), False),
    ],
)
def test_bound_is_fit_marks_the_ceiling_boundary(monkeypatch, declared, fit):
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    assert ytdlp_client.bound_is_fit(declared) is fit


@pytest.mark.parametrize(("declared", "ours"), [(2160.0, True), (2161.0, False)])
def test_cut_on_either_side_of_the_cap(fake_download, declared, ours):
    ytdlp_client.set_declared_duration(declared)
    fake_download["script"] = ["timeout_with_bytes"]
    with pytest.raises(DownloadTimeoutError if not ours else FetchProxyFailedError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert fake_download["timeouts"] == [120.0]  # same bound on both sides
    assert (ei.value.error_code in job_failure.OUR_FAULT_CODES) is ours
    if not ours:
        assert not isinstance(ei.value, FetchProxyFailedError)
        assert ei.value.error_code == "DOWNLOAD_TIMEOUT"
        assert ei.value.failure_reason is None


def test_unknown_length_cut_with_bytes_stays_download_timeout(fake_download):
    fake_download["script"] = ["timeout_with_bytes"]
    with pytest.raises(DownloadTimeoutError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert not isinstance(ei.value, FetchProxyFailedError)
    assert fake_download["timeouts"] == [30.0]


def test_over_cap_video_timing_out_twice_is_not_ours(fake_download, gates, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "probe_metadata", _probe(3600.0))
    fake_download["script"] = ["timeout_with_bytes", "timeout_with_bytes"]
    with pytest.raises(DownloadTimeoutError) as ei:
        downloader.download_audio(URL, JOB, max_duration_sec=300.0)
    assert not isinstance(ei.value, FetchProxyFailedError)
    assert ei.value.error_code not in job_failure.OUR_FAULT_CODES
    assert fake_download["timeouts"] == [120.0, 120.0]
    assert [r["outcome_class"] for r in gates] == ["DOWNLOAD_TIMEOUT"] * 2


def test_repeat_submissions_of_an_over_cap_video_never_become_ours(
    fake_download, gates, monkeypatch
):
    """F1: the same too-long link sent again and again fails the same user-class way every
    time -- no allowance restore, and no per-process FETCH_PROXY_FAILED Sentry error (that
    path only runs for an OUR_FAULT code). Same classification as v3/main before QK-1."""
    monkeypatch.setattr(ytdlp_client, "probe_metadata", _probe(5400.0))
    codes = []
    for _ in range(4):
        fake_download["script"] = ["timeout_with_bytes", "timeout_with_bytes"]
        with pytest.raises(DownloadTimeoutError) as ei:
            downloader.download_audio(URL, JOB, max_duration_sec=300.0)
        codes.append(ei.value.error_code)
    assert codes == ["DOWNLOAD_TIMEOUT"] * 4
    assert all(r["outcome_class"] == "DOWNLOAD_TIMEOUT" for r in gates)
    assert all(c not in job_failure.OUR_FAULT_CODES for c in codes)


def test_repeat_submissions_of_an_under_cap_video_are_ours_each_time(
    fake_download, gates, monkeypatch
):
    """The other side: a video our bound was sized for, cut while bytes flowed, is ours every
    time (the bound, not the video, is what failed)."""
    monkeypatch.setattr(ytdlp_client, "probe_metadata", _probe(1200.0))
    for _ in range(3):
        fake_download["script"] = ["timeout_with_bytes", "timeout_with_bytes"]
        with pytest.raises(FetchProxyFailedError):
            downloader.download_audio(URL, JOB, max_duration_sec=300.0)


def test_no_cap_means_no_probe_and_the_old_bound(fake_download, gates, monkeypatch):
    monkeypatch.setattr(
        ytdlp_client, "probe_metadata", lambda *a, **k: pytest.fail("no gate 0c without a cap")
    )
    ytdlp_client.set_declared_duration(9999)  # a stale value must not leak into this job
    fake_download["script"] = ["ok"]
    downloader.download_audio(URL, JOB)
    assert fake_download["timeouts"] == [30.0]


def test_unreadable_length_keeps_the_old_bound(fake_download, gates, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "probe_metadata", _probe(None))
    fake_download["script"] = ["ok"]
    downloader.download_audio(URL, JOB, max_duration_sec=300.0)
    assert fake_download["timeouts"] == [30.0]


# ------------------------------------------------------------------- alerting


def test_download_timeout_cause_has_its_own_sentry_message():
    msg = fetch_alerts._PROXY_FAILURE_MESSAGES["download_timeout"].format(cause="download_timeout")
    assert "credentials" not in msg and "wall-clock" in msg


# ------------------------------------------------------------------- review F2: heartbeat


def test_link_fetch_trim_and_staging_run_inside_the_stage_heartbeat(monkeypatch, tmp_path):
    import asyncio  # noqa: PLC0415
    import contextlib  # noqa: PLC0415
    from unittest.mock import MagicMock  # noqa: PLC0415

    from worker import pipeline  # noqa: PLC0415
    from worker.errors import SeparationFailedError  # noqa: PLC0415

    order: list[str] = []

    @contextlib.asynccontextmanager
    async def tracking_heartbeat(job_id):
        order.append("hb_enter")
        try:
            yield
        finally:
            order.append("hb_exit")

    def fake_download(_url, _job, cap=None, meta=None):
        order.append("download")
        return str(tmp_path / "a.wav"), "ytdlp"

    async def noop(*a, **k):
        return None

    async def status(job_id, s):
        order.append(f"status:{s}")

    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.setattr(pipeline, "_stage_heartbeat", tracking_heartbeat)
    monkeypatch.setattr(pipeline, "download_audio", fake_download)
    monkeypatch.setattr(
        pipeline, "_trim_link_source", lambda j, p, s=None: order.append("trim") or (p, None)
    )
    monkeypatch.setattr(pipeline, "upload_input", lambda j, p: order.append("stage") or "https://x")
    monkeypatch.setattr(
        pipeline, "submit_or_reattach", MagicMock(side_effect=SeparationFailedError("sentinel"))
    )
    monkeypatch.setattr(
        pipeline, "_fetch_job", lambda _j: (URL, ["drums"], 4, "youtube", None, None)
    )
    monkeypatch.setattr(pipeline, "_record_title", lambda *a: None)
    monkeypatch.setattr(pipeline, "set_status", status)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_fail", noop)
    with contextlib.suppress(SeparationFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    i = order.index("hb_enter")
    assert order[i : i + 5] == ["hb_enter", "download", "trim", "stage", "hb_exit"], order
    assert order.index("hb_exit") < order.index("status:separating")
