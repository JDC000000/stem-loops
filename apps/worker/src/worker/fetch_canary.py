"""Fetch canary: is the link path (our proxy + YouTube) working right now? (QA-61)

From 2026-11-18 23:04Z the residential-proxy credentials were rejected (HTTP 407) and every
link job failed; nothing said so until a user's job did. The canary finds that out without a
user, with two checks on one daemon thread:

* PROXY check, every ``FETCH_CANARY_INTERVAL_SECONDS`` (default 900): open a CONNECT tunnel
  to www.youtube.com:443 through the SAME sticky proxy URL a real fetch uses and read the
  status line (``ytdlp_client.proxy_tunnel_probe``): 200 ok, 407 proxy_auth, anything else
  proxy_connect. About 1 KB on the wire, no TLS to YouTube: ~96/day = ~3 MB/month.
* FULL check, every ``FETCH_CANARY_FULL_INTERVAL_SECONDS`` (default 43200 = 12 h, and once
  at start-up): a metadata-only yt-dlp resolve of ``CANARY_YOUTUBE_ID`` with the server
  cookies, through the proxy (``ytdlp_client.canary_probe``). Catches what the proxy check
  cannot (a bot wall, expired cookies, an extractor break). A full YouTube extraction is
  ~0.25-0.6 MB through the proxy, so at 2/day it is ~15-40 MB/month (plus one per restart).
  The proxy plan is metered (1 GB/month): this is why the full probe is NOT the frequent one.

Alerting, per check, with hysteresis (QA-65): a check alerts only once it has failed
``alert_after`` times IN A ROW: ``FETCH_CANARY_PROXY_ALERT_AFTER`` (default 2) for the proxy
check, 1 for the full check (it runs every 12 h; waiting for a second failure would mean a day).
Production had single proxy-check blips (one failed CONNECT, the next one fine) 6 times in
~32 h while every real job succeeded: each one paged an ERROR and then a "recovered". Now:

* below the threshold a failure logs WARN ``fetch_canary_failed`` and sends nothing;
* at the threshold (or a cause change while alerting) it logs ERROR and sends one Sentry ERROR,
  fingerprint ``["fetch-canary", cause]``, tag ``check``; a persisting failure logs ERROR each
  time but does not re-send;
* a success after an ALERTED failure logs INFO and sends one Sentry event at level INFO
  (never error); a success after an un-alerted blip logs INFO ``fetch_canary_blip_cleared``
  and sends nothing.

/health shows every result at once (no hysteresis there). A success re-arms the per-job
FETCH_PROXY_FAILED reports so the next outage reports.

``canary_state()`` is served on /health as ``fetch_canary``. /health stays 200 whatever it
says: a dead proxy is not a reason for Fly to restart the worker.

Runs only where the link path is live (``ALLOW_YOUTUBE_INPUT=true``) and the interval is
positive. Never raises, never blocks the poll loop, every probe is bounded, and nothing from
yt-dlp or the proxy URL is logged or sent: only cause classes. PROXY_URL carries
``user:pass``.
"""

from __future__ import annotations

import contextlib
import os
import re
import threading
import time
from datetime import UTC, datetime

import sentry_sdk

from .fetch_alerts import rearm_proxy_failure_reports
from .logger import log_structured

# "Me at the zoo" (2005), the first video uploaded to YouTube: public, short, not
# age-gated, and as close to permanent as a YouTube video gets.
DEFAULT_CANARY_YOUTUBE_ID = "jNQXAC9IVRw"
DEFAULT_INTERVAL_S = 900.0
DEFAULT_FULL_INTERVAL_S = 43200.0
DEFAULT_TIMEOUT_S = 45.0
DEFAULT_PROXY_TIMEOUT_S = 10.0
DEFAULT_PROXY_ALERT_AFTER = 2
RECOVERY_LEVEL = "info"
MIN_SLEEP_S = 60.0
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

_state_lock = threading.Lock()
_thread: threading.Thread | None = None
_start_lock = threading.Lock()


def _blank() -> dict:
    return {"ok": None, "last_checked": None, "cause": None}


