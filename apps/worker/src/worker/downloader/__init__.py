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

import contextlib
import os
import re
import time

from .. import fetch_canary
from ..errors import (
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadTimeoutError,
    FetchPausedError,
    FetchProxyFailedError,
    StemLoopsError,
    VideoBlocklistedError,
)
from ..fetch_alerts import burst_detector
from ..logger import log_structured
from . import cobalt_client, fetch_gates, ytdlp_client

_ALLOWED = re.compile(r"^https?://(www\.|m\.)?(youtube\.com|youtu\.be)(/|$)", re.IGNORECASE)

# #320: a first-byte stall (ytdlp_client.first_byte_deadline_s, default 15 s) is cut only on a
# NON-FINAL attempt, raised as FETCH_PROXY_FAILED(first_byte_stall) when proxied -- retryable
# like proxy_connect -- or DOWNLOAD_TIMEOUT when direct; the next attempt gets a fresh exit.
# The final attempt runs to TIMEOUT as before, so a job's final error is never a stall cut
# and the attempt budget (YTDLP_MAX_ATTEMPTS) is unchanged.
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
    youtube_url: str,
    job_id: str | None = None,
    max_duration_sec: float | None = None,
    meta: dict | None = None,
) -> tuple[str, str]:
    """Return (path_or_url, source) where source is 'ytdlp' (local path) or 'cobalt' (URL).

    ``max_duration_sec`` is the product's one duration ceiling -- the TRIM length -- supplied
    by the caller (pipeline's ``_max_upload_duration_sec()``) rather than read here, so there
    is exactly one knob and this module owns no second copy of the number. Passing ``None``
    -- the default, and what every pre-existing caller and test does -- skips gate 0c
    entirely.

    A video LONGER than the ceiling is no longer refused here (Jon, 2026-11-14: long songs
    are trimmed to their first ``max_duration_sec`` seconds, not turned away). The yt-dlp leg
    downloads it and ``pipeline._trim_link_source`` cuts it on bytes we hold.

    ``meta``, when the caller passes a dict, receives ``meta["title"]`` (P5.1): the video
    title read by the SAME metadata call gate 0c makes, cleaned by ``titles.clean_title``, or
    ``None``. The return shape is unchanged so no caller has to learn a new one; only a caller
    that wants the title passes the dict. No cap means no gate-0c call and so no title.
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

    # QA-61: every fetch OUTCOME past the gates feeds the burst detector (fetch_alerts): N
    # different videos failing the same way in a row is an outage of ours, whatever the code.
    try:
        result = _fetch(fetch_url, video_id, job_id, max_duration_sec, meta)
    except StemLoopsError as e:
        final = _attribute_block_to_outage(e, job_id)
        with contextlib.suppress(Exception):  # telemetry never changes the outcome
            burst_detector.record_failure(final.error_code, video_id)
        if final is e:
            raise
        raise final from e
    with contextlib.suppress(Exception):
        burst_detector.record_success()
    return result


def _attribute_block_to_outage(exc: StemLoopsError, job_id: str | None) -> StemLoopsError:
    """Jon Q-B (2026-11-21): a link job's FINAL DownloadBlockedError, raised while the fetch
    canary reports our proxy / YouTube path failing right now, is OUR outage, not the video's:
    it becomes FETCH_PROXY_FAILED (an OUR_FAULT_CODES code, #307), so the job's stored code
    makes migration 042's restore_job_allowance give the song back. Issue #321: during the
    proxy outages every link job "was blocked by YouTube" and nobody got their song back.

    Exactly ``DownloadBlockedError`` -- not FetchPausedError (our deliberate kill switch,
    raised before the fetch and not an outage), not DOWNLOAD_TIMEOUT or any other code: those
    keep their classification. "Right now" is ``fetch_canary.outage_confirmed()``: the last
    result of a canary check failed and is fresh (<= 2 proxy-check periods, 30 min by
    default). A stale, missing or unreadable canary returns the original error (fail closed:
    no refund without positive evidence the path was ours to fix)."""
    if type(exc) is not DownloadBlockedError:
        return exc
    check = fetch_canary.outage_confirmed()
    if check is None:
        return exc
    log_structured("WARN", "download_blocked_during_canary_outage", job_id=job_id, check=check)
    return FetchProxyFailedError(f"canary_{check}")


def _fetch(
    fetch_url: str,
    video_id: str,
    job_id: str | None,
    max_duration_sec: float | None,
    meta: dict | None,
) -> tuple[str, str]:
    """Gate 0c, the yt-dlp attempts and the Cobalt leg, for a gate-approved video id."""
    # 0c. duration reading. Taken from metadata, before one byte is fetched, ONCE (not once
    # per retry attempt), and above the fetcher loop so it governs the Cobalt leg too.
    #
    # It refuses NOTHING. A long video is fetched in full by yt-dlp and trimmed on the bytes
    # we hold (pipeline._trim_link_source, which fails closed). Why not fetch only the first
    # N seconds with `--download-sections`: that hands the IP-bound googlevideo URL to an
    # ffmpeg sub-download, and the sticky-session proxy fix in ytdlp_client exists because a
    # media request landing on a different exit IP 403s. A full fetch is the leg already
    # proven through the proxy; the bytes are ~1 MB/min at 128 kbps.
    #
    # What the reading DOES decide is Cobalt. Cobalt hands back a URL and no bytes, so there
    # is nothing to trim and nothing to measure afterwards: this reading is the only ceiling
    # that leg can have. Cobalt is therefore tried only when ``declared`` is a number at or
    # under the cap -- never for an unreadable length and never for a long video.
    declared: float | None = None
    if max_duration_sec is not None:
        probed = ytdlp_client.probe_metadata(fetch_url)
        declared = probed.duration_sec
        if meta is not None:
            meta["title"] = probed.title
        if declared is not None and declared > max_duration_sec:
            log_structured(
                "INFO",
                "fetch_will_trim",
                job_id=job_id,
                duration_sec=round(declared, 1),
                max_sec=max_duration_sec,
            )

    attempt_no = 0
    last_exc: Exception | None = None

    # 2. yt-dlp, attempt 1; on Blocked/Timeout attempt 2 (fresh subprocess = fresh exit IP).
    for attempt in range(1, max(YTDLP_MAX_ATTEMPTS, 1) + 1):
        attempt_no += 1
        # #320: ms_first_byte is measured by ytdlp_client from the same start as ms_total.
        # Cleared here as well so a fetcher that never reaches the download cannot report the
        # previous attempt's reading.
        # #320 / review B-1: only an attempt with another one after it may be cut early.
        ytdlp_client.begin_attempt(stall_cut=attempt < YTDLP_MAX_ATTEMPTS)
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
                ms_first_byte=ytdlp_client.last_first_byte_ms(),
                ytdlp_ver=fetch_gates.ytdlp_version(),
            )
            # QA-61: a proxy CREDENTIAL failure (407) is not transient -- every attempt
            # uses the same credentials -- so it fails fast. A proxy CONNECT failure may
            # clear on a fresh connection, so it gets the same retry as Blocked/Timeout.
            # Cobalt (no proxy) may still be tried for a connect failure; if it does not
            # serve, the job fails as FETCH_PROXY_FAILED (ours), not "YouTube is blocking".
            if isinstance(e, FetchProxyFailedError):
                if not e.retryable:
                    raise
            elif not isinstance(e, _RETRYABLE):
                raise
            last_exc = e
            if attempt < YTDLP_MAX_ATTEMPTS:
                log_structured(
                    "WARN",
                    "ytdlp_retrying",
                    attempt=attempt,
                    error_code=getattr(e, "error_code", None),
                    failure_reason=getattr(e, "failure_reason", None),
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
            ms_first_byte=ytdlp_client.last_first_byte_ms(),
            nbytes=_size(path),
            ytdlp_ver=fetch_gates.ytdlp_version(),
        )
        if attempt > 1:
            log_structured("INFO", "ytdlp_recovered_on_retry", attempt=attempt)
        return path, "ytdlp"

    # 2b. Cobalt: only behind kill-switch scope fetch_cobalt (default engaged = skipped).
    # Cobalt cannot be trimmed, so it may only serve a length that was READ and is within
    # the cap. Unknown -> skipped; over the cap -> skipped (yt-dlp was the only leg that could
    # have served it, and its typed error stands).
    cobalt_unverifiable = max_duration_sec is not None and (
        declared is None or declared > max_duration_sec
    )
    if cobalt_unverifiable:
        log_structured(
            "WARN",
            "cobalt_skipped_length_unknown" if declared is None else "cobalt_skipped_cannot_trim",
            job_id=job_id,
        )
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
