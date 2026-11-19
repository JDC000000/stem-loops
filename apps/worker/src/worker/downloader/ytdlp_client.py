"""yt-dlp fallback client (T12) — server-managed cookies, never user-exposed.

Captured stderr is passed through redact_secrets() before it is logged, so no
cookie/token material can leak (PRD §6.1). NOT wired into the live pipeline until
the S1 bake-off passes.

R2 addendum (2026-07-16, see documents/requirements/stem-loops/
youtube-input-v2-research.md): S1's 0/50 result was IP-reputation, not a code
bug (positive control + IP-bound byte-URLs). PROXY_URL routes this client's
egress through a residential/mobile proxy instead of datacenter egress — the
one variable the R2 research found actually addresses the confirmed root
cause. Optional and additive: unset PROXY_URL and behavior is byte-for-byte
identical to the original T12 client. Gated on the residential_bakeoff.py
spike clearing the same >=95%/p90<10s bar S1 used, before ALLOW_YOUTUBE_INPUT
is ever flipped on in prod.
"""

import hashlib
import os
import re
import secrets
import string
import subprocess
import sys
import threading
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from .. import tmpdirs
from ..errors import (
    DownloadAgeRestrictedError,
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadPrivateError,
    DownloadTimeoutError,
    FetchProxyFailedError,
    LiveStreamNotSupportedError,
)
from ..logger import log_structured, redact_secrets
from ..titles import clean_title

COOKIE_DIR = os.environ.get("YTDLP_COOKIE_DIR", "")
PROXY_URL = os.environ.get("PROXY_URL", "")  # e.g. http://user:pass@geo.iproyal.com:12321
# R2 spike (r2_decision.md) measured p50~4.5s / p90~10-13s / occasional outliers to ~26s
# through the residential proxy — 20s cut off legitimate slow-but-successful fetches
# (false DOWNLOAD_TIMEOUT), so give proxied fetches real headroom.
TIMEOUT = 10 if not PROXY_URL else 30


# R2 fix (found during staging end-to-end test): the original bare "age" substring
# match false-positived on ordinary words like "webpage"/"message", mislabeling a bot
# block as DOWNLOAD_AGE_RESTRICTED. Bot-block phrases are checked first (mirrors the
# classify() taxonomy already proven out in spikes/s1_bakeoff/*_bakeoff.py), and every
# remaining keyword is a multi-word phrase so it can't match inside an unrelated word.
_STDERR_MAP = [
    ("sign in to confirm", DownloadBlockedError),
    ("not a bot", DownloadBlockedError),
    ("confirm your age", DownloadAgeRestrictedError),
    ("age-restricted", DownloadAgeRestrictedError),
    ("private video", DownloadPrivateError),
    ("video is private", DownloadPrivateError),
    ("video unavailable", DownloadBlockedError),
    ("video is not available", DownloadBlockedError),
    ("invalid url", DownloadInvalidUrlError),
]


# QA-61: failures of OUR proxy, not of YouTube. Checked BEFORE _STDERR_MAP so a proxy outage
# can never be reported to the user as "YouTube is blocking" again. Every pattern is a phrase
# that only the proxy leg produces (urllib3 / requests / yt-dlp's networking wording); a bare
# "407" is never matched, since a video id or byte count can contain those digits.
PROXY_AUTH = "proxy_auth"
PROXY_CONNECT = "proxy_connect"
YOUTUBE_BOT_CHECK = "youtube_bot_check"
OTHER = "other"
_PROXY_PATTERNS = [
    # Credentials: the proxy answered and refused us. Not transient.
    (re.compile(r"proxy authentication required", re.I), PROXY_AUTH),
    (re.compile(r"tunnel connection failed:\s*407\b", re.I), PROXY_AUTH),
    (re.compile(r"\b407\b[^\n]{0,40}\bproxy\b", re.I), PROXY_AUTH),
    # Reachability: the proxy could not be reached or could not open the CONNECT tunnel.
    (re.compile(r"unable to connect to proxy", re.I), PROXY_CONNECT),
    (re.compile(r"cannot connect to proxy", re.I), PROXY_CONNECT),
    (re.compile(r"tunnel connection failed", re.I), PROXY_CONNECT),
    (re.compile(r"\bproxyerror\b", re.I), PROXY_CONNECT),
]
_BOT_CHECK_PHRASES = ("sign in to confirm", "not a bot")


