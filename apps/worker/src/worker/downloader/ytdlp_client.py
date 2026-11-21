"""yt-dlp fallback client (T12) — server-managed cookies, never user-exposed.

Captured stderr is passed through redact_secrets() (via redact_tail) before it is logged, so no
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

import base64
import contextlib
import hashlib
import os
import re
import secrets
import signal
import socket
import ssl
import string
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit, urlunsplit

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
from ..logger import log_structured, redact_tail
from ..titles import clean_title

COOKIE_DIR = os.environ.get("YTDLP_COOKIE_DIR", "")
PROXY_URL = os.environ.get("PROXY_URL", "")  # e.g. http://user:pass@geo.iproyal.com:12321
# R2 spike (r2_decision.md) measured p50~4.5s / p90~10-13s / occasional outliers to ~26s
# through the residential proxy — 20s cut off legitimate slow-but-successful fetches
# (false DOWNLOAD_TIMEOUT), so give proxied fetches real headroom.
TIMEOUT = 10 if not PROXY_URL else 30

# #320: first-byte stall deadline. An attempt whose media download has received NO media byte
# this many seconds after the download subprocess started is cut (whole process group killed)
# and handed back to download_audio()'s retry loop, which rotates the exit. A slow-but-moving
# download is never cut by this: once one byte has arrived only TIMEOUT applies. Read per call
# so an env change needs no code change; bounded so a typo cannot cut every healthy fetch
# (floor) or silently exceed the job's budget (ceiling; anything >= TIMEOUT is inert because
# TIMEOUT fires first).
FIRST_BYTE_DEADLINE_ENV = "FETCH_FIRST_BYTE_DEADLINE_SEC"
FIRST_BYTE_DEADLINE_DEFAULT_S = 15.0
FIRST_BYTE_DEADLINE_MIN_S = 5.0
FIRST_BYTE_DEADLINE_MAX_S = 60.0
FIRST_BYTE_STALL = "first_byte_stall"
# yt-dlp prints one line per progress-hook call with this prefix (``--progress-template`` +
# ``--newline``). Only the number is ever read; a line must match exactly.
_PROGRESS_MARK = "__sl_fb__"
_PROGRESS_LINE = re.compile(r"^__sl_fb__ (\d+)$")


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
# can never be reported to the user as "YouTube is blocking" again.
#
# NOT USER-CONTROLLABLE (review M-1). yt-dlp echoes the video id ("ERROR: [youtube] <id>: ..."),
# and an id is 11 user-chosen characters of [A-Za-z0-9_-]: "x-407-proxy" or "-proxyerror" must
# not read as a proxy failure. So (1) the id, and every "[extractor] <token>:" prefix, is cut
# out of the text before matching, and (2) every pattern is either a phrase too long to fit in
# an id or carries a character an id cannot contain ("(", ":", " "). A "407" is only read
# inside the proxy's own "Tunnel connection failed: 407" clause.
PROXY_AUTH = "proxy_auth"
PROXY_CONNECT = "proxy_connect"
YOUTUBE_BOT_CHECK = "youtube_bot_check"
OTHER = "other"
_PROXY_PATTERNS = [
    # Credentials: the proxy answered and refused us. Not transient.
    (re.compile(r"proxy authentication required", re.I), PROXY_AUTH),
    (re.compile(r"tunnel connection failed: 407\b", re.I), PROXY_AUTH),
    # Reachability: the proxy could not be reached, could not open the CONNECT tunnel, or
    # dropped / reset the connection (review m-2). Only consulted when a proxy was in use, and
    # with a proxy every byte goes through it.
    (re.compile(r"unable to connect to proxy", re.I), PROXY_CONNECT),
    (re.compile(r"cannot connect to proxy", re.I), PROXY_CONNECT),
    (re.compile(r"tunnel connection failed", re.I), PROXY_CONNECT),
    (re.compile(r"ProxyError\("), PROXY_CONNECT),
    (re.compile(r"RemoteDisconnected\("), PROXY_CONNECT),
    (re.compile(r"remote end closed connection without response", re.I), PROXY_CONNECT),
    (re.compile(r"ConnectionResetError\("), PROXY_CONNECT),
    (re.compile(r"connection reset by peer", re.I), PROXY_CONNECT),
]
_BOT_CHECK_PHRASES = ("sign in to confirm", "not a bot")
# "[youtube] <token>:" / "[youtube:tab] <token>:" -- yt-dlp's per-item prefix. The token is
# whatever the user's URL carried.
_ITEM_PREFIX = re.compile(r"\[[\w:.-]+\]\s+[^\s:]+:")
_VIDEO_ID_IN_URL = re.compile(r"(?<=[?&]v=)[A-Za-z0-9_-]+|(?<=youtu\.be/)[A-Za-z0-9_-]+")


def _strip_user_tokens(text: str, video_id: str | None) -> str:
    text = _ITEM_PREFIX.sub("[item]:", text)
    text = _VIDEO_ID_IN_URL.sub("[id]", text)
    if video_id:
        text = text.replace(video_id, "[id]")
    return text


def proxy_failure_cause(stderr: str | None, video_id: str | None = None) -> str | None:
    """``proxy_auth`` / ``proxy_connect`` when yt-dlp's stderr shows OUR proxy failed, else None.

    Auth patterns are tried first: "Unable to connect to proxy ... Tunnel connection failed:
    407 Proxy Authentication Required" is a credential failure, not a reachability one.
    ``video_id`` (when known) is removed from the text first, as are yt-dlp's item prefixes.
    """
    text = _strip_user_tokens(stderr or "", video_id)
    for pattern, cause in _PROXY_PATTERNS:
        if pattern.search(text):
            return cause
    return None


def classify_fetch_failure(stderr: str | None, video_id: str | None = None) -> str:
    """Cause class for a failed yt-dlp call: proxy_auth / proxy_connect / youtube_bot_check /
    other. Used by the fetch canary; never returns any part of the stderr itself."""
    cause = proxy_failure_cause(stderr, video_id)
    if cause:
        return cause
    lower = _strip_user_tokens(stderr or "", video_id).lower()
    if any(p in lower for p in _BOT_CHECK_PHRASES):
        return YOUTUBE_BOT_CHECK
    return OTHER


def _video_id(youtube_url: str) -> str | None:
    m = _VIDEO_ID_IN_URL.search(youtube_url or "")
    return m.group(0) if m else None


# SL21: per-thread record of the LAST attempt's exit-session hash so downloader/__init__.py can
# log it to fetch_attempts without touching proxy behaviour. Only a hash of the sticky session
# id is kept, never the id or any proxy credential.
_attempt = threading.local()


def last_session_hash() -> str | None:
    return getattr(_attempt, "session_hash", None)


def begin_attempt() -> None:
    """Start the clock for one fetch attempt and clear the last attempt's first-byte reading.

    ``ms_first_byte`` (fetch_attempts, #320) is measured from HERE -- the same instant
    download_audio() starts ``ms_total`` from -- so ``ms_first_byte <= ms_total`` and both
    include the live-stream probe."""
    _attempt.t0 = time.monotonic()
    _attempt.ms_first_byte = None


def last_first_byte_ms() -> int | None:
    """Milliseconds from attempt start to the first MEDIA byte of the last attempt, or None
    when no media byte arrived (a stall, a failure before the download, or no attempt)."""
    return getattr(_attempt, "ms_first_byte", None)


def first_byte_deadline_s() -> float:
    """``FETCH_FIRST_BYTE_DEADLINE_SEC`` (default 15), clamped to [5, 60]. Unparseable -> 15."""
    raw = os.environ.get(FIRST_BYTE_DEADLINE_ENV, "").strip()
    if not raw:
        return FIRST_BYTE_DEADLINE_DEFAULT_S
    try:
        value = float(raw)
    except ValueError:
        log_structured("WARN", "env_float_invalid", name=FIRST_BYTE_DEADLINE_ENV)
        return FIRST_BYTE_DEADLINE_DEFAULT_S
    if value != value:  # NaN
        log_structured("WARN", "env_float_invalid", name=FIRST_BYTE_DEADLINE_ENV)
        return FIRST_BYTE_DEADLINE_DEFAULT_S
    return min(max(value, FIRST_BYTE_DEADLINE_MIN_S), FIRST_BYTE_DEADLINE_MAX_S)


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


def _run_bounded(cmd: list[str], timeout_s: float) -> tuple[int, str, str] | None:
    """Run ``cmd`` in its OWN process group; on timeout kill the whole group (review m-7:
    yt-dlp can start a JS-runtime grandchild that a plain child kill would orphan). Returns
    (returncode, stdout, stderr), or None on timeout."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(Exception):
            os.killpg(proc.pid, signal.SIGKILL)
        with contextlib.suppress(Exception):
            proc.kill()
        with contextlib.suppress(Exception):
            proc.communicate(timeout=5)
        return None
    return proc.returncode, out or "", err or ""


EXITED = "exited"
STALLED = "stalled"
TIMED_OUT = "timed_out"


@dataclass(frozen=True)
class DownloadRun:
    """How one media-download subprocess ended (#320).

    ``ended``: ``exited`` (the process finished; ``returncode`` is set), ``stalled`` (no media
    byte within the first-byte deadline; process group killed) or ``timed_out`` (the overall
    ``TIMEOUT``; process group killed). ``first_byte_at``: ``time.monotonic()`` when the first
    progress line with ``downloaded_bytes > 0`` was read, else None.
    """

    ended: str
    returncode: int | None
    stderr: str
    first_byte_at: float | None


def _kill_group(proc: subprocess.Popen) -> None:
    with contextlib.suppress(Exception):
        os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        proc.kill()


def _run_download(cmd: list[str], timeout_s: float, first_byte_deadline: float) -> DownloadRun:
    """Run the yt-dlp media download in its OWN process group, watching for the first byte.

    FIRST MEDIA BYTE (the definition behind ``fetch_attempts.ms_first_byte``): the first line
    yt-dlp's progress hook prints (``--progress-template download:...``) whose
    ``downloaded_bytes`` is > 0. The hook only runs for the media download itself (never for
    the webpage / player-API requests), so this is the first byte of the media response as
    yt-dlp counts it, within ~one read buffer.

    If no such line has arrived ``first_byte_deadline`` seconds after the process started,
    the whole group is killed (yt-dlp may run an ffmpeg / JS-runtime grandchild) and the run
    is ``stalled``. Independently, the whole run is bounded by ``timeout_s`` (``timed_out``),
    as before. stdout and stderr are drained by threads so a chatty child can never block on
    a full pipe.
    """
    start = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=True,
    )
    first: list[float] = []
    err_chunks: list[str] = []

    def read_stdout() -> None:
        with contextlib.suppress(Exception):
            for line in proc.stdout:  # type: ignore[union-attr]
                if first:
                    continue  # keep draining; only the first byte matters
                m = _PROGRESS_LINE.match(line.strip())
                if m and int(m.group(1)) > 0:
                    first.append(time.monotonic())

    def read_stderr() -> None:
        with contextlib.suppress(Exception):
            err_chunks.append(proc.stderr.read())  # type: ignore[union-attr]

    readers = [
        threading.Thread(target=read_stdout, daemon=True),
        threading.Thread(target=read_stderr, daemon=True),
    ]
    for t in readers:
        t.start()

    stall_at = start + first_byte_deadline
    end_at = start + timeout_s
    ended = EXITED
    while proc.poll() is None:
        now = time.monotonic()
        if not first and now >= stall_at:
            ended = STALLED
            break
        if now >= end_at:
            ended = TIMED_OUT
            break
        next_check = end_at if first else min(stall_at, end_at)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=max(0.0, min(next_check - now, 0.25)))
    if ended != EXITED:
        _kill_group(proc)
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)
    for t in readers:
        t.join(timeout=5)
    return DownloadRun(
        ended=ended,
        returncode=proc.returncode if ended == EXITED else None,
        stderr="".join(err_chunks),
        first_byte_at=first[0] if first else None,
    )


