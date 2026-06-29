"""Cobalt HTTP client for the S1 bake-off.

Measures success rate and latency of the self-hosted Cobalt instance against a
sample of YouTube URLs. Server-side only — Cobalt sidesteps cookies entirely,
satisfying PRD §8 anti-goal #1 (never ask the user for cookies/secrets).
"""

import os
import time

import httpx

COBALT_URL = os.environ.get("COBALT_URL", "https://stem-loops-cobalt-spike.fly.dev")
TIMEOUT = 10.0


def fetch_audio_cobalt(youtube_url: str) -> dict:
    """Resolve an audio stream URL via Cobalt.

    Returns {success, url, latency_ms, error}. Never raises.
    """
    t0 = time.time()
    try:
        r = httpx.post(
            f"{COBALT_URL}/api/json",
            json={"url": youtube_url, "isAudioOnly": True, "audioFormat": "wav"},
            headers={"Accept": "application/json"},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        latency_ms = int((time.time() - t0) * 1000)
        if data.get("status") in ("redirect", "stream", "tunnel", "success"):
            return {
                "success": True,
                "url": data.get("url"),
                "latency_ms": latency_ms,
                "error": None,
            }
        return {
            "success": False,
            "url": None,
            "latency_ms": latency_ms,
            "error": data.get("text") or data.get("status") or "unknown",
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