_state: dict = {"enabled": False, "proxy": _blank(), "youtube": _blank()}


def _blank_streak() -> dict:
    return {"failures": 0, "alerted_cause": None}


# Per-check failure streaks for the alert hysteresis. Kept out of ``_state`` so /health's
# shape does not change.
_streak: dict = {"proxy": _blank_streak(), "youtube": _blank_streak()}


def canary_video_id() -> str:
    raw = os.environ.get("CANARY_YOUTUBE_ID", "").strip()
    if not raw:
        return DEFAULT_CANARY_YOUTUBE_ID
    if not _VIDEO_ID.match(raw):
        log_structured("WARN", "fetch_canary_bad_video_id", using=DEFAULT_CANARY_YOUTUBE_ID)
        return DEFAULT_CANARY_YOUTUBE_ID
    return raw


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        log_structured("WARN", "env_float_invalid", name=name)
        return default
    return value if 0 <= value < float("inf") else default


def interval_s() -> float:
    return _env_float("FETCH_CANARY_INTERVAL_SECONDS", DEFAULT_INTERVAL_S)


def full_interval_s() -> float:
    """0 turns the full (yt-dlp) probe off; the proxy check keeps running."""
    return _env_float("FETCH_CANARY_FULL_INTERVAL_SECONDS", DEFAULT_FULL_INTERVAL_S)


