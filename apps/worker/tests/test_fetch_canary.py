"""QA-61 fetch canary: a background probe of the proxy + YouTube path, on /health. Offline.

The 407 outage ran for hours because the only signal was a user's failed job. The canary
resolves one fixed public video's metadata through the production proxy path every
FETCH_CANARY_INTERVAL_SECONDS. These tests pin: the probe command (metadata only, through
the proxy, options ended before the URL, bounded), the cause classes, transition-only
alerting (one Sentry ERROR per outage/cause, one INFO on recovery), the per-job report
re-arm on recovery, the /health field (200 always, no secrets), the enable/disable rules,
the env parsing, and the consumer starting it once without blocking.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import threading
import types

import pytest
from fastapi.testclient import TestClient

from worker import consumer, fetch_alerts, fetch_canary
from worker.downloader import ytdlp_client
from worker.health import app

PROXY = "http://someuser:s3cr3tpass@geo.iproyal.com:12321"


@pytest.fixture
def sentry(monkeypatch):
    sent: list[dict] = []
    scopes: list = []

    class Scope:
        def __init__(self):
            self.tags, self.fingerprint = {}, None

        def set_tag(self, k, v):
            self.tags[k] = v

        def set_extra(self, k, v):
            pass

        def __enter__(self):
            scopes.append(self)
            return self

        def __exit__(self, *a):
            return False

    def capture_message(msg, level=None):
        sent.append({"msg": msg, "level": level, "fp": scopes[-1].fingerprint, **scopes[-1].tags})

    fake = types.SimpleNamespace(new_scope=Scope, capture_message=capture_message)
    monkeypatch.setattr(fetch_canary, "sentry_sdk", fake)
    monkeypatch.setattr(fetch_alerts, "sentry_sdk", fake)
    return sent


def probe_of(*results):
    seq = list(results)

    def probe(video_id):
        item = seq.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return probe


OK = ytdlp_client.CanaryResult(ok=True, cause=None)


def bad(cause):
    return ytdlp_client.CanaryResult(ok=False, cause=cause)


# ------------------------------------------------------------------- transitions


def test_failure_alerts_once_per_outage_and_recovery_once(sentry, capsys):
    probe = probe_of(bad("proxy_auth"), bad("proxy_auth"), bad("proxy_auth"), OK, OK)
    for _ in range(5):
        fetch_canary.run_once(probe)
    assert [(s["level"], s["fp"]) for s in sentry] == [
        ("error", ["fetch-canary", "proxy_auth"]),
        ("info", ["fetch-canary", "recovered"]),
    ]
    assert sentry[0]["cause"] == "proxy_auth"
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line]
    names = [(e["level"], e["event"]) for e in events]
    assert names.count(("ERROR", "fetch_canary_failed")) == 3  # logged every check
    assert names.count(("INFO", "fetch_canary_recovered")) == 1


def test_a_change_of_cause_is_a_new_alert(sentry):
    probe = probe_of(bad("proxy_auth"), bad("youtube_bot_check"), bad("youtube_bot_check"))
    for _ in range(3):
        fetch_canary.run_once(probe)
    assert [s["fp"][1] for s in sentry] == ["proxy_auth", "youtube_bot_check"]


def test_first_check_ok_is_silent(sentry):
    state = fetch_canary.run_once(probe_of(OK))
    assert sentry == []
    assert state["ok"] is True and state["cause"] is None and state["last_checked"]


def test_a_probe_that_raises_is_other_and_does_not_escape(sentry):
    state = fetch_canary.run_once(probe_of(RuntimeError(PROXY)))
    assert state["ok"] is False and state["cause"] == "other"
    assert PROXY not in json.dumps(sentry)


def test_recovery_rearms_the_per_job_proxy_report(sentry):
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True
    assert fetch_alerts.report_proxy_failure("proxy_auth") is False
    fetch_canary.run_once(probe_of(OK))
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True


# ------------------------------------------------------------------- the probe itself


@pytest.fixture
def fake_run(monkeypatch):
    box = {"cmds": [], "kwargs": [], "result": None}

    def run(cmd, *a, **k):
        box["cmds"].append(cmd)
        box["kwargs"].append(k)
        r = box["result"]
        if isinstance(r, BaseException):
            raise r
        return r

    monkeypatch.setattr(ytdlp_client.subprocess, "run", run)
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    return box


def test_probe_is_metadata_only_through_the_proxy_and_bounded(fake_run):
    fake_run["result"] = types.SimpleNamespace(returncode=0, stdout="jNQXAC9IVRw\n", stderr="")
    assert ytdlp_client.canary_probe("https://www.youtube.com/watch?v=jNQXAC9IVRw", 7) == OK
    cmd = fake_run["cmds"][0]
    assert "--simulate" in cmd and "-x" not in cmd
    assert cmd[cmd.index("--proxy") + 1].startswith("http://someuser:s3cr3tpass")
    assert cmd[-2:] == ["--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]
    assert fake_run["kwargs"][0]["timeout"] == 7


@pytest.mark.parametrize(
    "stderr,cause",
    [
        ("Tunnel connection failed: 407 Proxy Authentication Required", "proxy_auth"),
        ("('Unable to connect to proxy', ConnectionRefusedError())", "proxy_connect"),
        ("Sign in to confirm you're not a bot", "youtube_bot_check"),
        ("ERROR: something new", "other"),
    ],
)
def test_probe_causes(fake_run, stderr, cause):
    fake_run["result"] = types.SimpleNamespace(returncode=1, stdout="", stderr=stderr)
    assert ytdlp_client.canary_probe("u", 5) == bad(cause)


def test_probe_timeout_is_other_not_a_crash(fake_run):
    fake_run["result"] = subprocess.TimeoutExpired("yt-dlp", 5)
    assert ytdlp_client.canary_probe("u", 5) == bad("other")


def test_probe_with_empty_output_is_not_ok(fake_run):
    fake_run["result"] = types.SimpleNamespace(returncode=0, stdout="", stderr="")
    assert ytdlp_client.canary_probe("u", 5).ok is False


def test_default_probe_uses_the_canary_video(monkeypatch):
    seen = {}

    def probe(url, timeout):
        seen["url"], seen["timeout"] = url, timeout
        return OK

    monkeypatch.setattr(ytdlp_client, "canary_probe", probe)
    monkeypatch.setenv("CANARY_YOUTUBE_ID", "aaaaaaaaaaa")
    monkeypatch.setenv("FETCH_CANARY_TIMEOUT_SECONDS", "12")
    fetch_canary.run_once()
    assert seen == {"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa", "timeout": 12.0}


# ------------------------------------------------------------------- env


def test_video_id_default_and_validation(monkeypatch):
    monkeypatch.delenv("CANARY_YOUTUBE_ID", raising=False)
    assert fetch_canary.canary_video_id() == "jNQXAC9IVRw"
    monkeypatch.setenv("CANARY_YOUTUBE_ID", "--exec=rm -rf")
    assert fetch_canary.canary_video_id() == "jNQXAC9IVRw"
    monkeypatch.setenv("CANARY_YOUTUBE_ID", "dQw4w9WgXcQ")
    assert fetch_canary.canary_video_id() == "dQw4w9WgXcQ"


def test_interval_and_timeout_parsing(monkeypatch):
    monkeypatch.delenv("FETCH_CANARY_INTERVAL_SECONDS", raising=False)
    monkeypatch.delenv("FETCH_CANARY_TIMEOUT_SECONDS", raising=False)
    assert fetch_canary.interval_s() == 900
    assert fetch_canary.timeout_s() == 45
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "junk")
    monkeypatch.setenv("FETCH_CANARY_TIMEOUT_SECONDS", "0")
    assert fetch_canary.interval_s() == 900
    assert fetch_canary.timeout_s() == 45


def test_enabled_only_with_youtube_input_and_a_positive_interval(monkeypatch):
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "900")
    monkeypatch.delenv("ALLOW_YOUTUBE_INPUT", raising=False)
    assert fetch_canary.enabled() is False
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    assert fetch_canary.enabled() is True
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "0")
    assert fetch_canary.enabled() is False


# ------------------------------------------------------------------- thread + consumer


def test_start_runs_one_daemon_thread_once(monkeypatch):
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "900")
    gate = threading.Event()
    monkeypatch.setattr(fetch_canary, "_loop", gate.wait)
    monkeypatch.setattr(fetch_canary, "_thread", None)
    try:
        t1 = fetch_canary.start_fetch_canary()
        t2 = fetch_canary.start_fetch_canary()
        assert t1 is t2 and t1.daemon and t1.is_alive()
        assert fetch_canary.canary_state()["enabled"] is True
    finally:
        gate.set()


def test_start_is_a_no_op_when_disabled(monkeypatch):
    monkeypatch.delenv("ALLOW_YOUTUBE_INPUT", raising=False)
    assert fetch_canary.start_fetch_canary() is None
    assert fetch_canary.canary_state()["enabled"] is False


def test_loop_survives_a_raising_check_and_sleeps_the_interval(monkeypatch):
    calls = {"n": 0}

    class Stop(BaseException):
        pass

    def boom():
        calls["n"] += 1
        raise RuntimeError("x")

    def sleep(s):
        assert s == 900
        if calls["n"] >= 2:
            raise Stop

    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "900")
    monkeypatch.setattr(fetch_canary, "run_once", boom)
    monkeypatch.setattr(fetch_canary.time, "sleep", sleep)
    with pytest.raises(Stop):
        fetch_canary._loop()
    assert calls["n"] == 2


def test_consumer_starts_the_canary_once_and_survives_a_failing_start(monkeypatch):
    starts: list[int] = []

    class Stop(BaseException):
        pass

    def start():
        starts.append(1)
        raise RuntimeError("cannot start thread")

    async def nothing():
        return False

    async def zero():
        return 0

    async def no_sweep():
        return {}

    ticks = {"n": 0}

    async def fake_sleep(s):
        ticks["n"] += 1
        if ticks["n"] > 5:
            raise Stop

    monkeypatch.setattr(consumer, "start_fetch_canary", start)
    monkeypatch.setattr(consumer, "start_r2_lifecycle_check", lambda: None)
    monkeypatch.setattr(consumer, "start_artifact_audit", lambda: None)
    monkeypatch.setattr(consumer.tmpdirs, "sweep_stale", lambda: 0)
    monkeypatch.setattr(consumer, "reap_stale_jobs", zero)
    monkeypatch.setattr(consumer, "reap_stale_requests", zero)
    monkeypatch.setattr(consumer, "sweep_expired", no_sweep)
    monkeypatch.setattr(consumer, "claim_and_run", nothing)
    monkeypatch.setattr(consumer, "claim_and_cut", nothing)
    monkeypatch.setattr(consumer.asyncio, "sleep", fake_sleep)
    with pytest.raises(Stop):
        asyncio.run(consumer.poll_loop())
    assert starts == [1]  # once, at startup; the loop kept polling after it raised


# ------------------------------------------------------------------- /health


def test_health_reports_the_canary_and_stays_200_when_it_fails(sentry, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    client = TestClient(app)
    before = client.get("/health").json()["fetch_canary"]
    assert before == {"enabled": False, "ok": None, "last_checked": None, "cause": None}

    fetch_canary.run_once(probe_of(bad("proxy_auth")))
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    fc = body["fetch_canary"]
    assert fc["ok"] is False and fc["cause"] == "proxy_auth" and fc["enabled"] is True
    assert fc["last_checked"].endswith("+00:00")
    for secret in ("s3cr3tpass", "someuser", "iproyal", "jNQXAC9IVRw"):
        assert secret not in r.text
