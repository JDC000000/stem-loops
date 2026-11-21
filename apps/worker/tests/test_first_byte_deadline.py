"""#320: record the first media byte of every link fetch attempt, and cut an attempt that has
had none within FETCH_FIRST_BYTE_DEADLINE_SEC (default 15 s) so the retry rotates the exit.

Offline. No YouTube, no proxy, no database: ``_run_download`` is exercised against small local
child processes that print what yt-dlp's progress template prints; everything above it is
faked at the seams the other fetch tests already use.
"""

from __future__ import annotations

import os
import signal
import sys
import time

import pytest

from worker import downloader, fetch_alerts, job_failure
from worker.downloader import fetch_gates, ytdlp_client
from worker.errors import DownloadTimeoutError, FetchProxyFailedError

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "11111111-1111-1111-1111-111111111111"
PROXY = "http://someuser:s3cr3tpass@geo.iproyal.com:12321"
ENV = "FETCH_FIRST_BYTE_DEADLINE_SEC"


# ------------------------------------------------------------------- env parsing


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 15.0),
        ("", 15.0),
        ("   ", 15.0),
        ("20", 20.0),
        ("12.5", 12.5),
        ("1", 5.0),  # floor: never cut a healthy fetch on a typo
        ("0", 5.0),
        ("-3", 5.0),
        ("600", 60.0),  # ceiling
        ("abc", 15.0),
        ("nan", 15.0),
    ],
)
def test_deadline_env_is_parsed_and_bounded(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv(ENV, raising=False)
    else:
        monkeypatch.setenv(ENV, raw)
    assert ytdlp_client.first_byte_deadline_s() == expected


def test_default_deadline_is_below_the_attempt_timeout():
    """The cut is only useful if it fires before the existing backstop."""
    assert ytdlp_client.FIRST_BYTE_DEADLINE_DEFAULT_S < 30  # TIMEOUT with a proxy
    assert ytdlp_client.FIRST_BYTE_DEADLINE_MIN_S >= 5


# ------------------------------------------------------------------- _run_download


def _child(body: str) -> list[str]:
    return [sys.executable, "-u", "-c", "import sys, time\n" + body]


def test_first_byte_is_captured_and_a_zero_byte_line_does_not_count():
    t = time.monotonic()
    run = ytdlp_client._run_download(
        _child(
            "print('[download] Destination: x')\n"
            "print('__sl_fb__ 0')\n"
            "time.sleep(0.4)\n"
            "print('__sl_fb__ 1024')\n"
            "print('__sl_fb__ 4096')\n"
        ),
        timeout_s=10,
        first_byte_deadline=5,
    )
    assert run.ended == ytdlp_client.EXITED and run.returncode == 0
    assert run.first_byte_at is not None
    assert 0.3 <= run.first_byte_at - t < 5


def test_lines_that_only_contain_the_marker_do_not_count():
    run = ytdlp_client._run_download(
        _child("print('x __sl_fb__ 5')\nprint('__sl_fb__ 5 extra')\nprint('__sl_fb__ -1')\n"),
        timeout_s=10,
        first_byte_deadline=5,
    )
    assert run.ended == ytdlp_client.EXITED
    assert run.first_byte_at is None


def test_no_first_byte_is_cut_at_the_deadline_not_the_timeout():
    t = time.monotonic()
    run = ytdlp_client._run_download(
        _child("print('__sl_fb__ 0')\ntime.sleep(60)\n"), timeout_s=30, first_byte_deadline=1
    )
    took = time.monotonic() - t
    assert run.ended == ytdlp_client.STALLED
    assert run.returncode is None and run.first_byte_at is None
    assert 0.9 <= took < 5, took


def test_slow_but_moving_download_is_not_cut_by_the_deadline():
    run = ytdlp_client._run_download(
        _child(
            "print('__sl_fb__ 10')\n"
            "for i in range(8):\n"
            "    time.sleep(0.25); print('__sl_fb__', 10 + i)\n"
        ),
        timeout_s=10,
        first_byte_deadline=0.5,
    )
    assert run.ended == ytdlp_client.EXITED and run.returncode == 0
    assert run.first_byte_at is not None


def test_moving_download_is_still_bounded_by_the_overall_timeout():
    t = time.monotonic()
    run = ytdlp_client._run_download(
        _child("print('__sl_fb__ 10')\ntime.sleep(60)\n"), timeout_s=1.5, first_byte_deadline=0.5
    )
    assert run.ended == ytdlp_client.TIMED_OUT
    assert run.first_byte_at is not None
    assert time.monotonic() - t < 6


def test_exit_before_the_deadline_without_bytes_is_an_exit_not_a_stall():
    run = ytdlp_client._run_download(
        _child("sys.stderr.write('ERROR: boom'); sys.exit(1)\n"),
        timeout_s=10,
        first_byte_deadline=5,
    )
    assert run.ended == ytdlp_client.EXITED and run.returncode == 1
    assert "boom" in run.stderr


def test_a_stall_kills_the_whole_process_group(tmp_path):
    """yt-dlp may start an ffmpeg / JS-runtime grandchild; a stall must not orphan it."""
    pidfile = tmp_path / "grandchild.pid"
    body = (
        "import subprocess\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(pidfile)!r}, 'w').write(str(p.pid))\n"
        "time.sleep(60)\n"
    )
    run = ytdlp_client._run_download(_child(body), timeout_s=30, first_byte_deadline=1.5)
    assert run.ended == ytdlp_client.STALLED
    pid = int(pidfile.read_text())
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        # A killed child not yet reaped by its (also killed) parent is a zombie: gone enough.
        try:
            with open(f"/proc/{pid}/stat") as f:
                if f.read().split()[2] == "Z":
                    break
        except OSError:
            break
        time.sleep(0.1)
    else:
        os.kill(pid, signal.SIGKILL)
        pytest.fail("grandchild survived the stall cut")


def test_a_chatty_child_cannot_block_on_a_full_pipe():
    run = ytdlp_client._run_download(
        _child("sys.stderr.write('e' * 300000)\n" "print('x' * 300000)\n" "print('__sl_fb__ 7')\n"),
        timeout_s=10,
        first_byte_deadline=5,
    )
    assert run.ended == ytdlp_client.EXITED and run.returncode == 0
    assert len(run.stderr) == 300000 and run.first_byte_at is not None


# ------------------------------------------------------------------- fetch_audio_file


@pytest.fixture
def fake_download(monkeypatch, tmp_path):
    """fetch_audio_file with the subprocess faked: each call pops the next scripted result."""
    box: dict = {"script": [], "cmds": [], "deadlines": [], "proxies": []}

    def fake_run(cmd, timeout_s, first_byte_deadline):
        box["cmds"].append(cmd)
        box["deadlines"].append((timeout_s, first_byte_deadline))
        box["proxies"].append(cmd[cmd.index("--proxy") + 1] if "--proxy" in cmd else None)
        kind = box["script"].pop(0)
        now = time.monotonic()
        if kind == "stall":
            return ytdlp_client.DownloadRun(ytdlp_client.STALLED, None, "", None)
        if kind == "timeout":
            return ytdlp_client.DownloadRun(ytdlp_client.TIMED_OUT, None, "", now)
        (tmp_path / "dQw4w9WgXcQ.wav").write_bytes(b"RIFF")
        return ytdlp_client.DownloadRun(ytdlp_client.EXITED, 0, "", now)

    monkeypatch.setattr(ytdlp_client, "_run_download", fake_run)
    monkeypatch.setattr(ytdlp_client, "_reject_if_live", lambda url, proxy: None)
    monkeypatch.setattr(ytdlp_client.tmpdirs, "mkdtemp", lambda prefix: str(tmp_path))
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", PROXY)
    monkeypatch.setattr(ytdlp_client, "TIMEOUT", 30)
    monkeypatch.delenv(ENV, raising=False)
    return box


def test_the_command_asks_yt_dlp_for_one_progress_line_per_update(fake_download):
    fake_download["script"] = ["ok"]
    ytdlp_client.fetch_audio_file(URL)
    cmd = fake_download["cmds"][0]
    assert "--newline" in cmd
    tpl = cmd[cmd.index("--progress-template") + 1]
    assert tpl == "download:__sl_fb__ %(progress.downloaded_bytes)s"
    assert cmd.index("--progress-template") < cmd.index("--"), "options before the URL guard"
    assert fake_download["deadlines"] == [(30, 15.0)]


def test_deadline_comes_from_the_env(fake_download, monkeypatch):
    monkeypatch.setenv(ENV, "22")
    fake_download["script"] = ["ok"]
    ytdlp_client.fetch_audio_file(URL)
    assert fake_download["deadlines"] == [(30, 22.0)]


def test_success_records_ms_first_byte_from_attempt_start(fake_download):
    fake_download["script"] = ["ok"]
    ytdlp_client.fetch_audio_file(URL)
    ms = ytdlp_client.last_first_byte_ms()
    assert isinstance(ms, int) and 0 <= ms < 5000


def test_a_proxied_stall_is_a_retryable_proxy_failure_without_credentials(fake_download, capsys):
    fake_download["script"] = ["stall"]
    with pytest.raises(FetchProxyFailedError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert ei.value.error_code == "FETCH_PROXY_FAILED"
    assert ei.value.cause == "first_byte_stall" == ei.value.failure_reason
    assert ei.value.retryable is True
    assert ytdlp_client.last_first_byte_ms() is None
    out = capsys.readouterr()
    for secret in ("s3cr3tpass", "someuser", "_session-"):
        assert secret not in str(ei.value) and secret not in out.err and secret not in out.out
    assert "ytdlp_first_byte_stall" in out.err


def test_a_direct_stall_is_a_download_timeout_with_its_own_reason(fake_download, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    fake_download["script"] = ["stall"]
    with pytest.raises(DownloadTimeoutError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert not isinstance(ei.value, FetchProxyFailedError)
    assert ei.value.failure_reason == "first_byte_stall"


def test_the_overall_timeout_is_still_download_timeout_and_keeps_its_first_byte(fake_download):
    fake_download["script"] = ["timeout"]
    with pytest.raises(DownloadTimeoutError) as ei:
        ytdlp_client.fetch_audio_file(URL)
    assert ei.value.failure_reason is None
    assert isinstance(ytdlp_client.last_first_byte_ms(), int), "slow-but-moving: byte recorded"


def test_stall_code_is_ours_so_the_allowance_comes_back():
    """The FINAL error of an all-stall job: our-fault (042 allowance restore, refund policy,
    Sentry), and an infrastructure code for the burst detector."""
    assert FetchProxyFailedError("first_byte_stall").error_code in job_failure.OUR_FAULT_CODES
    assert "FETCH_PROXY_FAILED" in fetch_alerts.INFRA_CODES


# ------------------------------------------------------------------- the chain


class Gates:
    def __init__(self, monkeypatch):
        self.attempts: list[dict] = []
        monkeypatch.setattr(fetch_gates, "is_blocklisted", lambda vid: False)
        monkeypatch.setattr(fetch_gates, "fetch_paused", lambda: None)
        monkeypatch.setattr(fetch_gates, "cobalt_allowed", lambda: False)
        monkeypatch.setattr(fetch_gates, "log_attempt", lambda **kw: self.attempts.append(kw))
        monkeypatch.setattr(fetch_gates, "ytdlp_version", lambda: "test")
        monkeypatch.setattr(downloader, "YTDLP_MAX_ATTEMPTS", 2)
        monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0)
        monkeypatch.setattr(downloader.time, "sleep", lambda s: None)


@pytest.fixture
def gates(monkeypatch):
    return Gates(monkeypatch)


def test_stall_then_rotated_exit_succeeds(fake_download, gates):
    fake_download["script"] = ["stall", "ok"]
    path, source = downloader.download_audio(URL, JOB)
    assert source == "ytdlp" and path.endswith(".wav")
    rows = gates.attempts
    assert [r["outcome_class"] for r in rows] == ["FETCH_PROXY_FAILED", "ok"]
    assert rows[0]["ms_first_byte"] is None
    assert isinstance(rows[1]["ms_first_byte"], int)
    assert rows[1]["ms_first_byte"] <= rows[1]["ms_total"] + 1
    # Rotated: a fresh sticky session (exit) on the retry.
    p1, p2 = fake_download["proxies"]
    assert p1 != p2
    assert rows[0]["exit_session_hash"] != rows[1]["exit_session_hash"]
    for r in rows:
        assert "s3cr3tpass" not in str(r)


def test_every_attempt_stalling_fails_as_ours_within_the_attempt_budget(fake_download, gates):
    fake_download["script"] = ["stall", "stall"]
    with pytest.raises(FetchProxyFailedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.cause == "first_byte_stall"
    assert len(fake_download["cmds"]) == 2, "no extra attempts: the budget is unchanged"
    assert [r["ms_first_byte"] for r in gates.attempts] == [None, None]


def test_every_attempt_stalling_direct_fails_as_download_timeout(fake_download, gates, monkeypatch):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    fake_download["script"] = ["stall", "stall"]
    with pytest.raises(DownloadTimeoutError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.failure_reason == "first_byte_stall"
    assert [r["outcome_class"] for r in gates.attempts] == ["DOWNLOAD_TIMEOUT"] * 2


def test_a_407_still_fails_fast_and_records_no_first_byte(fake_download, gates, monkeypatch):
    """#307 unchanged: a credential failure is not retried, stall deadline or not."""

    def run_407(cmd, timeout_s, first_byte_deadline):
        fake_download["cmds"].append(cmd)
        return ytdlp_client.DownloadRun(
            ytdlp_client.EXITED, 1, "ERROR: Tunnel connection failed: 407 Proxy Auth", None
        )

    monkeypatch.setattr(ytdlp_client, "_run_download", run_407)
    with pytest.raises(FetchProxyFailedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.cause == "proxy_auth"
    assert len(fake_download["cmds"]) == 1
    assert gates.attempts[0]["ms_first_byte"] is None


def test_a_faked_fetcher_never_reports_a_stale_first_byte(gates, monkeypatch):
    """begin_attempt() runs before every attempt, so a reading never leaks into the next row."""
    ytdlp_client._attempt.ms_first_byte = 999
    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", lambda url: "/tmp/x.wav")
    downloader.download_audio(URL, JOB)
    assert gates.attempts[0]["ms_first_byte"] is None


# ------------------------------------------------------------------- persistence (offline)


def test_log_attempt_sends_ms_first_byte_to_the_insert(monkeypatch):
    seen: dict = {}

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params):
            seen["sql"], seen["params"] = sql, params

        def commit(self):
            pass

    monkeypatch.setattr(fetch_gates, "_connect", lambda: Conn())
    fetch_gates.log_attempt(
        job_id=JOB,
        attempt=1,
        path="ytdlp_proxy",
        outcome_class="ok",
        ms_total=9000,
        video_id="dQw4w9WgXcQ",
        ms_first_byte=4321,
    )
    cols = seen["sql"].split("(", 1)[1].split(")", 1)[0].replace(" ", "").split(",")
    assert seen["params"][cols.index("ms_first_byte")] == 4321


# ------------------------------------------------------------------- alert copy


def test_stall_alert_does_not_send_operators_to_the_credentials(monkeypatch):
    sent: list[str] = []

    class Scope:
        fingerprint = None

        def set_tag(self, k, v):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(fetch_alerts.sentry_sdk, "new_scope", lambda: Scope())
    monkeypatch.setattr(
        fetch_alerts.sentry_sdk, "capture_message", lambda msg, level=None: sent.append(msg)
    )
    monkeypatch.setattr(fetch_alerts, "_reported_causes", set())
    assert fetch_alerts.report_proxy_failure("first_byte_stall") is True
    assert "first_byte_stall" in sent[0] and "credentials" not in sent[0]
    assert fetch_alerts.report_proxy_failure("proxy_auth") is True
    assert "check PROXY_URL credentials" in sent[1]
