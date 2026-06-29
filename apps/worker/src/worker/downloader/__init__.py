"""Dual-path YouTube downloader (T12) with SSRF allowlist.

Cobalt primary → yt-dlp fallback (Gate 0 S1 architecture decision). The SSRF
guard validates the host against a YouTube allowlist before any outbound call
(P1-29/P2-8). NOT wired into the live pipeline until the S1 bake-off passes.
"""

import re

from ..errors import DownloadInvalidUrlError
from ..logger import log_structured
from . import cobalt_client, ytdlp_client

_ALLOWED = re.compile(r"^https?://(www\.|m\.)?(youtube\.com|youtu\.be)(/|$)", re.IGNORECASE)


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
    path = ytdlp_client.fetch_audio_file(youtube_url)
    return path, "ytdlp"