def canary_probe(youtube_url: str, timeout_s: float) -> CanaryResult:
    """FULL canary: resolve ``youtube_url``'s metadata through the same path a real fetch uses
    (``_sticky_proxy_url`` + the server cookie file, review m-6), downloading no media.

    A full YouTube extraction (watch page + player API, ~0.25-0.6 MB through the proxy), so
    it runs rarely (fetch_canary: every 12 h by default); ``proxy_tunnel_probe`` is the
    frequent, ~1 KB check. Bounded by ``timeout_s`` (the whole process group is killed);
    never raises (a timeout or a failure to start is ``other``).
    """
    cmd = [sys.executable, "-m", "yt_dlp", "--simulate", "--no-warnings", "--print", "id"]
    cf = _pick_cookie_file()
    if cf:
        cmd += ["--cookies", cf]
    proxy = _sticky_proxy_url()
    if proxy:
        cmd += ["--proxy", proxy]
    # `--` ends option parsing (QA track B, B-09): the URL can never be read as a flag.
    cmd += ["--", youtube_url]
    try:
        res = _run_bounded(cmd, timeout_s)
    except Exception:  # noqa: BLE001 — a canary must never raise
        return CanaryResult(ok=False, cause=OTHER)
    if res is None:
        return CanaryResult(ok=False, cause=OTHER)
    code, out, err = res
    if code == 0 and out.strip():
        return CanaryResult(ok=True, cause=None)
    return CanaryResult(ok=False, cause=classify_fetch_failure(err, _video_id(youtube_url)))


