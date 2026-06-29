"""yt-dlp fallback client (T12) — server-managed cookies, never user-exposed.

Captured stderr is passed through redact_secrets() before it is logged, so no
cookie/token material can leak (PRD §6.1). NOT wired into the live pipeline until
the S1 bake-off passes.
"""

import os
import subprocess
import tempfile

from ..errors import (
    DownloadAgeRestrictedError,
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadPrivateError,
    DownloadTimeoutError,
)
from ..logger import log_structured, redact_secrets

COOKIE_DIR = os.environ.get("YTDLP_COOKIE_DIR", "")
TIMEOUT = 10

_STDERR_MAP = [
    ("age", DownloadAgeRestrictedError),
    ("private", DownloadPrivateError),
    ("not available", DownloadBlockedError),
    ("invalid url", DownloadInvalidUrlError),
]


def _pick_cookie_file() -> str | None:
    if not COOKIE_DIR or not os.path.isdir(COOKIE_DIR):
        return None
    files = sorted(f for f in os.listdir(COOKIE_DIR) if f.endswith(".txt"))
    return os.path.join(COOKIE_DIR, files[0]) if files else None


def fetch_audio_file(youtube_url: str) -> str:
    """Download audio via yt-dlp; return a local .wav path or raise a typed error."""
    tmpdir = tempfile.mkdtemp(prefix="sl_ytdlp_")
    cmd = [
        "yt-dlp",
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
    cmd.append(youtube_url)

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired as e:
        raise DownloadTimeoutError("yt-dlp timed out") from e

    if r.returncode != 0:
        safe_err = redact_secrets((r.stderr or "")[-1000:])
        log_structured("ERROR", "ytdlp_failed", stderr=safe_err)
        lower = (r.stderr or "").lower()
        for kw, exc_cls in _STDERR_MAP:
            if kw in lower:
                raise exc_cls(f"yt-dlp: {kw}")
        raise DownloadBlockedError("yt-dlp download failed")

    for f in os.listdir(tmpdir):
        if f.endswith(".wav"):
            return os.path.join(tmpdir, f)
    raise DownloadBlockedError("yt-dlp produced no output")
