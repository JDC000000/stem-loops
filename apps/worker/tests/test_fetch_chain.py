"""SL21 Phase 0: fetch chain order, kill switches, blocklist, attempt logging (offline).

The gate layer (fetch_gates) and both fetchers are faked, so no DB, network or proxy is touched.
BUILD-R s2.2 order: blocklist -> kill switch -> yt-dlp (attempt 1, attempt 2 on Blocked/Timeout)
-> Cobalt only if scope fetch_cobalt is released -> typed error.
"""

import pytest

from worker import downloader
from worker.downloader import fetch_gates
from worker.errors import (
    DownloadAgeRestrictedError,
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadTimeoutError,
    FetchPausedError,
    VideoBlocklistedError,
)

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
VID = "dQw4w9WgXcQ"
JOB = "11111111-1111-1111-1111-111111111111"


class Rig:
    """Records the order of every external effect in `calls`."""

    def __init__(self, monkeypatch):
        self.calls: list[str] = []
        self.attempts: list[dict] = []
        self.ytdlp_results: list = []  # items: str path -> success, Exception -> raise
        self.cobalt_result: object = "https://cobalt.example/tunnel/abc"
        self.blocklisted = False
        self.paused: str | None = None
        self.cobalt_released = False

        def fake_ytdlp(url):
            self.calls.append("ytdlp")
            item = self.ytdlp_results.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        def fake_cobalt(url):
            self.calls.append("cobalt")
            if isinstance(self.cobalt_result, Exception):
                raise self.cobalt_result
            return self.cobalt_result

        def fake_blocklisted(video_id):
            self.calls.append("blocklist")
            assert video_id == VID
            return self.blocklisted

        def fake_paused():
            self.calls.append("kill_switch")
            return self.paused

        def fake_cobalt_allowed():
            self.calls.append("cobalt_switch")
            return self.cobalt_released

        monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", fake_ytdlp)
        monkeypatch.setattr(downloader.cobalt_client, "fetch_audio_url", fake_cobalt)
        monkeypatch.setattr(fetch_gates, "is_blocklisted", fake_blocklisted)
        monkeypatch.setattr(fetch_gates, "fetch_paused", fake_paused)
        monkeypatch.setattr(fetch_gates, "cobalt_allowed", fake_cobalt_allowed)
        monkeypatch.setattr(fetch_gates, "log_attempt", lambda **kw: self.attempts.append(kw))
        monkeypatch.setattr(downloader, "YTDLP_MAX_ATTEMPTS", 2)
        monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0)
        monkeypatch.setattr(downloader.time, "sleep", lambda s: None)


@pytest.fixture
def rig(monkeypatch):
    return Rig(monkeypatch)


def test_ytdlp_is_first_and_cobalt_never_called_on_success(rig):
    rig.ytdlp_results = ["/tmp/a.wav"]
    rig.cobalt_released = True
    assert downloader.download_audio(URL, JOB) == ("/tmp/a.wav", "ytdlp")
    assert rig.calls == ["blocklist", "kill_switch", "ytdlp"]


def test_chain_order_gates_then_ytdlp_twice_then_cobalt(rig):
    rig.ytdlp_results = [DownloadBlockedError("x"), DownloadTimeoutError("y")]
    rig.cobalt_released = True
    assert downloader.download_audio(URL, JOB) == ("https://cobalt.example/tunnel/abc", "cobalt")
    assert rig.calls == ["blocklist", "kill_switch", "ytdlp", "ytdlp", "cobalt_switch", "cobalt"]


def test_ytdlp_retry_recovers_on_second_attempt(rig):
    rig.ytdlp_results = [DownloadBlockedError("x"), "/tmp/b.wav"]
    assert downloader.download_audio(URL, JOB) == ("/tmp/b.wav", "ytdlp")
    assert rig.calls.count("ytdlp") == 2 and "cobalt" not in rig.calls


def test_cobalt_off_by_default_is_skipped_and_typed_error_raised(rig):
    rig.ytdlp_results = [DownloadBlockedError("x"), DownloadBlockedError("y")]
    with pytest.raises(DownloadBlockedError):
        downloader.download_audio(URL, JOB)
    assert "cobalt" not in rig.calls
    assert rig.calls[-1] == "cobalt_switch"


def test_cobalt_failure_surfaces_the_ytdlp_typed_error(rig):
    rig.ytdlp_results = [DownloadBlockedError("x"), DownloadTimeoutError("last")]
    rig.cobalt_released = True
    rig.cobalt_result = RuntimeError("cobalt down")
    with pytest.raises(DownloadTimeoutError):
        downloader.download_audio(URL, JOB)
    assert rig.calls[-1] == "cobalt"


def test_non_retryable_error_stops_without_retry_or_cobalt(rig):
    rig.ytdlp_results = [DownloadAgeRestrictedError("age")]
    rig.cobalt_released = True
    with pytest.raises(DownloadAgeRestrictedError):
        downloader.download_audio(URL, JOB)
    assert rig.calls == ["blocklist", "kill_switch", "ytdlp"]


@pytest.mark.parametrize("scope", ["fetch_global", "fetch_youtube"])
def test_kill_switch_engaged_refuses_before_any_fetch(rig, scope):
    rig.paused = scope
    rig.cobalt_released = True
    with pytest.raises(FetchPausedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "DOWNLOAD_BLOCKED"
    assert "Drop your own audio file" in ei.value.user_message
    assert rig.calls == ["blocklist", "kill_switch"]
    assert rig.attempts == []


def test_blocklist_hit_refused_before_kill_switch_and_fetch(rig):
    rig.blocklisted = True
    with pytest.raises(VideoBlocklistedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "DOWNLOAD_PRIVATE"
    assert rig.calls == ["blocklist"]


def test_unreadable_video_id_is_refused(rig):
    with pytest.raises(DownloadInvalidUrlError):
        downloader.download_audio("https://www.youtube.com/@somechannel", JOB)
    assert rig.calls == []


def test_one_attempt_row_per_attempt_with_sequential_numbers(rig, tmp_path):
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"12345")
    rig.ytdlp_results = [DownloadBlockedError("x"), DownloadTimeoutError("y")]
    rig.cobalt_released = True
    downloader.download_audio(URL, JOB)
    assert [(a["attempt"], a["path"], a["outcome_class"]) for a in rig.attempts] == [
        (1, "ytdlp_direct", "DOWNLOAD_BLOCKED"),
        (2, "ytdlp_direct", "DOWNLOAD_TIMEOUT"),
        (3, "cobalt", "ok"),
    ]
    assert all(a["job_id"] == JOB and a["video_id"] == VID for a in rig.attempts)

    rig.attempts.clear()
    rig.ytdlp_results = [str(wav)]
    downloader.download_audio(URL, JOB)
    assert len(rig.attempts) == 1
    assert rig.attempts[0]["outcome_class"] == "ok" and rig.attempts[0]["nbytes"] == 5


def test_unexpected_exception_is_logged_then_propagates(rig):
    rig.ytdlp_results = [FileNotFoundError("no python")]
    with pytest.raises(FileNotFoundError):
        downloader.download_audio(URL, JOB)
    assert [a["outcome_class"] for a in rig.attempts] == ["other_error"]


@pytest.mark.parametrize(
    "url,vid",
    [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"),
        ("https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/playlist?list=PL123", None),
        ("https://www.youtube.com/watch?v=short", None),
    ],
)
def test_video_id_from_url(url, vid):
    assert fetch_gates.video_id_from_url(url) == vid
