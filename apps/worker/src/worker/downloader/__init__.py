"""YouTube downloader (T12) with SSRF allowlist and SL21 Phase 0 gates.

Chain (BUILD-R s2.2): blocklist -> kill switch -> yt-dlp (retry policy below) -> Cobalt, only
when kill-switch scope `fetch_cobalt` is released (default engaged = OFF) -> typed error.
The typed error keeps the drop-a-file path in front of the user. Every attempt is logged
to fetch_attempts. (Before SL21 the order was Cobalt first; Cobalt worked 1 of 90 in T-F1
day 1.) The SSRF
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

from ..errors import (
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadTimeoutError,
    FetchPausedError,
    LinkTooLongError,
    VideoBlocklistedError,
)
from ..logger import log_structured
from . import cobalt_client, fetch_gates, ytdlp_client

_ALLOWED = re.compile(r"^https?://(www\.|m\.)?(youtube\.com|youtu\.be)(/|$)", re.IGNORECASE)

# Only retry error classes where a DIFFERENT exit IP plausibly changes the outcome.
# DOWNLOAD_AGE_RESTRICTED / DOWNLOAD_PRIVATE / DOWNLOAD_INVALID_URL are properties of
# the video itself, not the network path — retrying those just burns the retry budget
# on a guaranteed-identical result. Cobalt is also only tried for these classes.
_RETRYABLE = (DownloadBlockedError, DownloadTimeoutError)
YTDLP_MAX_ATTEMPTS = int(os.environ.get("YTDLP_MAX_ATTEMPTS", "2"))
YTDLP_RETRY_DELAY_S = float(os.environ.get("YTDLP_RETRY_DELAY_S", "2"))


def _ssrf_guard(url: str) -> None:
    if not _ALLOWED.match(url):
        raise DownloadInvalidUrlError(f"URL not in allowlist: {url}")


def _outcome(exc: BaseException) -> str:
    return getattr(exc, "error_code", None) or "other_error"


def download_audio(
    youtube_url: str, job_id: str | None = None, max_duration_sec: float | None = None
) -> tuple[str, str]:
    """Return (path_or_url, source) where source is 'ytdlp' (local path) or 'cobalt' (URL).

    ``max_duration_sec`` is the product's one duration ceiling, supplied by the caller
    (pipeline's ``_max_upload_duration_sec()``) rather than read here, so there is exactly
    one knob and this module owns no second copy of the number. Passing ``None`` -- the
    default, and what every pre-existing caller and test does -- skips gate 0c entirely.
    """
    _ssrf_guard(youtube_url)

    # 0a. blocklist: refuse before any outbound call. An unreadable id is refused too, so a
    # URL shape we cannot parse can never slip past a takedown.
    video_id = fetch_gates.video_id_from_url(youtube_url)
    if video_id is None:
        raise DownloadInvalidUrlError("could not read a video id from the URL")
    if fetch_gates.is_blocklisted(video_id):
        log_structured("WARN", "fetch_refused_blocklist", job_id=job_id)
        raise VideoBlocklistedError("blocklist hit")

    # 0b. kill switch: no outbound fetch at all; the user is pointed at drop-a-file.
    paused = fetch_gates.fetch_paused()
    if paused:
        log_structured("WARN", "fetch_refused_kill_switch", job_id=job_id, scope=paused)
        raise FetchPausedError(f"kill switch {paused}")

    # SL-B24 #1: rebuild a canonical watch URL from the gate-approved id and
    # send THAT to every fetcher. A crafted raw URL like `watch?%76=A&v=B`
    # could otherwise make the gate check A while yt-dlp/Cobalt fetch B.
    # From here down, `youtube_url` is only used for logging; never for a fetch.
    fetch_url = fetch_gates.canonical_watch_url(video_id)

    # 0c. duration gate. Applied to the LINK, from metadata, before one byte is fetched and
    # therefore long before Replicate is handed anything. It sits HERE, above the fetcher
    # loop, rather than inside ytdlp_client, for two reasons: it then covers the Cobalt leg
    # as well as the yt-dlp leg, and it runs once instead of once per retry attempt.
    #
    # An unreadable length (``declared is None``) lets the yt-dlp leg proceed: that leg
    # downloads a file we then MEASURE (pipeline._enforce_link_duration, which fails closed).
    # It does NOT let the Cobalt leg proceed: Cobalt hands back a URL and no bytes, so there
    # is nothing to measure afterwards and this reading is the only ceiling that leg can have.
    # Cobalt is therefore tried only when ``declared`` is a number at or under the cap.
    declared: float | None = None
    if max_duration_sec is not None:
        declared = ytdlp_client.probe_duration_sec(fetch_url)
        if declared is not None and declared > max_duration_sec:
            log_structured(
                "INFO",
                "fetch_refused_too_long",
                job_id=job_id,
                duration_sec=round(declared, 1),
                max_sec=max_duration_sec,
            )
            raise LinkTooLongError(
                f"link duration {declared}s exceeds {max_duration_sec:g}s",
                max_seconds=max_duration_sec,
            )

    attempt_no = 0
    last_exc: Exception | None = None

    # 2. yt-dlp, attempt 1; on Blocked/Timeout attempt 2 (fresh subprocess = fresh exit IP).
    for attempt in range(1, max(YTDLP_MAX_ATTEMPTS, 1) + 1):
        attempt_no += 1
        t0 = time.monotonic()
        try:
            path = ytdlp_client.fetch_audio_file(fetch_url)
        except Exception as e:
            fetch_gates.log_attempt(
                job_id=job_id,
                attempt=attempt_no,
                path=_ytdlp_path(),
                outcome_class=_outcome(e),
                ms_total=int((time.monotonic() - t0) * 1000),
                video_id=video_id,
                exit_session_hash=ytdlp_client.last_session_hash(),
                ytdlp_ver=fetch_gates.ytdlp_version(),
            )
            if not isinstance(e, _RETRYABLE):
                raise
            last_exc = e
            if attempt < YTDLP_MAX_ATTEMPTS:
                log_structured(
                    "WARN",
                    "ytdlp_retrying",
                    attempt=attempt,
                    error_code=getattr(e, "error_code", None),
                )
                time.sleep(YTDLP_RETRY_DELAY_S)
            continue
        fetch_gates.log_attempt(
            job_id=job_id,
            attempt=attempt_no,
            path=_ytdlp_path(),
            outcome_class="ok",
            ms_total=int((time.monotonic() - t0) * 1000),
            video_id=video_id,
            exit_session_hash=ytdlp_client.last_session_hash(),
            nbytes=_size(path),
            ytdlp_ver=fetch_gates.ytdlp_version(),
        )
        if attempt > 1:
            log_structured("INFO", "ytdlp_recovered_on_retry", attempt=attempt)
        return path, "ytdlp"

    # 2b. Cobalt: only behind kill-switch scope fetch_cobalt (default engaged = skipped).
    cobalt_unverifiable = max_duration_sec is not None and declared is None
    if cobalt_unverifiable:
        log_structured("WARN", "cobalt_skipped_length_unknown", job_id=job_id)
    if not cobalt_unverifiable and fetch_gates.cobalt_allowed():
        attempt_no += 1
        t0 = time.monotonic()
        try:
            url = cobalt_client.fetch_audio_url(fetch_url)
        except Exception as e:  # noqa: BLE001 — a Cobalt failure must not mask the yt-dlp error
            fetch_gates.log_attempt(
                job_id=job_id,
                attempt=attempt_no,
                path="cobalt",
                outcome_class=_outcome(e),
                ms_total=int((time.monotonic() - t0) * 1000),
                video_id=video_id,
            )
            log_structured("WARN", "cobalt_failed", error=str(e)[:200])
        else:
            fetch_gates.log_attempt(
                job_id=job_id,
                attempt=attempt_no,
                path="cobalt",
                outcome_class="ok",
                ms_total=int((time.monotonic() - t0) * 1000),
                video_id=video_id,
            )
            return url, "cobalt"

    # 3/4. typed error -> the user is offered "drop the file" (never behind a switch).
    raise last_exc if last_exc is not None else DownloadBlockedError("no fetch path available")


def _ytdlp_path() -> str:
    return "ytdlp_proxy" if ytdlp_client.PROXY_URL else "ytdlp_direct"


def _size(path: str) -> int | None:
    try:
        return os.path.getsize(path)
    except OSError:
        return None
