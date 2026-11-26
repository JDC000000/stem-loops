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

Round 2 (review R1): a check counts only with an outage cause (not ``other``, F-2), with its
failure streak at the alerting threshold (QA-65 hysteresis, F-1), inside a window capped at
30 min (F-3); a reclassified job sends no per-job Sentry event (F-4); the proxy check wins
over the youtube check when both qualify (R5).

Mutants these kill: inverted canary condition (ok -> refund), dropped freshness, refund on a
stale result, TIMEOUT reclassified too, no hysteresis, cause ``other`` counted, uncapped
window, per-job Sentry ERROR, youtube-before-proxy. Not killable: making the kill switch
reclassifiable (``isinstance`` instead of ``type(...) is``) is an EQUIVALENT mutant today --
FetchPausedError is raised before the reclassification point. The kill-switch test below
pins the behaviour, not that mutant.
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
    FetchPausedError,
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


DEFAULT_CAUSE = {"proxy": "proxy_auth", "youtube": "youtube_bot_check"}


def set_check(
    check: str,
    ok,
    age_s: float | None,
    *,
    enabled: bool = True,
    now=None,
    cause: str | None = None,
    failures: int | None = None,
):
    """Put one check's last result in the canary state. A failure defaults to an outage
    cause and a streak AT the alerting threshold (2 proxy / 1 youtube), i.e. a real failing
    state; pass ``cause`` / ``failures`` to probe the gates."""
    now = now or datetime.now(UTC)
    if failures is None:
        failures = fetch_canary._alert_after(check) if ok is False else 0
    stamp = (
        None if age_s is None else (now - timedelta(seconds=age_s)).isoformat(timespec="seconds")
    )
    with fetch_canary._state_lock:
        fetch_canary._state["enabled"] = enabled
        fetch_canary._state[check] = {
            "ok": ok,
            "last_checked": stamp,
            "cause": None if ok in (True, None) else (cause or DEFAULT_CAUSE[check]),
        }
        fetch_canary._streak[check] = {"failures": failures, "alerted_cause": None}


# ------------------------------------------------------------------ the freshness rule


def test_window_is_two_proxy_check_periods(monkeypatch):
    assert fetch_canary.outage_window_s() == 1800.0  # default 900 s interval
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "300")
    assert fetch_canary.outage_window_s() == 600.0
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "10")  # loop never sleeps < 60 s
    assert fetch_canary.outage_window_s() == 120.0
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "0")  # canary off
    assert fetch_canary.outage_window_s() == 0.0


@pytest.mark.parametrize("interval", ["901", "3600", "86400", "1e9"])
def test_window_is_capped_at_30_minutes_whatever_the_interval(monkeypatch, interval):
    """F-3: a huge FETCH_CANARY_INTERVAL_SECONDS must not stretch "now" to hours."""
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", interval)
    assert fetch_canary.outage_window_s() == 1800.0
    set_check("proxy", False, 1801, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) is None
    set_check("proxy", False, 1800, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) == "proxy"


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


def test_proxy_wins_when_both_checks_qualify():
    """R5: the documented order. The cause (and so the log / stored reason) is the proxy's."""
    set_check("proxy", False, 60, now=NOW)
    set_check("youtube", False, 30, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) == "proxy"


def test_youtube_qualifies_when_proxy_is_ok():
    set_check("proxy", True, 60, now=NOW)
    set_check("youtube", False, 30, now=NOW)
    assert fetch_canary.outage_confirmed(NOW) == "youtube"


@pytest.mark.parametrize("check", ["proxy", "youtube"])
def test_cause_other_never_opens_the_window(check):
    """F-2: a probe that raised or timed out (cause ``other``) is not evidence of an outage."""
    set_check(check, False, 60, now=NOW, cause="other")
    assert fetch_canary.outage_confirmed(NOW) is None


@pytest.mark.parametrize(
    "check,cause",
    [("proxy", "proxy_auth"), ("proxy", "proxy_connect"), ("youtube", "youtube_bot_check")],
)
def test_outage_causes_open_the_window(check, cause):
    set_check(check, False, 60, now=NOW, cause=cause)
    assert fetch_canary.outage_confirmed(NOW) == check


def test_outage_causes_are_the_ytdlp_cause_classes():
    from worker.downloader import ytdlp_client

    assert {
        ytdlp_client.PROXY_AUTH,
        ytdlp_client.PROXY_CONNECT,
        ytdlp_client.YOUTUBE_BOT_CHECK,
    } == fetch_canary.OUTAGE_CAUSES
    assert ytdlp_client.OTHER not in fetch_canary.OUTAGE_CAUSES


