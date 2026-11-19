"""QA-61: a failure of OUR proxy is ours -- classified, fail-fast, refunded, alerted. Offline.

From 2026-11-18 23:04Z every link job failed with yt-dlp reporting
``Tunnel connection failed: 407 Proxy Authentication Required`` (lapsed proxy credentials).
It was classed DOWNLOAD_BLOCKED: users read "YouTube is temporarily blocking automated
access", the 407 was retried three times, and nothing reached Sentry. These tests pin:

  * the stderr classification (auth vs connect vs not-a-proxy-failure), on real wording;
  * yt-dlp's client raising FETCH_PROXY_FAILED, never DOWNLOAD_BLOCKED, for those;
  * the chain failing fast on a 407 and retrying only a connect failure;
  * the code being our-fault (refund + Sentry), with honest copy and no credentials;
  * one Sentry ERROR per process per cause, re-armed by recovery;
  * the download-failure burst alert;
  * the kill-switch scope WARN no longer naming spend_global.

No database, no network, no proxy: subprocess, Sentry and the gates are faked.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import types

import pytest

from worker import downloader, fetch_alerts, job_failure, models
from worker.downloader import fetch_gates, ytdlp_client
from worker.errors import (
    ALL_ERROR_CODES,
    DownloadBlockedError,
    DownloadPrivateError,
    FetchPausedError,
    FetchProxyFailedError,
)

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "11111111-1111-1111-1111-111111111111"
PROXY = "http://someuser:s3cr3tpass@geo.iproyal.com:12321"

# The production log line (QA-61), as yt-dlp prints it.
STDERR_407 = (
    "ERROR: [youtube] dQw4w9WgXcQ: Unable to download API page: ('Unable to connect to "
    "proxy', OSError('Tunnel connection failed: 407 Proxy Authentication Required')) "
    "(caused by ProxyError(\"('Unable to connect to proxy', OSError('Tunnel connection "
    "failed: 407 Proxy Authentication Required'))\"))"
)
STDERR_CONNECT = (
    "ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: ('Unable to connect to proxy', "
    "NewConnectionError('<urllib3.connection.HTTPSConnection>: Failed to establish a new "
    "connection: [Errno 111] Connection refused'))"
)
STDERR_TUNNEL_502 = "ERROR: Unable to download webpage: Tunnel connection failed: 502 Bad Gateway"
STDERR_BOT = "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"


# ------------------------------------------------------------------- classification


@pytest.mark.parametrize(
    "stderr,cause",
    [
        (STDERR_407, "proxy_auth"),
        ("Tunnel connection failed: 407", "proxy_auth"),
        ("HTTP Error 407: Proxy Authentication Required", "proxy_auth"),
        (STDERR_CONNECT, "proxy_connect"),
        (STDERR_TUNNEL_502, "proxy_connect"),
        ("requests.exceptions.ProxyError: HTTPSConnectionPool", "proxy_connect"),
        ("Cannot connect to proxy.", "proxy_connect"),
    ],
)
def test_proxy_failures_are_recognised(stderr, cause):
    assert ytdlp_client.proxy_failure_cause(stderr) == cause
    assert ytdlp_client.classify_fetch_failure(stderr) == cause


@pytest.mark.parametrize(
    "stderr",
    [
        STDERR_BOT,
        "ERROR: [youtube] a407b407c40: Video unavailable",  # 407 inside a video id
        "Downloaded 4070 bytes; HTTP Error 403: Forbidden",
        "ERROR: Private video. Sign in if you've been granted access",
        "",
        None,
    ],
)
def test_non_proxy_failures_are_not_called_proxy_failures(stderr):
    assert ytdlp_client.proxy_failure_cause(stderr) is None


def test_canary_cause_classes():
    assert ytdlp_client.classify_fetch_failure(STDERR_BOT) == "youtube_bot_check"
    assert ytdlp_client.classify_fetch_failure("ERROR: something else") == "other"


# ------------------------------------------------------------------- yt-dlp client


@pytest.fixture
def fake_ytdlp(monkeypatch, tmp_path):
    """fetch_audio_file with subprocess faked; returns a setter for the stderr/returncode."""
    box = {"stderr": STDERR_407, "returncode": 1, "cmds": []}

    def fake_run(cmd, *a, **k):
        box["cmds"].append(cmd)
        return types.SimpleNamespace(returncode=box["returncode"], stdout="", stderr=box["stderr"])

    monkeypatch.setattr(ytdlp_client.subprocess, "run", fake_run)
    monkeypatch.setattr(ytdlp_client, "_reject_if_live", lambda url, proxy: None)
    monkeypatch.setattr(ytdlp_client.tmpdirs, "mkdtemp", lambda prefix: str(tmp_path))
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    return box


def test_ytdlp_407_raises_fetch_proxy_failed_not_download_blocked(fake_ytdlp, capsys):
    with pytest.raises(FetchProxyFailedError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert ei.value.error_code == "FETCH_PROXY_FAILED"
    assert ei.value.cause == "proxy_auth"
    assert not isinstance(ei.value, DownloadBlockedError)
    # The credential is in the command line (it has to be), never in the error or the log.
    assert any("s3cr3tpass" in " ".join(c) for c in fake_ytdlp["cmds"])
    assert "s3cr3tpass" not in str(ei.value) and "someuser" not in str(ei.value)
    assert "s3cr3tpass" not in capsys.readouterr().err


def test_ytdlp_proxy_connect_failure(fake_ytdlp):
    fake_ytdlp["stderr"] = STDERR_CONNECT
    with pytest.raises(FetchProxyFailedError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert ei.value.cause == "proxy_connect"
    assert ei.value.retryable is True


def test_ytdlp_without_a_proxy_never_reports_a_proxy_failure(fake_ytdlp, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    with pytest.raises(DownloadBlockedError):
        ytdlp_client.fetch_audio_file(URL)


def test_ytdlp_bot_wall_is_still_download_blocked(fake_ytdlp):
    fake_ytdlp["stderr"] = STDERR_BOT
    with pytest.raises(DownloadBlockedError):
        ytdlp_client.fetch_audio_file(URL)


# ------------------------------------------------------------------- the chain


class Chain:
    def __init__(self, monkeypatch):
        self.ytdlp_results: list = []
        self.ytdlp_calls = 0
        self.cobalt_calls = 0
        self.cobalt_result: object = DownloadBlockedError("cobalt says no")
        self.cobalt_released = True
        self.paused: str | None = None
        self.attempts: list[dict] = []

        def ytdlp(url):
            self.ytdlp_calls += 1
            item = self.ytdlp_results.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        def cobalt(url):
            self.cobalt_calls += 1
            if isinstance(self.cobalt_result, Exception):
                raise self.cobalt_result
            return self.cobalt_result

        monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", ytdlp)
        monkeypatch.setattr(downloader.cobalt_client, "fetch_audio_url", cobalt)
        monkeypatch.setattr(fetch_gates, "is_blocklisted", lambda vid: False)
        monkeypatch.setattr(fetch_gates, "fetch_paused", lambda: self.paused)
        monkeypatch.setattr(fetch_gates, "cobalt_allowed", lambda: self.cobalt_released)
        monkeypatch.setattr(fetch_gates, "log_attempt", lambda **kw: self.attempts.append(kw))
        monkeypatch.setattr(fetch_gates, "ytdlp_version", lambda: "test")
        monkeypatch.setattr(downloader, "YTDLP_MAX_ATTEMPTS", 3)
        monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0)
        monkeypatch.setattr(downloader.time, "sleep", lambda s: None)


@pytest.fixture
def chain(monkeypatch):
    return Chain(monkeypatch)


def test_a_407_fails_fast_once_and_never_reaches_cobalt(chain):
    chain.ytdlp_results = [FetchProxyFailedError("proxy_auth")] * 3
    with pytest.raises(FetchProxyFailedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.cause == "proxy_auth"
    assert chain.ytdlp_calls == 1, "a credential failure is not transient: no retry"
    assert chain.cobalt_calls == 0
    assert [a["outcome_class"] for a in chain.attempts] == ["FETCH_PROXY_FAILED"]


def test_a_proxy_connect_failure_is_retried_then_reported_as_ours(chain):
    chain.ytdlp_results = [FetchProxyFailedError("proxy_connect")] * 3
    with pytest.raises(FetchProxyFailedError):
        downloader.download_audio(URL, JOB)
    assert chain.ytdlp_calls == 3
    assert chain.cobalt_calls == 1, "Cobalt does not use the proxy, so it may still serve"


def test_a_proxy_connect_blip_that_clears_on_retry_succeeds(chain):
    chain.ytdlp_results = [FetchProxyFailedError("proxy_connect"), "/tmp/a.wav"]
    assert downloader.download_audio(URL, JOB) == ("/tmp/a.wav", "ytdlp")


def test_cobalt_serving_after_a_connect_failure_wins(chain):
    chain.ytdlp_results = [FetchProxyFailedError("proxy_connect")] * 3
    chain.cobalt_result = "https://cobalt.example/t"
    assert downloader.download_audio(URL, JOB) == ("https://cobalt.example/t", "cobalt")


# ------------------------------------------------------------------- code, copy, refund


def test_the_code_is_registered_everywhere_the_taxonomy_lives():
    assert "FETCH_PROXY_FAILED" in ALL_ERROR_CODES
    assert "FETCH_PROXY_FAILED" in models.ERROR_CODES
    assert "FETCH_PROXY_FAILED" in job_failure.OUR_FAULT_CODES
    assert "FETCH_PROXY_FAILED" not in job_failure.NEVER_REFUNDED_CODES


def test_the_user_copy_is_honest():
    msg = FetchProxyFailedError("proxy_auth").user_message
    # Pinned verbatim in apps/web/test/job-page-render.test.mjs (the job page shows it).
    assert msg == (
        "Something went wrong on our end fetching this video. "
        "If it used a credit, it has been returned. Try again later."
    )
    assert "on our end" in msg
    assert "on our side" not in msg  # BRAND-TONE avoid list
    assert "YouTube" not in msg and "blocking" not in msg
    assert "credit" in msg and "returned" in msg
    assert "proxy" not in msg.lower()  # implementation detail stays server-side


def test_refund_sql_is_handed_the_proxy_code():
    seen = {}

    class Cur:
        async def fetchone(self):
            return ("user",)

    class Conn:
        async def execute(self, sql, params):
            seen.update(params)
            return Cur()

    assert asyncio.run(job_failure.refund_if_owed(Conn(), JOB)) is True
    assert "FETCH_PROXY_FAILED" in seen["our_fault_codes"]


# ------------------------------------------------------------------- Sentry, once per cause


@pytest.fixture
def sentry(monkeypatch):
    sent: list[dict] = []

    class Scope:
        def __init__(self):
            self.tags, self.extras, self.fingerprint = {}, {}, None

        def set_tag(self, k, v):
            self.tags[k] = v

        def set_extra(self, k, v):
            self.extras[k] = v

        def __enter__(self):
            self._entered = True
            sent_scope.append(self)
            return self

        def __exit__(self, *a):
            return False

    sent_scope: list[Scope] = []

    def capture_message(msg, level=None):
        scope = sent_scope[-1]
        sent.append({"msg": msg, "level": level, "tags": scope.tags, "fp": scope.fingerprint})

    def capture_exception(*a, **k):
        sent.append({"exception": True, **k})

    fake = types.SimpleNamespace(
        new_scope=Scope, capture_message=capture_message, capture_exception=capture_exception
    )
    monkeypatch.setattr(fetch_alerts, "sentry_sdk", fake)
    return sent


def test_proxy_failure_is_one_error_per_cause_per_process(sentry):
    from worker import pipeline

    for _ in range(5):
        pipeline._report_our_fault(FetchProxyFailedError("proxy_auth"))
    pipeline._report_our_fault(FetchProxyFailedError("proxy_connect"))
    assert [(s["level"], s["fp"]) for s in sentry] == [
        ("error", ["fetch-proxy-failed", "proxy_auth"]),
        ("error", ["fetch-proxy-failed", "proxy_connect"]),
    ]
    assert all(s["tags"]["error_code"] == "FETCH_PROXY_FAILED" for s in sentry)
    assert not any(s.get("exception") for s in sentry), "not the per-job warning path"


def test_proxy_failure_report_never_carries_a_credential(sentry, monkeypatch, capsys):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    fetch_alerts.report_proxy_failure("proxy_auth")
    blob = json.dumps(sentry) + capsys.readouterr().err
    assert "s3cr3tpass" not in blob and "someuser" not in blob and "iproyal" not in blob


def test_rearm_lets_the_next_outage_report(sentry):
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True
    assert fetch_alerts.report_proxy_failure("proxy_auth") is False
    fetch_alerts.rearm_proxy_failure_reports()
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True
    assert len(sentry) == 2


def test_other_our_fault_codes_keep_the_per_job_warning(monkeypatch, sentry):
    from worker import pipeline
    from worker.errors import UploadFailedError

    captured = []
    monkeypatch.setattr(
        pipeline.sentry_sdk, "capture_exception", lambda exc, **k: captured.append(k)
    )
    pipeline._report_our_fault(UploadFailedError("r2 down"))
    assert captured and captured[0]["level"] == "warning"
    assert sentry == []


# ------------------------------------------------------------------- burst alert


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_burst_alerts_once_on_n_distinct_videos_with_the_same_code(sentry):
    clock = Clock()
    d = fetch_alerts.DownloadBurstDetector(threshold=3, window_s=1800, clock=clock)
    assert d.record_failure("DOWNLOAD_BLOCKED", "aaaaaaaaaaa") is False
    assert d.record_failure("DOWNLOAD_BLOCKED", "bbbbbbbbbbb") is False
    assert d.record_failure("DOWNLOAD_BLOCKED", "ccccccccccc") is True
    assert d.record_failure("DOWNLOAD_BLOCKED", "ddddddddddd") is False  # once per streak
    assert len(sentry) == 1
    assert sentry[0]["level"] == "error"
    assert sentry[0]["fp"] == ["download-failure-burst", "DOWNLOAD_BLOCKED"]
    assert "aaaaaaaaaaa" not in json.dumps(sentry)  # no video ids


def test_burst_needs_different_videos(sentry):
    d = fetch_alerts.DownloadBurstDetector(threshold=3, window_s=1800, clock=Clock())
    for _ in range(10):
        assert d.record_failure("DOWNLOAD_PRIVATE", "aaaaaaaaaaa") is False
    assert sentry == []


def test_burst_streak_is_broken_by_success_or_a_different_code(sentry):
    d = fetch_alerts.DownloadBurstDetector(threshold=3, window_s=1800, clock=Clock())
    d.record_failure("DOWNLOAD_BLOCKED", "aaaaaaaaaaa")
    d.record_failure("DOWNLOAD_BLOCKED", "bbbbbbbbbbb")
    d.record_success()
    d.record_failure("DOWNLOAD_BLOCKED", "ccccccccccc")
    d.record_failure("DOWNLOAD_TIMEOUT", "ddddddddddd")
    d.record_failure("DOWNLOAD_BLOCKED", "eeeeeeeeeee")
    assert sentry == []


def test_burst_window_drops_old_failures(sentry):
    clock = Clock()
    d = fetch_alerts.DownloadBurstDetector(threshold=3, window_s=1800, clock=clock)
    d.record_failure("DOWNLOAD_BLOCKED", "aaaaaaaaaaa")
    clock.t = 1000
    d.record_failure("DOWNLOAD_BLOCKED", "bbbbbbbbbbb")
    clock.t = 1900  # the first is now 31+ minutes old
    assert d.record_failure("DOWNLOAD_BLOCKED", "ccccccccccc") is False
    clock.t = 2000
    assert d.record_failure("DOWNLOAD_BLOCKED", "ddddddddddd") is True


def test_burst_rearms_after_the_streak_ends(sentry):
    d = fetch_alerts.DownloadBurstDetector(threshold=2, window_s=1800, clock=Clock())
    d.record_failure("DOWNLOAD_BLOCKED", "aaaaaaaaaaa")
    assert d.record_failure("DOWNLOAD_BLOCKED", "bbbbbbbbbbb") is True
    d.record_success()
    d.record_failure("DOWNLOAD_BLOCKED", "ccccccccccc")
    assert d.record_failure("DOWNLOAD_BLOCKED", "ddddddddddd") is True
    assert len(sentry) == 2


def test_burst_threshold_and_window_from_env(monkeypatch):
    monkeypatch.setenv("DOWNLOAD_BURST_THRESHOLD", "5")
    monkeypatch.setenv("DOWNLOAD_BURST_WINDOW_SECONDS", "600")
    d = fetch_alerts.DownloadBurstDetector()
    assert (d.threshold, d.window_s) == (5, 600.0)
    monkeypatch.setenv("DOWNLOAD_BURST_THRESHOLD", "nope")
    monkeypatch.setenv("DOWNLOAD_BURST_WINDOW_SECONDS", "1")
    d = fetch_alerts.DownloadBurstDetector()
    assert (d.threshold, d.window_s) == (3, 1800.0)


def test_download_audio_feeds_the_burst_detector_across_videos(chain, sentry):
    chain.cobalt_released = False
    for vid in ("aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"):
        chain.ytdlp_results = [DownloadBlockedError("x")] * 3
        with pytest.raises(DownloadBlockedError):
            downloader.download_audio(f"https://www.youtube.com/watch?v={vid}", JOB)
    assert [s["fp"] for s in sentry] == [["download-failure-burst", "DOWNLOAD_BLOCKED"]]


def test_kill_switch_refusals_never_feed_the_burst_detector(chain, sentry):
    chain.paused = "fetch_global"
    for vid in ("aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"):
        with pytest.raises(FetchPausedError):
            downloader.download_audio(f"https://www.youtube.com/watch?v={vid}", JOB)
    assert sentry == []


def test_a_success_in_download_audio_resets_the_streak(chain, sentry):
    chain.cobalt_released = False
    seq = [
        ("aaaaaaaaaaa", DownloadPrivateError("x")),
        ("bbbbbbbbbbb", DownloadPrivateError("x")),
        ("ccccccccccc", "/tmp/ok.wav"),
        ("ddddddddddd", DownloadPrivateError("x")),
    ]
    for vid, outcome in seq:
        chain.ytdlp_results = [outcome]
        with contextlib.suppress(DownloadPrivateError):
            downloader.download_audio(f"https://www.youtube.com/watch?v={vid}", JOB)
    assert sentry == []


# ------------------------------------------------------------------- kill-switch scope WARN


def _scope_warns(monkeypatch, capsys, rows):
    monkeypatch.setattr(fetch_gates, "_read_switches", lambda: rows)
    fetch_gates.reset_cache()
    capsys.readouterr()
    fetch_gates.fetch_paused()
    fetch_gates.reset_cache()
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line]
    return [e for e in events if e["event"] == "kill_switch_unknown_scope"]


def test_spend_global_is_not_an_unknown_scope(monkeypatch, capsys):
    rows = [("fetch_global", False), ("fetch_youtube", False), ("spend_global", False)]
    assert _scope_warns(monkeypatch, capsys, rows) == []


def test_scopes_nothing_reads_are_still_named(monkeypatch, capsys):
    rows = [("spend_global", False), ("fetch_spotify", True), ("Fetch_Global", True)]
    warns = _scope_warns(monkeypatch, capsys, rows)
    assert len(warns) == 1
    detail = json.loads(warns[0]["detail"])
    assert detail["scopes"] == ["Fetch_Global", "fetch_spotify"]


def test_spend_global_is_still_never_acted_on_by_the_fetch_gate(monkeypatch, capsys):
    rows = [("spend_global", True)]
    monkeypatch.setattr(fetch_gates, "_read_switches", lambda: rows)
    fetch_gates.reset_cache()
    try:
        assert fetch_gates.fetch_paused() is None
        assert fetch_gates.cobalt_allowed() is False
    finally:
        fetch_gates.reset_cache()
