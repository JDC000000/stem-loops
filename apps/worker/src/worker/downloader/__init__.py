"""Dual-path YouTube downloader (T12) with SSRF allowlist.

Cobalt primary → yt-dlp fallback (Gate 0 S1 architecture decision). The SSRF
guard validates the host against a YouTube allowlist before any outbound call
(P1-29/P2-8). NOT wired into the live pipeline until the S1 bake-off passes.

R2 addendum (2026-07-16, see spikes/s1_bakeoff/r2_decision.md): a residential-
proxy fetch has noisy per-ATTEMPT success (measured 82-98% single-attempt
across 3 spike runs on the identical 50-URL fixture — some assigned exit IPs
in a shared pool are already flagged, others aren't), but a single retry (a
fresh subprocess = a fresh proxy connection = very likely a different exit IP)
recovered 8/9 and 1/2 failures in the two runs that hit failures, landing at
98.0% effective success both times. Nothing upstream of this module retries a
clean typed error — pipeline.py's `except StemLoopsError` fails the job
immediately, and the reaper only requeues STALE/orphaned jobs, not ones that
raised cleanly — so without a retry HERE, ~1-in-10-ish jobs would fail for a
transient IP-reputation reason a second attempt would very likely clear.
"""

import os
import re
import time

from ..errors import DownloadBlockedError, DownloadInvalidUrlError, DownloadTimeoutError
from ..logger import log_structured
from . import cobalt_client, ytdlp_client

_ALLOWED = re.compile(r"^https?://(www\.|m\.)?(youtube\.com|youtu\.be)(/|$)", re.IGNORECASE)

# Only retry error classes where a DIFFERENT exit IP plausibly changes the outcome.
# DOWNLOAD_AGE_RESTRICTED / DOWNLOAD_PRIVATE / DOWNLOAD_INVALID_URL are properties of
# the video itself, not the network path — retrying those just burns the retry budget
# on a guaranteed-identical result.
_RETRYABLE = (DownloadBlockedError, DownloadTimeoutError)
YTDLP_MAX_ATTEMPTS = int(os.environ.get("YTDLP_MAX_ATTEMPTS", "2"))
YTDLP_RETRY_DELAY_S = float(os.environ.get("YTDLP_RETRY_DELAY_S", "2"))


def _ssrf_guard(url: str) -> None:
    if not _ALLOWED.match(url):
        raise DownloadInvalidUrlError(f"URL not in allowlist: {url}")


def download_audio(youtube_url: str) -> tuple[str, str]:
    """Return (path_or_url, source) where source is 'cobalt' or 'ytdlp'."""
    _ssrf_guard(youtube_url)
    try:
        url = cobalt_client.fetch_audio_url(youtube_url)
        log_structured("INFO", "cobalt_success")
        return url, "cobalt"
    except Exception as e:  # noqa: BLE001 — any Cobalt failure falls through to yt-dlp
        log_structured("WARN", "cobalt_failed_fallback", error=str(e)[:200])

    last_exc: Exception | None = None
    for attempt in range(1, max(YTDLP_MAX_ATTEMPTS, 1) + 1):
        try:
            path = ytdlp_client.fetch_audio_file(youtube_url)
            if attempt > 1:
                log_structured("INFO", "ytdlp_recovered_on_retry", attempt=attempt)
            return path, "ytdlp"
        except _RETRYABLE as e:
            last_exc = e
            if attempt < YTDLP_MAX_ATTEMPTS:
                log_structured("WARN", "ytdlp_retrying", attempt=attempt,
                                error_code=getattr(e, "error_code", None))
                time.sleep(YTDLP_RETRY_DELAY_S)
                continue
            raise
    raise last_exc  # unreachable given the loop above always returns or raises
