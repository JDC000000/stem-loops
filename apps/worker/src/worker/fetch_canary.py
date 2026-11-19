"""Fetch canary: is the link path (our proxy + YouTube) working right now? (QA-61)

From 2026-11-18 23:04Z the residential-proxy credentials were rejected (HTTP 407) and every
link job failed; nothing said so until a user's job did. The canary finds that out without a
user: every ``FETCH_CANARY_INTERVAL_SECONDS`` (default 900) a daemon thread resolves the
metadata of one fixed, public, long-lived video (``CANARY_YOUTUBE_ID``) through the SAME
proxy path a real fetch uses (``ytdlp_client.canary_probe``), downloading nothing.

* Failure (first, or a different cause than the last failure): log ERROR and one Sentry
  ERROR, fingerprint ``["fetch-canary", cause]``, cause one of proxy_auth / proxy_connect /
  youtube_bot_check / other. A failure that persists with the same cause logs ERROR each
  check but does not re-send to Sentry.
* Recovery (a success after a failure): log INFO and one Sentry INFO, and re-arm the
  per-job FETCH_PROXY_FAILED reports so the next outage reports again.
* ``canary_state()`` is served on /health as ``fetch_canary``. /health stays 200 whatever it
  says: a dead proxy is not a reason for Fly to restart the worker.

Runs only where the link path is live (``ALLOW_YOUTUBE_INPUT=true``) and the interval is
positive; ``FETCH_CANARY_INTERVAL_SECONDS=0`` turns it off. It never raises, never blocks
the poll loop (own daemon thread, each probe bounded by ``FETCH_CANARY_TIMEOUT_SECONDS``),
and never logs or sends text from yt-dlp: only the cause class. PROXY_URL carries
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
DEFAULT_INTERVAL_S = 900
DEFAULT_TIMEOUT_S = 45.0
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

_state_lock = threading.Lock()
_state: dict = {"enabled": False, "ok": None, "last_checked": None, "cause": None}
_thread: threading.Thread | None = None
_start_lock = threading.Lock()


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


def timeout_s() -> float:
    value = _env_float("FETCH_CANARY_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_S)
    return value if value > 0 else DEFAULT_TIMEOUT_S


def enabled() -> bool:
    return os.environ.get("ALLOW_YOUTUBE_INPUT", "").lower() == "true" and interval_s() > 0


def canary_state() -> dict:
    """A copy of the canary's last result for /health. Holds no secrets: a bool, a
    timestamp, a cause class and whether the canary runs at all."""
    with _state_lock:
        return dict(_state)


def reset_state() -> None:
    """Tests only."""
    with _state_lock:
        _state.update({"enabled": False, "ok": None, "last_checked": None, "cause": None})


def _send(message: str, level: str, cause: str | None) -> None:
    with contextlib.suppress(Exception), sentry_sdk.new_scope() as scope:
        scope.set_tag("cause", cause or "none")
        scope.fingerprint = ["fetch-canary", cause or "recovered"]
        sentry_sdk.capture_message(message, level=level)


def _probe(video_id: str):
    from .downloader import ytdlp_client

    return ytdlp_client.canary_probe(f"https://www.youtube.com/watch?v={video_id}", timeout_s())


def run_once(probe=None) -> dict:
    """One canary check. Updates the state, logs, and alerts on transitions. Never raises."""
    try:
        result = (probe or _probe)(canary_video_id())
        ok, cause = bool(result.ok), (None if result.ok else (result.cause or "other"))
    except Exception as exc:  # noqa: BLE001 — a canary must never take anything down
        log_structured("WARN", "fetch_canary_probe_error", error=type(exc).__name__)
        ok, cause = False, "other"

    now = datetime.now(UTC).isoformat(timespec="seconds")
    with _state_lock:
        prev_ok, prev_cause = _state["ok"], _state["cause"]
        _state.update({"enabled": True, "ok": ok, "last_checked": now, "cause": cause})

    if ok:
        if prev_ok is False:
            log_structured("INFO", "fetch_canary_recovered", previous_cause=prev_cause)
            _send("fetch canary recovered", "info", None)
        rearm_proxy_failure_reports()
    else:
        log_structured("ERROR", "fetch_canary_failed", cause=cause)
        if prev_ok is not False or prev_cause != cause:
            _send(f"fetch canary failed ({cause})", "error", cause)
    return canary_state()


def _loop() -> None:
    while True:
        with contextlib.suppress(Exception):  # run_once never raises; belt and braces
            run_once()
        time.sleep(max(interval_s(), 60.0))


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
