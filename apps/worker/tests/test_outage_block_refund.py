"""Q-B (Jon 2026-11-21): an outage-time DOWNLOAD_BLOCKED is ours and the song comes back.

A link job's FINAL DownloadBlockedError, raised while the fetch canary's last proxy/youtube
result is a FAILURE no older than ``fetch_canary.outage_window_s()`` (2 proxy-check periods,
30 min by default), is reclassified at the source (downloader._attribute_block_to_outage) to
FETCH_PROXY_FAILED, an OUR_FAULT_CODES code, so migration 042's restore_job_allowance gives the
song back. A canary that is ok, stale, unknown or off changes nothing (fail closed), and no
other code (DOWNLOAD_TIMEOUT, the kill switch, ...) is touched.

Offline, no database. That a stored FETCH_PROXY_FAILED really restores the allowance is
pinned against Postgres in CI by test_allowance_restore.py
(test_our_fault_failure_gives_the_monthly_song_back, parametrised over OUR_FAULT_CODES).

Mutants these kill: inverted canary condition (ok -> refund), dropped freshness, refund on a
stale result, TIMEOUT reclassified too, the kill switch reclassified.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from worker import downloader, fetch_alerts, fetch_canary, job_failure, pipeline
from worker.downloader import fetch_gates
from worker.errors import (
    DownloadBlockedError,
    DownloadPrivateError,
    DownloadTimeoutError,
    FetchProxyFailedError,
)

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "00000000-0000-4000-8000-00000000ab01"
NOW = datetime(2026, 11, 23, 12, 0, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _canary(monkeypatch):
    fetch_canary.reset_state()
    fetch_alerts.rearm_proxy_failure_reports()
    monkeypatch.delenv("FETCH_CANARY_INTERVAL_SECONDS", raising=False)
    yield
    fetch_canary.reset_state()


def set_check(check: str, ok, age_s: float | None, *, enabled: bool = True, now=None):
    now = now or datetime.now(UTC)
    stamp = (
        None if age_s is None else (now - timedelta(seconds=age_s)).isoformat(timespec="seconds")
    )
    with fetch_canary._state_lock:
        fetch_canary._state["enabled"] = enabled
        fetch_canary._state[check] = {
            "ok": ok,
            "last_checked": stamp,
            "cause": None if ok in (True, None) else "proxy_auth",
        }


# ------------------------------------------------------------------ the freshness rule


def test_window_is_two_proxy_check_periods(monkeypatch):
    assert fetch_canary.outage_window_s() == 1800.0  # default 900 s interval
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "300")
    assert fetch_canary.outage_window_s() == 600.0
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "10")  # loop never sleeps < 60 s
    assert fetch_canary.outage_window_s() == 120.0
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "0")  # canary off
    assert fetch_canary.outage_window_s() == 0.0


@pytest.mark.parametrize("check", ["proxy", "youtube"])
def test_a_fresh_failure_is_an_outage(check):
    set_check(check, False, 60, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) == check


def test_the_window_edge_is_inclusive_and_one_second_past_is_stale():
    set_check("proxy", False, 1800, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) == "proxy"
    set_check("proxy", False, 1801, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) is None


@pytest.mark.parametrize(
    "ok,age,enabled",
    [
        (True, 60, True),  # canary ok
        (None, 60, True),  # check not applicable (no proxy): unknown
        (None, None, True),  # never ran
        (False, None, True),  # failed but no timestamp: unknown
        (False, 3 * 3600, True),  # stale
        (False, 12 * 3600 - 60, True),  # a 12-hourly youtube failure sitting in state
        (False, -120, True),  # dated in the future: not trusted
        (False, 60, False),  # canary not enabled
    ],
)
@pytest.mark.parametrize("check", ["proxy", "youtube"])
def test_anything_but_a_fresh_failure_is_not_an_outage(check, ok, age, enabled):
    set_check(check, ok, age, enabled=enabled, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) is None


def test_canary_off_never_confirms(monkeypatch):
    set_check("proxy", False, 1, now=NOW)
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "0")
    assert fetch_canary.outage_confirmed(NOW) is None


def test_an_unreadable_timestamp_fails_closed():
    set_check("proxy", False, 60, now=NOW)
    with fetch_canary._state_lock:
        fetch_canary._state["proxy"]["last_checked"] = "not-a-time"
    assert fetch_canary.outage_confirmed(NOW) is None


def test_a_real_failed_proxy_check_counts_and_a_later_success_clears_it():
    fetch_canary._state["enabled"] = True
    fetch_canary.run_proxy_check(lambda: type("R", (), {"ok": False, "cause": "proxy_auth"})())
    assert fetch_canary.outage_confirmed() == "proxy"
    fetch_canary.run_proxy_check(lambda: type("R", (), {"ok": True, "cause": None})())
    assert fetch_canary.outage_confirmed() is None


# ------------------------------------------------------------------ the download chain


class Chain:
    def __init__(self, monkeypatch):
        self.ytdlp_results: list = []
        self.paused: str | None = None
        self.bursts: list[str] = []

        def ytdlp(url):
            item = self.ytdlp_results.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", ytdlp)
        monkeypatch.setattr(fetch_gates, "is_blocklisted", lambda vid: False)
        monkeypatch.setattr(fetch_gates, "fetch_paused", lambda: self.paused)
        monkeypatch.setattr(fetch_gates, "cobalt_allowed", lambda: False)
        monkeypatch.setattr(fetch_gates, "log_attempt", lambda **kw: None)
        monkeypatch.setattr(fetch_gates, "ytdlp_version", lambda: "test")
        monkeypatch.setattr(downloader, "YTDLP_MAX_ATTEMPTS", 2)
        monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0)
        monkeypatch.setattr(downloader.time, "sleep", lambda s: None)
        monkeypatch.setattr(
            downloader.burst_detector,
            "record_failure",
            lambda code, vid: self.bursts.append(code) or False,
        )


@pytest.fixture
def chain(monkeypatch):
    return Chain(monkeypatch)


def test_block_during_fresh_proxy_outage_is_fetch_proxy_failed(chain):
    set_check("proxy", False, 30)
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(FetchProxyFailedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "FETCH_PROXY_FAILED"
    assert ei.value.cause == "canary_proxy"
    assert isinstance(ei.value.__cause__, DownloadBlockedError)
    assert chain.bursts == ["FETCH_PROXY_FAILED"]


def test_block_during_fresh_youtube_check_failure_is_fetch_proxy_failed(chain):
    set_check("youtube", False, 30)
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(FetchProxyFailedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.cause == "canary_youtube"


def test_block_with_canary_ok_stays_download_blocked(chain):
    set_check("proxy", True, 30)
    set_check("youtube", True, 30)
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(DownloadBlockedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "DOWNLOAD_BLOCKED"
    assert not isinstance(ei.value, FetchProxyFailedError)


@pytest.mark.parametrize("ok,age", [(False, 3 * 3600), (None, None), (False, None)])
def test_block_with_stale_or_unknown_canary_stays_download_blocked(chain, ok, age):
    set_check("proxy", ok, age)
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(DownloadBlockedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "DOWNLOAD_BLOCKED"


def test_block_with_canary_never_started_stays_download_blocked(chain):
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(DownloadBlockedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "DOWNLOAD_BLOCKED"


@pytest.mark.parametrize(
    "exc,code",
    [
        (DownloadTimeoutError("slow"), "DOWNLOAD_TIMEOUT"),
        (DownloadPrivateError("private"), "DOWNLOAD_PRIVATE"),
    ],
)
def test_other_failures_keep_their_code_even_during_an_outage(chain, exc, code):
    set_check("proxy", False, 30)
    chain.ytdlp_results = [exc] * 2
    with pytest.raises(type(exc)) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == code
    assert not isinstance(ei.value, FetchProxyFailedError)


def test_the_kill_switch_is_not_an_outage(chain):
    set_check("proxy", False, 30)
    chain.paused = "fetch_youtube"
    with pytest.raises(DownloadBlockedError) as ei:
        downloader.download_audio(URL, JOB)
    assert not isinstance(ei.value, FetchProxyFailedError)


def test_a_block_that_clears_on_retry_still_succeeds(chain):
    set_check("proxy", False, 30)
    chain.ytdlp_results = [DownloadBlockedError("x"), "/tmp/a.wav"]
    assert downloader.download_audio(URL, JOB) == ("/tmp/a.wav", "ytdlp")


# ------------------------------------------------------------------ the refund path


class _Cur:
    def __init__(self, row):
        self.row = row

    async def fetchone(self):
        return self.row


class _Conn:
    def __init__(self, box):
        self.box = box

    async def execute(self, sql, params=None):
        if "UPDATE jobs SET status='failed'" in sql:
            self.box["stored_code"] = params[0]
            self.box["stored_message"] = params[1]
        return _Cur(("id",))

    async def commit(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _drive_link_job(monkeypatch, chain):
    """Walk the real _run_pipeline for a LINK job down to fail_job, DB edges faked. The
    restore is 'given back' exactly when the stored code is in OUR_FAULT_CODES -- the same
    rule restore_job_allowance applies in Postgres (pinned in CI, test_allowance_restore)."""
    box: dict = {"restores": []}
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.delenv("STUB_MODE", raising=False)
    row = (URL, ["drums", "bass", "vocals", "other"], 4, "youtube", None, None)
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_max_upload_duration_sec", lambda: None)
    monkeypatch.setattr(pipeline, "report_proxy_failure", lambda cause: True)

    async def connect(url):
        return _Conn(box)

    async def refund(conn, job_id):
        return False

    async def restore(conn, job_id):
        code = box.get("stored_code")
        back = code in job_failure.OUR_FAULT_CODES
        box["restores"].append((job_id, code, back))
        return "allowance" if back else None

    monkeypatch.setattr(job_failure.psycopg.AsyncConnection, "connect", connect)
    monkeypatch.setattr(job_failure, "refund_if_owed", refund)
    monkeypatch.setattr(job_failure, "restore_allowance_if_owed", restore)
    return box


def test_outage_block_stores_our_code_and_the_restore_gives_the_song_back(monkeypatch, chain):
    box = _drive_link_job(monkeypatch, chain)
    set_check("proxy", False, 30)
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(FetchProxyFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert box["stored_code"] == "FETCH_PROXY_FAILED"
    assert box["stored_message"] == FetchProxyFailedError("x").user_message
    assert box["restores"] and all(r == (JOB, "FETCH_PROXY_FAILED", True) for r in box["restores"])


@pytest.mark.parametrize("ok,age", [(True, 30), (False, 3 * 3600), (None, None)])
def test_non_outage_block_stores_download_blocked_and_nothing_comes_back(
    monkeypatch, chain, ok, age
):
    box = _drive_link_job(monkeypatch, chain)
    set_check("proxy", ok, age)
    chain.ytdlp_results = [DownloadBlockedError("bot wall")] * 2
    with pytest.raises(DownloadBlockedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert box["stored_code"] == "DOWNLOAD_BLOCKED"
    assert all(r[2] is False for r in box["restores"])


def test_outage_timeout_still_stores_download_timeout(monkeypatch, chain):
    box = _drive_link_job(monkeypatch, chain)
    set_check("proxy", False, 30)
    chain.ytdlp_results = [DownloadTimeoutError("slow")] * 2
    with pytest.raises(DownloadTimeoutError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert box["stored_code"] == "DOWNLOAD_TIMEOUT"
    assert all(r[2] is False for r in box["restores"])


def test_policy_tuples_are_unchanged():
    assert "DOWNLOAD_BLOCKED" not in job_failure.OUR_FAULT_CODES
    assert "DOWNLOAD_TIMEOUT" not in job_failure.OUR_FAULT_CODES
    assert "FETCH_PROXY_FAILED" in job_failure.OUR_FAULT_CODES


def test_canary_causes_have_their_own_alert_message():
    for cause in ("canary_proxy", "canary_youtube"):
        msg = fetch_alerts._PROXY_FAILURE_MESSAGES[cause]
        assert "PROXY_URL credentials" not in msg
        assert len(cause) <= 32