def test_a_single_proxy_blip_below_the_alert_threshold_does_not_count():
    """F-1: one failed CONNECT (streak 1 < alert_after 2) is a blip, not an outage."""
    set_check("proxy", False, 60, now=NOW, failures=1)
    assert fetch_canary.outage_confirmed(NOW) is None
    set_check("proxy", False, 60, now=NOW, failures=2)
    assert fetch_canary.outage_confirmed(NOW) == "proxy"


def test_the_threshold_follows_the_alerting_setting(monkeypatch):
    monkeypatch.setenv("FETCH_CANARY_PROXY_ALERT_AFTER", "3")
    set_check("proxy", False, 60, now=NOW, failures=2)
    assert fetch_canary.outage_confirmed(NOW) is None
    set_check("proxy", False, 60, now=NOW, failures=3)
    assert fetch_canary.outage_confirmed(NOW) == "proxy"


def test_canary_off_never_confirms(monkeypatch):
    set_check("proxy", False, 1, now=NOW)
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "0")
    assert fetch_canary.outage_confirmed(NOW) is None


def test_an_unreadable_timestamp_fails_closed():
    set_check("proxy", False, 60, now=NOW)
    with fetch_canary._state_lock:
        fetch_canary._state["proxy"]["last_checked"] = "not-a-time"
    assert fetch_canary.outage_confirmed(NOW) is None


def _result(ok, cause=None):
    return lambda: type("R", (), {"ok": ok, "cause": cause})()


def test_real_proxy_checks_blip_then_outage_then_recovery(sentry_off):
    fetch_canary._state["enabled"] = True
    fetch_canary.run_proxy_check(_result(False, "proxy_auth"))
    assert fetch_canary.outage_confirmed() is None, "one failure is a blip (F-1)"
    fetch_canary.run_proxy_check(_result(False, "proxy_auth"))
    assert fetch_canary.outage_confirmed() == "proxy", "two in a row is the alerting state"
    fetch_canary.run_proxy_check(_result(True))
    assert fetch_canary.outage_confirmed() is None


def test_real_full_check_that_raised_does_not_count(sentry_off):
    """F-2: the start-up full probe timing out / raising gives cause ``other``."""
    fetch_canary._state["enabled"] = True
    fetch_canary.run_proxy_check(_result(True))

    def boom():
        raise TimeoutError("45 s")

    fetch_canary.run_full_check(boom)
    assert fetch_canary.canary_state()["youtube"]["cause"] == "other"
    assert fetch_canary.outage_confirmed() is None
    fetch_canary.run_full_check(_result(False, "youtube_bot_check"))
    assert fetch_canary.outage_confirmed() == "youtube"


@pytest.fixture
def sentry_off(monkeypatch):
    sent: list = []
    monkeypatch.setattr(fetch_canary, "_send", lambda *a: sent.append(a))
    return sent


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
    # QK-4: the kill switch is ours (INTERNAL_ERROR, song returned), but it is still never
    # attributed to a proxy outage: it keeps its own type and code.
    with pytest.raises(FetchPausedError) as ei:
        downloader.download_audio(URL, JOB)
    assert not isinstance(ei.value, FetchProxyFailedError)
    assert ei.value.error_code == "INTERNAL_ERROR"


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
    box["reported"] = []
    monkeypatch.setattr(
        pipeline, "report_proxy_failure", lambda cause: box["reported"].append(cause) or True
    )
    monkeypatch.setattr(
        pipeline.sentry_sdk,
        "capture_exception",
        lambda *a, **k: box["reported"].append(("capture", a, k)),
    )

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
    assert box["reported"] == [], "F-4: no per-job Sentry event for a canary-attributed block"


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


def test_a_genuine_proxy_failure_is_still_reported_once(monkeypatch):
    """F-4 is narrow: a real 407 / connect failure (not canary-attributed) still reports."""
    sent: list = []
    monkeypatch.setattr(pipeline, "report_proxy_failure", lambda cause: sent.append(cause))
    pipeline._report_our_fault(FetchProxyFailedError("proxy_auth"))
    assert sent == ["proxy_auth"]


@pytest.mark.parametrize("cause", ["canary_proxy", "canary_youtube"])
def test_a_canary_attributed_failure_sends_nothing_to_sentry(monkeypatch, capsys, cause):
    sent: list = []
    monkeypatch.setattr(pipeline, "report_proxy_failure", lambda c: sent.append(c))
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_exception", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_message", lambda *a, **k: sent.append(a))
    pipeline._report_our_fault(FetchProxyFailedError(cause))
    assert sent == []
    assert "fetch_proxy_failed_canary_attributed" in capsys.readouterr().err


def test_attributed_causes_fit_the_sentry_tag_limit():
    assert set(fetch_canary.ATTRIBUTED_CAUSES) == {"proxy", "youtube"}
    assert all(len(c) <= 32 for c in fetch_canary.ATTRIBUTED_CAUSES.values())
