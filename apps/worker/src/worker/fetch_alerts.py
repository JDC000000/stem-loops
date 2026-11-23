"""Alerts for link-fetch failures that are OURS, not the user's (QA-61).

2026-11-18 23:04Z: the residential-proxy credentials lapsed and every link job failed with
yt-dlp's ``Tunnel connection failed: 407 Proxy Authentication Required``. The jobs were
classed DOWNLOAD_BLOCKED, a user-fault code that is deliberately NOT sent to Sentry, so the
outage was silent until QA noticed. Two signals close that:

* ``report_proxy_failure`` -- a FETCH_PROXY_FAILED job is reported at ERROR level, ONCE per
  process per cause (``proxy_auth`` / ``proxy_connect``), under fingerprint
  ``["fetch-proxy-failed", cause]``. Once, because during an outage every job fails the same
  way and one event per job is noise; per cause, because a credential failure and an
  unreachable proxy need different fixes. ``rearm_proxy_failure_reports`` (called by the
  fetch canary when the path recovers) lets the NEXT outage report again.

* ``DownloadBurstDetector`` -- N consecutive link-job download failures with the same
  infrastructure-class code (``INFRA_CODES``), across N different videos, within a window,
  is one Sentry ERROR under fingerprint ``["download-failure-burst", error_code]``. This
  catches the next outage that wears a user-fault code (a YouTube-wide bot wall, a yt-dlp
  extractor break): several different videos in a row failing the same way is us.

Nothing here carries a credential: messages are fixed strings and tags are low-cardinality
classes. No video ids are sent (a count of distinct ids is). Every function swallows its own
errors: telemetry must never fail a job or kill a thread.
"""

from __future__ import annotations

import contextlib
import os
import threading
import time
from collections import deque

import sentry_sdk

from .logger import log_structured

_lock = threading.Lock()
_reported_causes: set[str] = set()


_PROXY_FAILURE_DEFAULT = "link fetch failed at our proxy ({cause}); check PROXY_URL credentials"
# #320: a stall is not a credential problem; say what it is.
_PROXY_FAILURE_MESSAGES = {
    "first_byte_stall": (
        "link fetch failed at our proxy ({cause}): the last attempt's exit sent no media byte "
        "before FETCH_FIRST_BYTE_DEADLINE_SEC"
    ),
    # Q-B: a YouTube block while the fetch canary's check was failing (downloader
    # _attribute_block_to_outage): classed ours so the song comes back.
    "canary_proxy": (
        "link fetch blocked while the fetch canary's proxy check was failing ({cause}); "
        "treated as our outage"
    ),
    "canary_youtube": (
        "link fetch blocked while the fetch canary's youtube check was failing ({cause}); "
        "treated as our outage"
    ),
}


def report_proxy_failure(cause: str) -> bool:
    """Send one Sentry ERROR for this proxy-failure cause, unless this process already has.
    Returns True if THIS call sent it."""
    cause = (cause or "unknown")[:32]
    with _lock:
        if cause in _reported_causes:
            return False
        _reported_causes.add(cause)
    log_structured("ERROR", "fetch_proxy_failed", cause=cause)
    with contextlib.suppress(Exception), sentry_sdk.new_scope() as scope:
        scope.set_tag("error_code", "FETCH_PROXY_FAILED")
        scope.set_tag("cause", cause)
        scope.fingerprint = ["fetch-proxy-failed", cause]
        sentry_sdk.capture_message(
            _PROXY_FAILURE_MESSAGES.get(cause, _PROXY_FAILURE_DEFAULT).format(cause=cause),
            level="error",
        )
    return True


def rearm_proxy_failure_reports() -> None:
    """Allow the next proxy failure to report again (the path was seen healthy)."""
    with _lock:
        _reported_causes.clear()


def _env_int(name: str, default: int, minimum: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        log_structured("WARN", "env_int_invalid", name=name)
        return default
    return value if value >= minimum else default


# Only INFRASTRUCTURE-class codes count (review m-1): a fetch path that is failing for us.
# User-class codes (DOWNLOAD_PRIVATE, DOWNLOAD_AGE_RESTRICTED, DOWNLOAD_INVALID_URL -- which the
# live-stream refusal shares) are properties of the video someone pasted; three users pasting
# private links in a row is not an outage. They neither count nor break a streak. Kill-switch
# and blocklist refusals never arrive (downloader/__init__.py records only past those gates).
INFRA_CODES = frozenset({"DOWNLOAD_BLOCKED", "DOWNLOAD_TIMEOUT", "FETCH_PROXY_FAILED"})


class DownloadBurstDetector:
    """Consecutive same-code INFRASTRUCTURE download failures across distinct videos within a
    window. A success, or an infra failure with a different code, ends the streak; a
    user-class failure is ignored. Entries older than
    ``window_s`` fall out of it. One alert per streak: the streak must end before another.
    """

    def __init__(
        self,
        threshold: int | None = None,
        window_s: float | None = None,
        clock=time.monotonic,
    ) -> None:
        self.threshold = (
            threshold
            if threshold is not None
            else _env_int("DOWNLOAD_BURST_THRESHOLD", 3, minimum=2)
        )
        self.window_s = (
            window_s
            if window_s is not None
            else float(_env_int("DOWNLOAD_BURST_WINDOW_SECONDS", 1800, minimum=60))
        )
        self._clock = clock
        self._lock = threading.Lock()
        self._code: str | None = None
        self._streak: deque[tuple[float, str]] = deque()
        self._alerted = False

    def _reset(self) -> None:
        self._code = None
        self._streak.clear()
        self._alerted = False

    def record_success(self) -> None:
        with self._lock:
            self._reset()

    def record_failure(self, error_code: str, video_id: str) -> bool:
        """Record one failed link download. Returns True if this failure raised the alert."""
        if error_code not in INFRA_CODES:
            return False
        now = self._clock()
        with self._lock:
            if error_code != self._code:
                self._reset()
                self._code = error_code
            self._streak.append((now, video_id))
            while self._streak and now - self._streak[0][0] > self.window_s:
                self._streak.popleft()
            distinct = len({vid for _, vid in self._streak})
            if self._alerted or distinct < self.threshold:
                return False
            self._alerted = True
            count = len(self._streak)
        log_structured(
            "ERROR",
            "download_failure_burst",
            error_code=error_code,
            failures=count,
            distinct_videos=distinct,
            window_s=self.window_s,
        )
        with contextlib.suppress(Exception), sentry_sdk.new_scope() as scope:
            scope.set_tag("error_code", error_code)
            scope.set_extra("failures", count)
            scope.set_extra("distinct_videos", distinct)
            scope.fingerprint = ["download-failure-burst", error_code]
            sentry_sdk.capture_message(
                f"{distinct} different videos failed to download in a row ({error_code})",
                level="error",
            )
        return True


burst_detector = DownloadBurstDetector()
