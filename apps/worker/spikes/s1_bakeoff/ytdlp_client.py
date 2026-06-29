"""yt-dlp client with server-managed cookie rotation for the S1 bake-off.

The cookie pool lives ONLY on the server (PRD §8 anti-goal #1: never ask the user
for cookies). Cookie/token material is redacted from any captured stderr before it
leaves this process (PRD §6.1 — no secrets in logs).
"""

import os
import re
import subprocess
import tempfile
import time

COOKIE_DIR = os.environ.get("YTDLP_COOKIE_DIR", "/run/secrets/yt_cookies")
TIMEOUT = 10

_REDACT_RE = re.compile(r"(cookie|token|bearer|session)[=:]\S+", re.IGNORECASE)


def _redact(s: str) -> str:
    return _REDACT_RE.sub(r"\1=[REDACTED]", s)


def _pick_cookie_file() -> str | None:
    """Return a cookie file from the rotation pool, or None if the pool is empty."""
    if not os.path.isdir(COOKIE_DIR):
        return None
    files = sorted(f for f in os.listdir(COOKIE_DIR) if f.endswith(".txt"))
    return os.path.join(COOKIE_DIR, files[0]) if files else None


def fetch_audio_ytdlp(youtube_url: str) -> dict:
    """Download audio via yt-dlp. Returns {success, path, latency_ms, error}. Never raises."""
    t0 = time.time()
    cookie_file = _pick_cookie_file()
    with tempfile.TemporaryDirectory() as tmpdir:
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "-x",
            "--audio-format",
            "wav",
            "-o",
            f"{tmpdir}/audio.%(ext)s",
            "--print",
            "after_move:filepath",
        ]
        if cookie_file:
            cmd += ["--cookies", cookie_file]
        cmd += [youtube_url]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
            latency_ms = int((time.time() - t0) * 1000)
            if result.returncode == 0:
                return {
                    "success": True,
                    "path": result.stdout.strip(),
                    "latency_ms": latency_ms,
                    "error": None,
                }
            return {
                "success": False,
                "path": None,
                "latency_ms": latency_ms,
                "error": _redact(result.stderr[-500:]),
            }
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "path": None,
                "latency_ms": TIMEOUT * 1000,
                "error": "timeout",
            }
        except FileNotFoundError:
            return {
                "success": False,
                "path": None,
                "latency_ms": int((time.time() - t0) * 1000),
                "error": "yt-dlp binary not installed",
            }
        except Exception as e:  # noqa: BLE001 — spike: capture any failure as a measured error
            return {
                "success": False,
                "path": None,
                "latency_ms": int((time.time() - t0) * 1000),
                "error": _redact(str(e)),
            }


if __name__ == "__main__":
    import json
    import sys

    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    r = fetch_audio_ytdlp(url)
    print(json.dumps({"success": r["success"], "latency_ms": r["latency_ms"], "error": r["error"]}))