def proxy_failure_cause(stderr: str | None) -> str | None:
    """``proxy_auth`` / ``proxy_connect`` when yt-dlp's stderr shows OUR proxy failed, else None.

    Auth patterns are tried first: "Unable to connect to proxy ... Tunnel connection failed:
    407 Proxy Authentication Required" is a credential failure, not a reachability one.
    """
    text = stderr or ""
    for pattern, cause in _PROXY_PATTERNS:
        if pattern.search(text):
            return cause
    return None


def classify_fetch_failure(stderr: str | None) -> str:
    """Cause class for a failed yt-dlp call: proxy_auth / proxy_connect / youtube_bot_check /
    other. Used by the fetch canary; never returns any part of the stderr itself."""
    cause = proxy_failure_cause(stderr)
    if cause:
        return cause
    lower = (stderr or "").lower()
    if any(p in lower for p in _BOT_CHECK_PHRASES):
        return YOUTUBE_BOT_CHECK
    return OTHER


# SL21: per-thread record of the LAST attempt's exit-session hash so downloader/__init__.py can
# log it to fetch_attempts without touching proxy behaviour. Only a hash of the sticky session
# id is kept, never the id or any proxy credential.
_attempt = threading.local()


def last_session_hash() -> str | None:
    return getattr(_attempt, "session_hash", None)


def _record_session(proxy: str) -> None:
    m = re.search(r"_session-([a-z0-9]+)_", proxy or "")
    _attempt.session_hash = hashlib.sha256(m.group(1).encode()).hexdigest()[:16] if m else None


def _pick_cookie_file() -> str | None:
    if not COOKIE_DIR or not os.path.isdir(COOKIE_DIR):
        return None
    files = sorted(f for f in os.listdir(COOKIE_DIR) if f.endswith(".txt"))
    return os.path.join(COOKIE_DIR, files[0]) if files else None


