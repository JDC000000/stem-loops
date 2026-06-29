"""Cobalt HTTP client — primary YouTube audio download path (T12).

Server-side only; Cobalt sidesteps cookies entirely (PRD §8 anti-goal #1).
Maps Cobalt failure modes to the typed error taxonomy. NOT wired into the live
pipeline until the S1 bake-off passes (>=95% / 50 URLs).
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
TIMEOUT = 10.0

_ERROR_MAP = {
    "age": DownloadAgeRestrictedError,
    "private": DownloadPrivateError,
    "unavailable": DownloadBlockedError,
    "invalid": DownloadInvalidUrlError,
}


def fetch_audio_url(youtube_url: str) -> str:
    """Return a direct audio stream URL from Cobalt, or raise a typed error."""
    try:
        resp = httpx.post(
            f"{COBALT_URL}/api/json",
            json={"url": youtube_url, "isAudioOnly": True, "aFormat": "wav"},
            headers={"Accept": "application/json"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
    except httpx.TimeoutException as e:
        raise DownloadTimeoutError("Cobalt timed out") from e
    except httpx.HTTPStatusError as e:
        raise DownloadBlockedError(f"Cobalt HTTP {e.response.status_code}") from e

    data = resp.json()
    status = data.get("status", "")
    if status in ("stream", "redirect", "tunnel", "success"):
        return data["url"]

    text = (data.get("text") or "").lower()
    for keyword, exc_cls in _ERROR_MAP.items():
        if keyword in text:
            raise exc_cls(f"Cobalt: {text}")
    raise DownloadBlockedError(f"Cobalt unexpected status: {status}")