TUNNEL_TARGET = "www.youtube.com:443"
_TUNNEL_READ_MAX = 1024


def proxy_tunnel_probe(timeout_s: float, proxy_url: str | None = None) -> CanaryResult | None:
    """QUICK canary (review B-2): can our proxy open a tunnel to YouTube with our credentials?

    Opens one TCP connection to the proxy from ``_sticky_proxy_url()`` (the same credentials
    and sticky-session form a real fetch uses), sends ``CONNECT www.youtube.com:443`` with
    ``Proxy-Authorization``, reads at most 1 KB of the reply and closes WITHOUT any TLS to
    YouTube. Roughly 0.5-1 KB on the wire. 200 -> ok; 407 -> proxy_auth; any other status,
    a connect/DNS error, a reset, a close or a timeout -> proxy_connect.

    None when no proxy is configured (nothing to check), or for a proxy scheme this cannot
    speak (socks*). Never raises; never returns or logs any part of the URL.
    """
    proxy = proxy_url if proxy_url is not None else _sticky_proxy_url()
    if not proxy:
        return None
    try:
        parts = urlsplit(proxy)
        scheme = (parts.scheme or "http").lower()
        if scheme not in ("http", "https") or not parts.hostname:
            return None
        port = parts.port or (443 if scheme == "https" else 80)
        lines = [f"CONNECT {TUNNEL_TARGET} HTTP/1.1", f"Host: {TUNNEL_TARGET}"]
        if parts.username is not None:
            creds = f"{unquote(parts.username)}:{unquote(parts.password or '')}"
            lines.append("Proxy-Authorization: Basic " + base64.b64encode(creds.encode()).decode())
        request = ("\r\n".join(lines) + "\r\n\r\n").encode()
    except Exception:  # noqa: BLE001 — a malformed PROXY_URL is a connect-class failure
        return CanaryResult(ok=False, cause=PROXY_CONNECT)
    # ONE deadline for the whole probe (QA-65, review R-2): connect, TLS to an https proxy,
    # send and every read. A per-call timeout let a proxy that trickles a byte at a time
    # hold the canary thread for ~1024 x timeout_s.
    deadline = time.monotonic() + timeout_s

    def remaining() -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("proxy tunnel probe deadline")
        return left

    try:
        with socket.create_connection((parts.hostname, port), timeout=remaining()) as raw:
            raw.settimeout(remaining())
            sock = raw
            if scheme == "https":
                sock = ssl.create_default_context().wrap_socket(raw, server_hostname=parts.hostname)
            sock.settimeout(remaining())
            sock.sendall(request)
            buf = b""
            while b"\r\n" not in buf and len(buf) < _TUNNEL_READ_MAX:
                sock.settimeout(remaining())
                chunk = sock.recv(_TUNNEL_READ_MAX - len(buf))
                if not chunk:
                    break
                buf += chunk
    except Exception:  # noqa: BLE001 — refused, DNS, reset, timeout: the proxy is not usable
        return CanaryResult(ok=False, cause=PROXY_CONNECT)
    status = buf.split(b"\r\n", 1)[0].split()
    code = status[1] if len(status) >= 2 and status[0].startswith(b"HTTP/") else b""
    if code == b"200":
        return CanaryResult(ok=True, cause=None)
    if code == b"407":
        return CanaryResult(ok=False, cause=PROXY_AUTH)
    return CanaryResult(ok=False, cause=PROXY_CONNECT)