def _sticky_proxy_url() -> str:
    """R2 fix (found during staging E2E test — real full downloads, not the bake-off's
    --simulate metadata probe): a plain IPRoyal connection string rotates its exit IP
    per NEW connection by default. yt-dlp makes several requests per video (webpage,
    player API, then the actual byte download), and the signed googlevideo.com media
    URL it gets back is itself IP-bound — so if the byte-download request lands on a
    different rotated IP than the one that resolved the URL, it 403s even though
    everything is going through the same proxy account. Symptom seen live: webpage/API
    extraction consistently succeeded, the very next request (the byte fetch) 403'd,
    every time, for the same video.

    Fix: IPRoyal supports "sticky sessions" — appending `_session-<id>_lifetime-<dur>`
    to the password pins ALL requests using that exact proxy string to one exit IP for
    the session's lifetime (docs.iproyal.com/proxies/residential/proxy/rotation). A
    FRESH random session id is generated on every call (i.e. every fetch attempt), so
    within one attempt all of yt-dlp's requests share one IP (fixing the 403), while a
    RETRY (download_audio()'s bounded retry loop, __init__.py) still gets a brand new
    IP rather than being stuck retrying the same bad one.

    IPRoyal-specific syntax — only applied when the configured host looks like an
    IPRoyal endpoint, so a future switch to a different proxy vendor doesn't silently
    corrupt that vendor's password with a suffix it doesn't understand.
    """
    if not PROXY_URL:
        return PROXY_URL
    parts = urlsplit(PROXY_URL)
    if "iproyal.com" not in (parts.hostname or "") or not parts.username or not parts.password:
        return PROXY_URL
    session_id = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    new_password = f"{parts.password}_session-{session_id}_lifetime-2m"
    netloc = f"{parts.username}:{new_password}@{parts.hostname}"
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _reject_if_live(youtube_url: str, proxy: str) -> None:
    """R2 fix (found during staging E2E test): one of the fixture URLs turned out to be
    a 24/7 lofi-radio live stream — yt-dlp happily tries to download an HLS live stream
    forever since it has no fixed end, which manifested as a mysterious ~2min+ hang /
    DOWNLOAD_TIMEOUT that had nothing to do with the proxy. A `--simulate` metadata-only
    probe is fast (no download) and lets us reject deterministically before burning the
    full download timeout AND the retry budget on a video that will never finish. Fails
    open on any probe hiccup (timeout/error here just proceeds to the real attempt,
    which has its own error handling) — this is a fast-path optimization, not a gate.
    """
    cmd = [sys.executable, "-m", "yt_dlp", "--simulate", "--no-warnings", "--print", "is_live"]
    if proxy:
        cmd += ["--proxy", proxy]
    # `--` ends option parsing (QA track B, B-09): the URL can never be read as a flag.
    cmd += ["--", youtube_url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return
    if r.returncode == 0 and r.stdout.strip().splitlines()[:1] == ["True"]:
        raise LiveStreamNotSupportedError("is_live=True")


@dataclass(frozen=True)
class LinkMetadata:
    """What one metadata-only yt-dlp call tells us about a link (design v1.4, P5.1).

    ``duration_sec``: ``None`` means UNKNOWN, never "short enough" (see ``probe_metadata``).
    ``title``: already passed through ``titles.clean_title``; ``None`` when absent.
    """

    duration_sec: float | None
    title: str | None


UNKNOWN = LinkMetadata(duration_sec=None, title=None)


def _parse_duration(line: str) -> float | None:
    try:
        value = float(line.strip())
    except ValueError:
        return None
    return value if 0 < value < float("inf") else None


def probe_metadata(youtube_url: str, proxy: str | None = None) -> LinkMetadata:
    """Length and title from yt-dlp's METADATA, downloading nothing. ONE subprocess, one
    request: ``--print duration --print title`` is the duration call this worker already made,
    with the title added (P5.1: "same request, no extra proxy traffic").

    Same ``--simulate`` mechanism ``_reject_if_live`` above already uses, and cheap for the
    same reason: under SABR it is the MEDIA request that 403s from a datacenter IP while the
    metadata resolve still succeeds (see yt-session/fly.toml), so a reading is usually
    available even where a byte fetch is not.

    Output contract: yt-dlp prints each ``--print`` field on its own line, in the order
    given. Line 1 is the duration; EVERYTHING after it is the title. The title is printed
    LAST on purpose: a title containing a line break can then only spill into its own field,
    never shift the duration.

    ``duration_sec`` is ``None`` when the length cannot be read -- probe error, timeout,
    yt-dlp's ``NA``, or a non-finite/non-positive value. ``None`` means UNKNOWN and must never
    be treated as "short enough": the enforcing measurement is taken on the staged file
    (``pipeline._trim_link_source``, which cuts to the cap), on bytes we hold. ``title`` is
    ``None`` when absent; a failed probe yields neither.
    """
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--simulate",
        "--no-warnings",
        "--print",
        "duration",
        "--print",
        "title",
    ]
    if proxy is None:
        proxy = _sticky_proxy_url()
    if proxy:
        cmd += ["--proxy", proxy]
    # `--` ends option parsing (QA track B, B-09): the URL can never be read as a flag.
    cmd += ["--", youtube_url]
    try:
        # Titles are arbitrary Unicode: decode as UTF-8 whatever the worker's locale is, and
        # never let one undecodable byte throw away the duration reading.
        r = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15
        )
    except subprocess.TimeoutExpired:
        return UNKNOWN
    if r.returncode != 0:
        return UNKNOWN
    lines = (r.stdout or "").splitlines()
    if not lines:
        return UNKNOWN
    duration = _parse_duration(lines[0])
    title = clean_title(" ".join(lines[1:])) if len(lines) > 1 else None
    return LinkMetadata(duration_sec=duration, title=title)