def timeout_s() -> float:
    value = _env_float("FETCH_CANARY_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_S)
    return value if value > 0 else DEFAULT_TIMEOUT_S


def proxy_timeout_s() -> float:
    value = _env_float("FETCH_CANARY_PROXY_TIMEOUT_SECONDS", DEFAULT_PROXY_TIMEOUT_S)
    return value if value > 0 else DEFAULT_PROXY_TIMEOUT_S


def proxy_alert_after() -> int:
    """Consecutive failed proxy checks before an alert. Default 2; a bad or < 1 value -> 2."""
    raw = os.environ.get("FETCH_CANARY_PROXY_ALERT_AFTER", "").strip()
    if not raw:
        return DEFAULT_PROXY_ALERT_AFTER
    try:
        value = int(raw)
    except ValueError:
        log_structured("WARN", "env_int_invalid", name="FETCH_CANARY_PROXY_ALERT_AFTER")
        return DEFAULT_PROXY_ALERT_AFTER
    return value if value >= 1 else DEFAULT_PROXY_ALERT_AFTER


def _alert_after(check: str) -> int:
    return proxy_alert_after() if check == "proxy" else 1


def enabled() -> bool:
    return os.environ.get("ALLOW_YOUTUBE_INPUT", "").lower() == "true" and interval_s() > 0


def canary_state() -> dict:
    """The canary's last results for /health. Holds no secrets: bools, timestamps and cause
    classes. Top-level ``ok`` is False if either check last failed, True if at least one
    passed and none failed, None before any result; ``cause`` is the failing check's cause
    (the proxy check's first); ``last_checked`` is the latest of the two."""
    with _state_lock:
        proxy, youtube = dict(_state["proxy"]), dict(_state["youtube"])
        enabled_ = _state["enabled"]
    results = [c for c in (proxy, youtube) if c["ok"] is not None]
    failing = [c for c in (proxy, youtube) if c["ok"] is False]
    stamps = [c["last_checked"] for c in (proxy, youtube) if c["last_checked"]]
    return {
        "enabled": enabled_,
        "ok": (not failing) if results else None,
        "last_checked": max(stamps) if stamps else None,
        "cause": failing[0]["cause"] if failing else None,
        "proxy": proxy,
        "youtube": youtube,
    }


def reset_state() -> None:
    """Tests only."""
    with _state_lock:
        _state.update({"enabled": False, "proxy": _blank(), "youtube": _blank()})
        _streak.update({"proxy": _blank_streak(), "youtube": _blank_streak()})


def _send(message: str, level: str, check: str, cause: str | None) -> None:
    with contextlib.suppress(Exception), sentry_sdk.new_scope() as scope:
        scope.set_tag("check", check)
        scope.set_tag("cause", cause or "none")
        scope.fingerprint = ["fetch-canary", cause or "recovered"]
        sentry_sdk.capture_message(message, level=level)


def _record(check: str, result) -> dict:
    """Store one check's result and alert on transitions. ``result`` None means the check
    does not apply (no proxy configured): stored as ok=None, never alerts."""
    now = datetime.now(UTC).isoformat(timespec="seconds")
    if result is None:
        with _state_lock:
            _state["enabled"] = True
            _state[check] = {"ok": None, "last_checked": now, "cause": None}
        return canary_state()
    ok = bool(result.ok)
    cause = None if ok else (result.cause or "other")
    threshold = _alert_after(check)
    with _state_lock:
        _state["enabled"] = True
        _state[check] = {"ok": ok, "last_checked": now, "cause": cause}
        streak = _streak[check]
        alerted_cause = streak["alerted_cause"]
        if ok:
            failures = streak["failures"]
            _streak[check] = _blank_streak()
            send_alert = False
        else:
            streak["failures"] += 1
            failures = streak["failures"]
            send_alert = failures >= threshold and alerted_cause != cause
            if send_alert:
                streak["alerted_cause"] = cause

    if ok:
        if alerted_cause is not None:
            log_structured(
                "INFO", "fetch_canary_recovered", check=check, previous_cause=alerted_cause
            )
            _send(f"fetch canary recovered ({check})", RECOVERY_LEVEL, check, None)
        elif failures:
            log_structured("INFO", "fetch_canary_blip_cleared", check=check, failures=failures)
        rearm_proxy_failure_reports()
    elif failures >= threshold:
        log_structured("ERROR", "fetch_canary_failed", check=check, cause=cause, failures=failures)
        if send_alert:
            _send(f"fetch canary failed: {check} ({cause})", "error", check, cause)
    else:
        log_structured(
            "WARN",
            "fetch_canary_failed",
            check=check,
            cause=cause,
            failures=failures,
            alert_after=threshold,
        )
    return canary_state()


def _default_proxy_probe():
    from .downloader import ytdlp_client

    return ytdlp_client.proxy_tunnel_probe(proxy_timeout_s())


def _default_full_probe():
    from .downloader import ytdlp_client

    url = f"https://www.youtube.com/watch?v={canary_video_id()}"
    return ytdlp_client.canary_probe(url, timeout_s())


def _run(check: str, probe) -> dict:
    try:
        result = probe()
    except Exception as exc:  # noqa: BLE001 — a canary must never take anything down
        log_structured("WARN", "fetch_canary_probe_error", check=check, error=type(exc).__name__)
        result = _PROBE_RAISED
    return _record(check, result)


class _ProbeRaised:
    ok = False
    cause = "other"


_PROBE_RAISED = _ProbeRaised()


def run_proxy_check(probe=None) -> dict:
    """The cheap check (~1 KB). Never raises."""
    return _run("proxy", probe or _default_proxy_probe)


def run_full_check(probe=None) -> dict:
    """The yt-dlp metadata check (~0.25-0.6 MB). Never raises."""
    return _run("youtube", probe or _default_full_probe)


def _loop() -> None:
    next_full = 0.0  # the first pass runs the full check too
    while True:
        now = time.monotonic()
        with contextlib.suppress(Exception):  # the checks never raise; belt and braces
            run_proxy_check()
        full_every = full_interval_s()
        if full_every > 0 and now >= next_full:
            with contextlib.suppress(Exception):
                run_full_check()
            next_full = now + full_every
        time.sleep(max(interval_s(), MIN_SLEEP_S))


def start_fetch_canary() -> threading.Thread | None:
    """Start the canary daemon thread once per process. Returns at once; never raises."""
    global _thread
    try:
        if not enabled():
            log_structured("INFO", "fetch_canary_disabled")
            return None
        with _start_lock:
            if _thread is not None and _thread.is_alive():
                return _thread
            with _state_lock:
                _state["enabled"] = True
            _thread = threading.Thread(target=_loop, name="fetch-canary", daemon=True)
            _thread.start()
            return _thread
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "fetch_canary_start_failed", error=type(exc).__name__)
        return None
