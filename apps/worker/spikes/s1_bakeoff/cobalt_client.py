"""Cobalt HTTP client for the S1 bake-off (Cobalt API v10).

Measures success rate and latency of the self-hosted Cobalt instance against a
sample of YouTube URLs. Server-side only — Cobalt sidesteps user cookies,
satisfying PRD §8 anti-goal #1 (never ask the user for cookies/secrets).

Cobalt v10 API (https://github.com/imputnet/cobalt/blob/main/docs/api.md):
  POST /  (the base URL, NOT /api/json — that was v7-v9)
  headers: Accept: application/json, Content-Type: application/json
           [Authorization: Api-Key <key>]   # only if the instance requires auth
  body:    {"url": "...", "downloadMode": "audio", "audioFormat": "wav"}
  resp.status: tunnel|redirect|picker -> success (.url / .picker)
               error                  -> failure (.error.code)
"""

import os
import time

import httpx

COBALT_URL = os.environ.get("COBALT_URL", "https://stem-loops-cobalt-spike.fly.dev")
COBALT_API_KEY = os.environ.get("COBALT_API_KEY")  # optional; only if instance enforces auth
TIMEOUT = 10.0

_SUCCESS_STATUSES = ("tunnel", "redirect", "stream", "picker", "success")


def fetch_audio_cobalt(youtube_url: str) -> dict:
    """Resolve an audio stream URL via Cobalt v10.

    Returns {success, url, latency_ms, error}. Never raises.
    """
    t0 = time.time()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if COBALT_API_KEY:
        headers["Authorization"] = f"Api-Key {COBALT_API_KEY}"
    try:
        r = httpx.post(
            COBALT_URL.rstrip("/") + "/",
            json={"url": youtube_url, "downloadMode": "audio", "audioFormat": "wav"},
            headers=headers,
            timeout=TIMEOUT,
        )
        latency_ms = int((time.time() - t0) * 1000)
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        status = data.get("status")
        if r.status_code < 400 and status in _SUCCESS_STATUSES:
            return {
                "success": True,
                "url": data.get("url") or (data.get("picker") or [{}])[0].get("url"),
                "latency_ms": latency_ms,
                "error": None,
            }
        # v10 surfaces the reason under error.code; older builds under text/status
        err = (data.get("error") or {}).get("code") if isinstance(data.get("error"), dict) else None
        return {
            "success": False,
            "url": None,
            "latency_ms": latency_ms,
            "error": err or data.get("text") or status or f"http_{r.status_code}",
        }
    except Exception as e:  # noqa: BLE001 — spike: capture any failure as a measured error
        return {
            "success": False,
            "url": None,
            "latency_ms": int((time.time() - t0) * 1000),
            "error": str(e),
        }


if __name__ == "__main__":
    import json
    import sys

    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    print(json.dumps(fetch_audio_cobalt(url)))