@dataclass(frozen=True)
class CanaryResult:
    """One metadata-only probe through the production proxy path (QA-61 fetch canary).

    ``cause`` is None on success, else one of proxy_auth / proxy_connect / youtube_bot_check /
    other. Carries no stderr: the canary reports a class, never text that could hold the
    proxy URL's credentials.
    """

    ok: bool
    cause: str | None


def canary_probe(youtube_url: str, timeout_s: float) -> CanaryResult:
    """Resolve ``youtube_url``'s metadata through the SAME proxy path a real fetch uses
    (``_sticky_proxy_url``: fresh sticky session, same credentials), downloading nothing.

    Bounded by ``timeout_s``; never raises (a timeout or a failure to start the subprocess
    is ``other``).
    """
    cmd = [sys.executable, "-m", "yt_dlp", "--simulate", "--no-warnings", "--print", "id"]
    proxy = _sticky_proxy_url()
    if proxy:
        cmd += ["--proxy", proxy]
    # `--` ends option parsing (QA track B, B-09): the URL can never be read as a flag.
    cmd += ["--", youtube_url]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return CanaryResult(ok=False, cause=OTHER)
    except Exception:  # noqa: BLE001 — a canary must never raise
        return CanaryResult(ok=False, cause=OTHER)
    if r.returncode == 0 and (r.stdout or "").strip():
        return CanaryResult(ok=True, cause=None)
    return CanaryResult(ok=False, cause=classify_fetch_failure(r.stderr))


def fetch_audio_file(youtube_url: str) -> str:
    """Download audio via yt-dlp; return a local .wav path or raise a typed error."""
    # One sticky-session proxy string for this WHOLE attempt (live-check + the actual
    # download) — see _sticky_proxy_url(). A retry (download_audio(), __init__.py)
    # calls this function again, generating a fresh session/IP each time.
    proxy = _sticky_proxy_url()
    _record_session(proxy)
    _reject_if_live(youtube_url, proxy)
    tmpdir = tmpdirs.mkdtemp(prefix="sl_ytdlp_")
    # Invoke via `python -m yt_dlp` rather than a bare `yt-dlp` — the worker's venv
    # puts the console-script on .venv/bin, which isn't guaranteed to be on PATH for
    # every process manager that launches this worker (found via the R2 staging test:
    # a bare "yt-dlp" subprocess call raised FileNotFoundError under PM2). `-m` always
    # resolves relative to whichever interpreter is running this file.
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "-x",
        "--audio-format",
        "wav",
        "-o",
        f"{tmpdir}/%(id)s.%(ext)s",
    ]
    cf = _pick_cookie_file()
    if cf:
        cmd += ["--cookies", cf]
    if proxy:
        cmd += ["--proxy", proxy]
    # `--` ends option parsing (QA track B, B-09): the URL can never be read as a flag.
    cmd += ["--", youtube_url]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired as e:
        raise DownloadTimeoutError("yt-dlp timed out") from e

    if r.returncode != 0:
        safe_err = redact_secrets((r.stderr or "")[-1000:])
        log_structured("ERROR", "ytdlp_failed", stderr=safe_err)
        proxy_cause = proxy_failure_cause(r.stderr) if proxy else None
        if proxy_cause:
            raise FetchProxyFailedError(proxy_cause)
        lower = (r.stderr or "").lower()
        for kw, exc_cls in _STDERR_MAP:
            if kw in lower:
                raise exc_cls(f"yt-dlp: {kw}")
        raise DownloadBlockedError("yt-dlp download failed")

    for f in os.listdir(tmpdir):
        if f.endswith(".wav"):
            return os.path.join(tmpdir, f)
    raise DownloadBlockedError("yt-dlp produced no output")