def fetch_audio_file(youtube_url: str) -> str:
    """Download audio via yt-dlp; return a local .wav path or raise a typed error."""
    # One sticky-session proxy string for this WHOLE attempt (live-check + the actual
    # download) — see _sticky_proxy_url(). A retry (download_audio(), __init__.py)
    # calls this function again, generating a fresh session/IP each time.
    begin_attempt()
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
        # #320: one stdout line per progress-hook call, so the first media byte can be seen
        # while the download runs (see _run_download).
        "--newline",
        "--progress-template",
        f"download:{_PROGRESS_MARK} %(progress.downloaded_bytes)s",
    ]
    cf = _pick_cookie_file()
    if cf:
        cmd += ["--cookies", cf]
    if proxy:
        cmd += ["--proxy", proxy]
    # `--` ends option parsing (QA track B, B-09): the URL can never be read as a flag.
    cmd += ["--", youtube_url]

    deadline = first_byte_deadline_s()
    r = _run_download(cmd, TIMEOUT, deadline)
    if r.first_byte_at is not None:
        _attempt.ms_first_byte = max(0, int((r.first_byte_at - _attempt.t0) * 1000))

    if r.ended == STALLED:
        # No media byte inside the deadline: this exit is dead for media. Cut now and let the
        # retry loop rotate to a fresh exit, instead of waiting out TIMEOUT (#320). With a
        # proxy it is OUR exit that failed us (FETCH_PROXY_FAILED: retried, allowance given
        # back if it is the final error). Direct, there is no exit to blame: DOWNLOAD_TIMEOUT.
        # Nothing from stderr is logged here: a stall says nothing the deadline does not.
        log_structured("WARN", "ytdlp_first_byte_stall", deadline_s=deadline, proxied=bool(proxy))
        if proxy:
            raise FetchProxyFailedError(FIRST_BYTE_STALL)
        raise DownloadTimeoutError("yt-dlp: no first byte", failure_reason=FIRST_BYTE_STALL)
    if r.ended == TIMED_OUT:
        raise DownloadTimeoutError("yt-dlp timed out")

    if r.returncode != 0:
        # Redact BEFORE cutting (QA-65, review R-3): a cut that lands mid-password leaves a
        # fragment no pattern can recognise.
        safe_err = redact_tail(r.stderr or "", 1000)
        log_structured("ERROR", "ytdlp_failed", stderr=safe_err)
        proxy_cause = proxy_failure_cause(r.stderr, _video_id(youtube_url)) if proxy else None
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
