"""QA-61 fetch canary: a background check of the proxy + YouTube path, on /health. Offline.

The 407 outage ran for hours because the only signal was a user's failed job. Two checks
(review B-2: the proxy plan is metered, so the expensive one is rare):

  * proxy: a CONNECT tunnel to www.youtube.com:443 through the sticky proxy URL, status line
    only (~1 KB), every FETCH_CANARY_INTERVAL_SECONDS (900);
  * youtube: a yt-dlp metadata resolve of CANARY_YOUTUBE_ID, every
    FETCH_CANARY_FULL_INTERVAL_SECONDS (43200) and once at start-up.

These tests pin the tunnel probe against a real local socket "proxy" (request shape, size,
status mapping, connect failures), the full probe's command and its process-group kill on
timeout (a real grandchild process), transition-only alerting per check, the re-arm, the
loop cadence (including the 60 s sleep floor), /health (200 always, both checks, no
secrets), the env rules and the consumer start.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import socket
import sys
import threading
import time
import types

import pytest
from fastapi.testclient import TestClient

from worker import consumer, fetch_alerts, fetch_canary
from worker.downloader import ytdlp_client
from worker.health import app

PROXY = "http://someuser:s3cr3tpass@geo.iproyal.com:12321"
OK = ytdlp_client.CanaryResult(ok=True, cause=None)


def bad(cause):
    return ytdlp_client.CanaryResult(ok=False, cause=cause)


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


def seq(*results):
    items = list(results)

    def probe():
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return probe


# ------------------------------------------------------------------- the tunnel probe


class FakeProxy:
    """A one-shot local TCP 'proxy' that records the request and answers `reply`."""

    def __init__(self, reply: bytes | None, delay: float = 0.0):
        self.reply, self.delay = reply, delay
        self.request = b""
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.t = threading.Thread(target=self._serve, daemon=True)
        self.t.start()

    def _serve(self):
        conn, _ = self.srv.accept()
        with conn:
            conn.settimeout(3)
            while b"\r\n\r\n" not in self.request:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                self.request += chunk
            time.sleep(self.delay)
            if self.reply:
                conn.sendall(self.reply)
        self.srv.close()

    def url(self, userinfo="someuser:s3cr3tpass_session-abcd1234_lifetime-2m"):
        return f"http://{userinfo}@127.0.0.1:{self.port}"


def test_tunnel_200_is_ok_and_the_request_is_a_small_authenticated_connect():
    fp = FakeProxy(b"HTTP/1.1 200 Connection established\r\n\r\n")
    assert ytdlp_client.proxy_tunnel_probe(3, fp.url()) == OK
    fp.t.join(3)
    lines = fp.request.decode().split("\r\n")
    assert lines[0] == "CONNECT www.youtube.com:443 HTTP/1.1"
    auth = [ln for ln in lines if ln.startswith("Proxy-Authorization: Basic ")]
    assert base64.b64decode(auth[0].split()[-1]).decode() == (
        "someuser:s3cr3tpass_session-abcd1234_lifetime-2m"
    )
    assert len(fp.request) < 1024  # the whole point of B-2


def test_tunnel_407_is_proxy_auth():
    fp = FakeProxy(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
    assert ytdlp_client.proxy_tunnel_probe(3, fp.url()) == bad("proxy_auth")


@pytest.mark.parametrize(
    "reply",
    [b"HTTP/1.1 502 Bad Gateway\r\n\r\n", b"HTTP/1.1 402 Payment Required\r\n\r\n", None, b"junk"],
)
def test_tunnel_other_status_or_a_closed_connection_is_proxy_connect(reply):
    fp = FakeProxy(reply)
    assert ytdlp_client.proxy_tunnel_probe(3, fp.url()) == bad("proxy_connect")


def test_tunnel_refused_is_proxy_connect():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens there now
    assert ytdlp_client.proxy_tunnel_probe(2, f"http://u:p@127.0.0.1:{port}") == bad(
        "proxy_connect"
    )


def test_tunnel_timeout_is_bounded_and_proxy_connect():
    fp = FakeProxy(b"HTTP/1.1 200 OK\r\n\r\n", delay=2.0)
    t0 = time.monotonic()
    assert ytdlp_client.proxy_tunnel_probe(0.5, fp.url()) == bad("proxy_connect")
    assert time.monotonic() - t0 < 1.5


def test_tunnel_credentials_are_percent_decoded_like_yt_dlp_does():
    """Review R-5 (mutant R7): PROXY_URL percent-encodes reserved characters in the password.
    Sending them still encoded would be a wrong password: a false proxy_auth every 15 min."""
    fp = FakeProxy(b"HTTP/1.1 200 Connection established\r\n\r\n")
    assert ytdlp_client.proxy_tunnel_probe(3, fp.url("some%40user:p%40ss%3Aw%2Fd")) == OK
    fp.t.join(3)
    auth = [ln for ln in fp.request.decode().split("\r\n") if ln.startswith("Proxy-Authorization")]
    assert base64.b64decode(auth[0].split()[-1]).decode() == "some@user:p@ss:w/d"


class HoldingProxy:
    """A local 'proxy' that sends ``chunks`` (one every ``every`` s) and then keeps the
    connection open until ``hold`` s have passed or the client goes away. Counts nothing
    the client must not wait for."""

    def __init__(self, chunks: list[bytes], every: float = 0.0, hold: float = 5.0):
        self.chunks, self.every, self.hold = chunks, every, hold
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.t = threading.Thread(target=self._serve, daemon=True)
        self.t.start()

    def _serve(self):
        conn, _ = self.srv.accept()
        with conn:
            conn.settimeout(0.5)
            with contextlib.suppress(OSError):
                conn.recv(4096)
            end = time.monotonic() + self.hold
            try:
                for chunk in self.chunks:
                    if time.monotonic() >= end:
                        break
                    conn.sendall(chunk)
                    time.sleep(self.every)
                while time.monotonic() < end:
                    time.sleep(0.05)
            except OSError:
                pass  # the client hung up: what we want
        self.srv.close()

    def url(self):
        return f"http://u:p@127.0.0.1:{self.port}"


def test_tunnel_deadline_is_total_not_per_read_against_a_trickling_proxy():
    """QA-65 (review R-2): a proxy that sends one byte every 0.2 s and never a CRLF never
    trips a per-read timeout of 1 s. The probe must still give up at ~1 s in TOTAL."""
    tp = HoldingProxy([b"H"] * 200, every=0.2, hold=40)
    t0 = time.monotonic()
    assert ytdlp_client.proxy_tunnel_probe(1.0, tp.url()) == bad("proxy_connect")
    assert time.monotonic() - t0 < 2.0


def test_tunnel_reads_at_most_1kb_and_stops_there():
    """Review R-5 (mutant R8): the read is capped at 1 KB. A proxy that sends 1 KB with no
    CRLF and then holds the line gets an immediate answer, not a wait for the deadline."""
    assert ytdlp_client._TUNNEL_READ_MAX == 1024
    tp = HoldingProxy([b"x" * 1024], hold=10)
    t0 = time.monotonic()
    assert ytdlp_client.proxy_tunnel_probe(5.0, tp.url()) == bad("proxy_connect")
    assert time.monotonic() - t0 < 2.0


def test_tunnel_without_a_proxy_or_with_socks_does_not_apply(monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    assert ytdlp_client.proxy_tunnel_probe(1) is None
    assert ytdlp_client.proxy_tunnel_probe(1, "socks5h://u:p@127.0.0.1:1080") is None


def test_tunnel_default_uses_the_sticky_url(monkeypatch):
    seen = {}
    monkeypatch.setattr(ytdlp_client, "_sticky_proxy_url", lambda: seen.setdefault("u", "x://"))
    ytdlp_client.proxy_tunnel_probe(1)
    assert seen == {"u": "x://"}


# ------------------------------------------------------------------- the full probe


def test_full_probe_command_cookies_proxy_and_bound(monkeypatch):
    box = {}

    def run(cmd, timeout):
        box["cmd"], box["timeout"] = cmd, timeout
        return 0, "jNQXAC9IVRw\n", ""

    monkeypatch.setattr(ytdlp_client, "_run_bounded", run)
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    monkeypatch.setattr(ytdlp_client, "_pick_cookie_file", lambda: "/cookies/a.txt")
    assert ytdlp_client.canary_probe("https://www.youtube.com/watch?v=jNQXAC9IVRw", 7) == OK
    cmd = box["cmd"]
    assert "--simulate" in cmd and "-x" not in cmd
    assert cmd[cmd.index("--cookies") + 1] == "/cookies/a.txt"  # same path as a real fetch
    assert cmd[cmd.index("--proxy") + 1].startswith("http://someuser:s3cr3tpass")
    assert cmd[-2:] == ["--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]
    assert box["timeout"] == 7


@pytest.mark.parametrize(
    "res,expected",
    [
        ((1, "", "Tunnel connection failed: 407 Proxy Authentication Required"), "proxy_auth"),
        ((1, "", "('Unable to connect to proxy', ConnectionRefusedError())"), "proxy_connect"),
        ((1, "", "ERROR: [youtube] x: Sign in to confirm you're not a bot"), "youtube_bot_check"),
        ((1, "", "ERROR: something new"), "other"),
        ((0, "", ""), "other"),
        (None, "other"),  # timeout
    ],
)
def test_full_probe_causes(monkeypatch, res, expected):
    monkeypatch.setattr(ytdlp_client, "_run_bounded", lambda cmd, timeout: res)
    assert ytdlp_client.canary_probe("https://www.youtube.com/watch?v=jNQXAC9IVRw", 5) == bad(
        expected
    )


def test_full_probe_never_raises(monkeypatch):
    def boom(cmd, timeout):
        raise OSError("cannot fork")

    monkeypatch.setattr(ytdlp_client, "_run_bounded", boom)
    assert ytdlp_client.canary_probe("u", 5) == bad("other")


def test_timeout_kills_the_whole_process_group(tmp_path):
    """Review m-7: a grandchild (yt-dlp's JS runtime) must not be orphaned on timeout.

    QA-67 (flaky on CI): the child writes the pidfile atomically (tmp + os.replace), so it is
    either absent or complete, never half-written; absent or empty means the child was killed
    before it started the grandchild, so there is nothing that could have been orphaned; and
    the last-resort kill tolerates the grandchild having exited by then."""
    pidfile = tmp_path / "grandchild.pid"
    script = (
        "import os, subprocess, sys, time\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"tmp = {str(pidfile)!r} + '.tmp'\n"
        "with open(tmp, 'w') as f:\n"
        "    f.write(str(p.pid))\n"
        f"os.replace(tmp, {str(pidfile)!r})\n"
        "time.sleep(60)\n"
    )
    t0 = time.monotonic()
    assert ytdlp_client._run_bounded([sys.executable, "-c", script], 3) is None
    assert time.monotonic() - t0 < 12
    raw = pidfile.read_text().strip() if pidfile.exists() else ""
    if not raw:
        pytest.skip("the child was killed before it started a grandchild: nothing to orphan")
    gpid = int(raw)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(gpid, 0)
        except ProcessLookupError:
            break
        # A killed-but-unreaped child of init can linger as a zombie briefly; check its state.
        try:
            with open(f"/proc/{gpid}/stat") as f:
                if f.read().split(")")[-1].split()[0] == "Z":
                    break
        # Reaped between open() and read(): the kernel answers ESRCH (ProcessLookupError).
        # Seen twice on CI for PR #327; either way the grandchild is gone.
        except (FileNotFoundError, ProcessLookupError):
            break
        time.sleep(0.1)
    else:
        with contextlib.suppress(ProcessLookupError):
            os.kill(gpid, 9)
        pytest.fail("grandchild survived the canary timeout")


def test_run_bounded_returns_output():
    assert ytdlp_client._run_bounded([sys.executable, "-c", "print('hi')"], 10) == (0, "hi\n", "")


# ------------------------------------------------------------------- transitions


def test_failure_alerts_once_per_outage_and_recovery_once(sentry, capsys):
    probe = seq(bad("proxy_auth"), bad("proxy_auth"), bad("proxy_auth"), OK, OK)
    for _ in range(5):
        fetch_canary.run_proxy_check(probe)
    assert [(s["level"], s["fp"], s["check"]) for s in sentry] == [
        ("error", ["fetch-canary", "proxy_auth"], "proxy"),
        ("info", ["fetch-canary", "recovered"], "proxy"),
    ]
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line]
    names = [(e["level"], e["event"]) for e in events]
    # QA-65 hysteresis: the first failure is below the threshold (WARN), then ERROR.
    assert names.count(("WARN", "fetch_canary_failed")) == 1
    assert names.count(("ERROR", "fetch_canary_failed")) == 2
    assert names.count(("INFO", "fetch_canary_recovered")) == 1


# ------------------------------------------------------------------- hysteresis (QA-65)


def test_a_single_proxy_blip_alerts_nothing(sentry, capsys):
    """Production, 2026-11-19/20: "fetch canary failed: proxy (proxy_connect)" and "fetch
    canary recovered (proxy)" 6 times each in ~32 h, every one a single failed check between
    two good ones, while every real job succeeded. That pattern must page nothing."""
    probe = seq(OK, bad("proxy_connect"), OK, bad("proxy_connect"), OK, bad("proxy_connect"), OK)
    for _ in range(7):
        state = fetch_canary.run_proxy_check(probe)
    assert sentry == []
    assert state["proxy"]["ok"] is True
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line]
    names = [(e["level"], e["event"]) for e in events]
    assert names.count(("WARN", "fetch_canary_failed")) == 3
    assert ("ERROR", "fetch_canary_failed") not in names
    assert ("INFO", "fetch_canary_recovered") not in names
    assert names.count(("INFO", "fetch_canary_blip_cleared")) == 3


def test_a_blip_still_shows_on_health_at_once(sentry):
    state = fetch_canary.run_proxy_check(seq(bad("proxy_connect")))
    assert sentry == []
    assert state["ok"] is False and state["proxy"]["cause"] == "proxy_connect"


def test_two_consecutive_proxy_failures_alert_once(sentry):
    probe = seq(bad("proxy_connect"), bad("proxy_connect"), bad("proxy_connect"))
    fetch_canary.run_proxy_check(probe)
    assert sentry == []
    fetch_canary.run_proxy_check(probe)
    assert [(s["level"], s["fp"]) for s in sentry] == [("error", ["fetch-canary", "proxy_connect"])]
    fetch_canary.run_proxy_check(probe)
    assert len(sentry) == 1


def test_the_streak_counts_failures_of_any_cause(sentry):
    probe = seq(bad("proxy_auth"), bad("proxy_connect"))
    fetch_canary.run_proxy_check(probe)
    fetch_canary.run_proxy_check(probe)
    assert [s["fp"][1] for s in sentry] == ["proxy_connect"]


def test_a_success_resets_the_streak(sentry):
    probe = seq(bad("proxy_auth"), OK, bad("proxy_auth"), OK)
    for _ in range(4):
        fetch_canary.run_proxy_check(probe)
    assert sentry == []


def test_a_blip_still_rearms_the_per_job_report(sentry):
    assert fetch_alerts.report_proxy_failure("proxy_connect") is True
    fetch_canary.run_proxy_check(seq(bad("proxy_connect")))
    fetch_canary.run_proxy_check(seq(OK))
    assert fetch_alerts.report_proxy_failure("proxy_connect") is True


@pytest.mark.parametrize("value,first_alert_on", [("1", 1), ("3", 3), ("", 2), ("0", 2), ("x", 2)])
def test_proxy_alert_threshold_from_env(sentry, monkeypatch, value, first_alert_on):
    monkeypatch.setenv("FETCH_CANARY_PROXY_ALERT_AFTER", value)
    probe = seq(*[bad("proxy_auth")] * 4)
    for n in range(1, 5):
        fetch_canary.run_proxy_check(probe)
        assert len(sentry) == (1 if n >= first_alert_on else 0), n


def test_the_full_check_alerts_on_its_first_failure_whatever_the_proxy_threshold(
    sentry, monkeypatch
):
    """The full check runs every 12 h: waiting for a second failure would mean a day."""
    monkeypatch.setenv("FETCH_CANARY_PROXY_ALERT_AFTER", "5")
    fetch_canary.run_full_check(seq(bad("youtube_bot_check")))
    assert [(s["level"], s["check"]) for s in sentry] == [("error", "youtube")]


def test_the_recovery_event_is_never_an_error(sentry):
    probe = seq(bad("proxy_auth"), bad("proxy_auth"), OK)
    for _ in range(3):
        fetch_canary.run_proxy_check(probe)
    recovered = [s for s in sentry if s["fp"] == ["fetch-canary", "recovered"]]
    assert len(recovered) == 1
    assert recovered[0]["level"] in ("info", "warning")
    assert fetch_canary.RECOVERY_LEVEL in ("info", "warning")


def test_reset_state_clears_the_streak(sentry):
    fetch_canary.run_proxy_check(seq(bad("proxy_auth")))
    fetch_canary.reset_state()
    fetch_canary.run_proxy_check(seq(bad("proxy_auth")))
    assert sentry == []


def test_a_change_of_cause_is_a_new_alert(sentry):
    probe = seq(bad("youtube_bot_check"), bad("other"), bad("other"))
    for _ in range(3):
        fetch_canary.run_full_check(probe)
    assert [s["fp"][1] for s in sentry] == ["youtube_bot_check", "other"]
    assert {s["check"] for s in sentry} == {"youtube"}


def test_checks_track_their_own_transitions(sentry):
    fetch_canary.run_proxy_check(seq(bad("proxy_auth")))
    fetch_canary.run_full_check(seq(OK))
    state = fetch_canary.run_proxy_check(seq(bad("proxy_auth")))
    assert len(sentry) == 1  # the full check's success did not reset the proxy check
    assert state["ok"] is False and state["cause"] == "proxy_auth"
    assert state["proxy"]["ok"] is False and state["youtube"]["ok"] is True


def test_first_check_ok_is_silent(sentry):
    state = fetch_canary.run_proxy_check(seq(OK))
    assert sentry == []
    assert state["ok"] is True and state["cause"] is None and state["last_checked"]


def test_no_proxy_configured_is_not_a_failure(sentry):
    state = fetch_canary.run_proxy_check(seq(None))
    assert sentry == []
    assert state["proxy"]["ok"] is None and state["ok"] is None


def test_a_probe_that_raises_is_other_and_does_not_escape(sentry):
    state = fetch_canary.run_full_check(seq(RuntimeError(PROXY)))
    assert state["ok"] is False and state["cause"] == "other"
    assert PROXY not in json.dumps(sentry)


def test_recovery_rearms_the_per_job_proxy_report(sentry):
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True
    assert fetch_alerts.report_proxy_failure("proxy_auth") is False
    fetch_canary.run_proxy_check(seq(OK))
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True


def test_default_probes_are_wired(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        ytdlp_client, "proxy_tunnel_probe", lambda t: seen.setdefault("proxy", t) and OK
    )
    monkeypatch.setattr(
        ytdlp_client, "canary_probe", lambda url, t: seen.setdefault("full", (url, t)) and OK
    )
    monkeypatch.setenv("CANARY_YOUTUBE_ID", "aaaaaaaaaaa")
    monkeypatch.setenv("FETCH_CANARY_TIMEOUT_SECONDS", "12")
    monkeypatch.setenv("FETCH_CANARY_PROXY_TIMEOUT_SECONDS", "4")
    fetch_canary.run_proxy_check()
    fetch_canary.run_full_check()
    assert seen == {"proxy": 4.0, "full": ("https://www.youtube.com/watch?v=aaaaaaaaaaa", 12.0)}


# ------------------------------------------------------------------- loop cadence


class Stop(BaseException):
    pass


def _drive_loop(monkeypatch, passes, interval="900", full="43200"):
    clock = {"t": 0.0}
    log: list[tuple] = []
    sleeps: list[float] = []
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", interval)
    monkeypatch.setenv("FETCH_CANARY_FULL_INTERVAL_SECONDS", full)
    monkeypatch.setattr(fetch_canary, "run_proxy_check", lambda: log.append(("proxy", clock["t"])))
    monkeypatch.setattr(fetch_canary, "run_full_check", lambda: log.append(("full", clock["t"])))

    def sleep(s):
        sleeps.append(s)
        clock["t"] += s
        if len(sleeps) >= passes:
            raise Stop

    monkeypatch.setattr(fetch_canary.time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(fetch_canary.time, "sleep", sleep)
    with pytest.raises(Stop):
        fetch_canary._loop()
    return log, sleeps


def test_loop_proxy_every_pass_full_at_start_then_every_12h(monkeypatch):
    passes = 49 * 2  # ~24.5 h of 15-minute passes
    log, sleeps = _drive_loop(monkeypatch, passes)
    assert sum(1 for k, _ in log if k == "proxy") == passes
    assert [t for k, t in log if k == "full"] == [0.0, 43200.0, 86400.0]
    assert set(sleeps) == {900.0}


def test_loop_full_probe_can_be_turned_off(monkeypatch):
    log, _ = _drive_loop(monkeypatch, 5, full="0")
    assert [k for k, _ in log] == ["proxy"] * 5


def test_loop_never_sleeps_less_than_60s(monkeypatch):
    _, sleeps = _drive_loop(monkeypatch, 3, interval="10")
    assert sleeps == [60.0, 60.0, 60.0]


def test_loop_survives_raising_checks(monkeypatch):
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise RuntimeError("x")

    monkeypatch.setattr(fetch_canary, "run_proxy_check", boom)
    monkeypatch.setattr(fetch_canary, "run_full_check", boom)

    def sleep(s):
        if calls["n"] >= 3:
            raise Stop

    monkeypatch.setattr(fetch_canary.time, "sleep", sleep)
    with pytest.raises(Stop):
        fetch_canary._loop()
    assert calls["n"] >= 3


# ------------------------------------------------------------------- env


def test_video_id_default_and_validation(monkeypatch):
    monkeypatch.delenv("CANARY_YOUTUBE_ID", raising=False)
    assert fetch_canary.canary_video_id() == "jNQXAC9IVRw"
    monkeypatch.setenv("CANARY_YOUTUBE_ID", "--exec=rm -rf")
    assert fetch_canary.canary_video_id() == "jNQXAC9IVRw"
    monkeypatch.setenv("CANARY_YOUTUBE_ID", "dQw4w9WgXcQ")
    assert fetch_canary.canary_video_id() == "dQw4w9WgXcQ"


def test_interval_and_timeout_defaults_and_parsing(monkeypatch):
    for name in (
        "FETCH_CANARY_INTERVAL_SECONDS",
        "FETCH_CANARY_FULL_INTERVAL_SECONDS",
        "FETCH_CANARY_TIMEOUT_SECONDS",
        "FETCH_CANARY_PROXY_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    assert fetch_canary.interval_s() == 900
    assert fetch_canary.full_interval_s() == 43200
    assert fetch_canary.timeout_s() == 45
    assert fetch_canary.proxy_timeout_s() == 10
    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "junk")
    monkeypatch.setenv("FETCH_CANARY_FULL_INTERVAL_SECONDS", "-5")
    monkeypatch.setenv("FETCH_CANARY_TIMEOUT_SECONDS", "0")
    monkeypatch.setenv("FETCH_CANARY_PROXY_TIMEOUT_SECONDS", "nan")
    assert fetch_canary.interval_s() == 900
    assert fetch_canary.full_interval_s() == 43200
    assert fetch_canary.timeout_s() == 45
    assert fetch_canary.proxy_timeout_s() == 10


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


def test_consumer_starts_the_canary_once_and_survives_a_failing_start(monkeypatch):
    starts: list[int] = []

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
    assert starts == [1]


# ------------------------------------------------------------------- /health


def test_health_reports_both_checks_and_stays_200_when_they_fail(sentry, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    client = TestClient(app)
    blank = {"ok": None, "last_checked": None, "cause": None}
    assert client.get("/health").json()["fetch_canary"] == {
        "enabled": False,
        **blank,
        "proxy": blank,
        "youtube": blank,
    }

    fetch_canary.run_proxy_check(seq(bad("proxy_auth")))
    fetch_canary.run_full_check(seq(bad("proxy_auth")))
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    fc = body["fetch_canary"]
    assert fc["ok"] is False and fc["cause"] == "proxy_auth" and fc["enabled"] is True
    assert fc["proxy"]["cause"] == "proxy_auth" and fc["youtube"]["ok"] is False
    assert fc["last_checked"].endswith("+00:00")
    for secret in ("s3cr3tpass", "someuser", "iproyal", "jNQXAC9IVRw"):
        assert secret not in r.text
