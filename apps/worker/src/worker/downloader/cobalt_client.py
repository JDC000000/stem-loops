"""Cobalt HTTP client — primary YouTube audio download path (T12).

Server-side only; Cobalt sidesteps cookies entirely (PRD §8 anti-goal #1).
Maps Cobalt failure modes to the typed error taxonomy.

API VERSION (2026-08-30): this speaks the **Cobalt v10** API —
``POST /`` with ``{"url", "downloadMode": "audio", "audioFormat"}``.

It previously spoke the v7-v9 API (``POST /api/json`` with ``isAudioOnly`` /
``aFormat``). That endpoint DOES NOT EXIST on the v10 image we self-host
(``ghcr.io/imputnet/cobalt:10``) — it answers ``404 Cannot POST /api/json``.
Verified against the live instance: ``/api/json`` -> HTTP 404, ``POST /`` ->
``{"status":"tunnel","url":...}`` returning a valid 37MB RIFF/WAVE. With the
old shape every call raised DownloadBlockedError("Cobalt HTTP 404"), so EVERY
job silently fell through to the yt-dlp fallback on our datacenter IP, which
YouTube near-100% blocks -> DOWNLOAD_BLOCKED. See spikes/s1_bakeoff/RUN.md §
"cobalt_client.py uses the Cobalt v10 API".
"""

import os

import httpx

from ..errors import (
    DownloadAgeRestrictedError,
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadPrivateError,
    DownloadTimeoutError,
)

COBALT_URL = os.environ.get("COBALT_URL", "https://stem-loops-cobalt.fly.dev")
COBALT_API_KEY = os.environ.get("COBALT_API_KEY")  # only if the instance enforces auth

# 30s, NOT 10s. The Fly app runs scale-to-zero (min_machines_running = 0), so the
# first call after an idle period pays a cold start: ~4s machine boot + ~3s for the
# Cobalt node process to come up + ~1-2s to resolve = ~9s, which a 10s budget clips
# right at the edge. A clipped call raises DownloadTimeoutError and falls through to
# the yt-dlp path that this client exists to avoid, so the timeout must sit well clear
# of the cold-start floor. Warm calls return in ~1-2s and are unaffected.
TIMEOUT = float(os.environ.get("COBALT_TIMEOUT", "30"))

# Cobalt can hand back a signed tunnel URL that streams NOTHING. Its stream/internal.js
# HEADs the upstream googlevideo URL and, on a non-200 or missing content-length, calls
# cleanup() -> res.end() — terminating our request with "200 OK, content-length: 0" and
# no error status. Measured 2026-08-30 against 12 popular videos: 10 resolved
# status="tunnel" and then streamed 0 bytes, because googlevideo answers the media
# request with 403 (YouTube's SABR/proof-of-origin enforcement). That is IP-INDEPENDENT
# — the identical 10 fail from a Fly datacenter IP and from an iproyal residential exit,
# which is what rules out IP reputation as the cause.
#
# Without this probe, that failure is SILENT and strictly worse than an honest error:
# fetch_audio_url returns a URL, no typed error is raised, the yt-dlp fallback in
# downloader/__init__.py never fires, and the job dies much later on an empty file with
# an unrelated-looking error. So: read a few bytes before declaring success, and turn an
# empty tunnel into DownloadBlockedError.
#
# Verified safe: the probe does NOT consume the tunnel (a full GET after an 8KB probe
# still returned all 37,589,168 bytes), and it IS discriminating (8192 bytes on a good
# video vs 0 on a failing one). Set COBALT_VERIFY_BYTES=0 to disable.
VERIFY_BYTES = int(os.environ.get("COBALT_VERIFY_BYTES", "8192"))

_SUCCESS_STATUSES = ("tunnel", "redirect", "stream", "picker", "success")

# Substring match against the v10 `error.code` string (e.g.
# "error.api.content.video.age" / ".private" / ".unavailable", "error.api.link.invalid",
# "error.api.youtube.login" = sign-in-gated, i.e. age/consent walled).
_ERROR_MAP = {
    "age": DownloadAgeRestrictedError,
    "login": DownloadAgeRestrictedError,
    "private": DownloadPrivateError,
    "unavailable": DownloadBlockedError,
    "invalid": DownloadInvalidUrlError,
}


def _verify_stream(url: str) -> None:
    """Raise DownloadBlockedError unless `url` actually streams audio bytes."""
    if VERIFY_BYTES <= 0:
        return
    try:
        with httpx.stream("GET", url, timeout=TIMEOUT, follow_redirects=True) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_bytes(chunk_size=VERIFY_BYTES):
                if chunk:
                    return
    except httpx.HTTPStatusError as e:
        raise DownloadBlockedError(f"Cobalt tunnel HTTP {e.response.status_code}") from e
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        raise DownloadBlockedError(f"Cobalt tunnel unreadable: {e}") from e
    raise DownloadBlockedError(
        "Cobalt returned an empty tunnel (0 bytes) — upstream media fetch was refused"
    )


def fetch_audio_url(youtube_url: str) -> str:
    """Return a direct audio stream URL from Cobalt, or raise a typed error."""
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if COBALT_API_KEY:
        headers["Authorization"] = f"Api-Key {COBALT_API_KEY}"
    try:
        resp = httpx.post(
            COBALT_URL.rstrip("/") + "/",
            json={"url": youtube_url, "downloadMode": "audio", "audioFormat": "wav"},
            headers=headers,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
    except httpx.TimeoutException as e:
        raise DownloadTimeoutError("Cobalt timed out") from e
    except httpx.HTTPStatusError as e:
        raise DownloadBlockedError(f"Cobalt HTTP {e.response.status_code}") from e
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        # DNS / connection failures (the instance not being deployed at all) must not
        # escape as a bare httpx error — keep the taxonomy closed. httpx.InvalidURL is
        # deliberately included: it does NOT subclass httpx.HTTPError, so a malformed
        # operator-set COBALT_URL (no scheme, stray whitespace) would otherwise escape.
        raise DownloadBlockedError(f"Cobalt unreachable: {e}") from e

    # A 2xx does NOT guarantee JSON: a Fly edge error page mid-deploy, an empty body,
    # or a literal "null" would otherwise escape as JSONDecodeError/AttributeError and
    # break this module's "every failure is a typed Download*Error" contract.
    try:
        data = resp.json()
    except ValueError as e:
        raise DownloadBlockedError(
            f"Cobalt returned non-JSON ({resp.headers.get('content-type', '?')})"
        ) from e
    if not isinstance(data, dict):
        raise DownloadBlockedError(f"Cobalt returned {type(data).__name__}, expected object")

    status = data.get("status", "")
    if status in _SUCCESS_STATUSES:
        url = data.get("url")
        if not url:
            # picker entries are attacker/upstream-shaped; never index blindly.
            for item in data.get("picker") or []:
                if isinstance(item, dict) and item.get("url"):
                    url = item["url"]
                    break
        if isinstance(url, str) and url:
            _verify_stream(url)
            return url
        raise DownloadBlockedError(f"Cobalt {status} with no url")

    # v10 reports the reason as {"error": {"code": "..."}}; older builds used "text".
    err = data.get("error")
    code = err.get("code") if isinstance(err, dict) else None
    raw = code or data.get("text") or ""
    text = (raw if isinstance(raw, str) else str(raw)).lower()
    for keyword, exc_cls in _ERROR_MAP.items():
        if keyword in text:
            raise exc_cls(f"Cobalt: {text}")
    raise DownloadBlockedError(f"Cobalt unexpected status: {status} {text}".strip())
