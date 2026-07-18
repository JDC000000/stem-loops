"""Worker entrypoint — /health HTTP server + queue consumer poll loop.

Run modes:
  python -m worker.main                      # serve /health + run the consumer
  python -m worker.main --test-job <url>     # run one job directly (no queue)

The consumer claims jobs via FOR UPDATE SKIP LOCKED (Gate 0 S2 decision) so the
worker is stateless and horizontally scalable (PRD §8 anti-goal #5). It also reaps
jobs orphaned by a crashed/restarted worker at startup and periodically (reaper.py).
The /health server has no Fly check pointed at it (see fly.toml) — liveness is
restart-on-exit + the reaper — so it stays purely for manual probes.
"""

import asyncio
import os
import sys

import sentry_sdk
import uvicorn

from .consumer import poll_loop
from .health import app

# No-op until SENTRY_DSN is set (Fly secret) — safe to ship before the Sentry project
# exists. This is a low-volume portfolio worker, not a high-QPS service, so a modest
# fixed trace sample rate has no real cost/noise tradeoff either way.
if os.environ.get("SENTRY_DSN"):
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.environ.get("FLY_APP_NAME", "production"),
        traces_sample_rate=0.2,
    )


async def serve() -> None:
    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)
    await asyncio.gather(server.serve(), poll_loop())


async def _run() -> None:
    if "--test-job" in sys.argv:
        from .cli import test_job

        idx = sys.argv.index("--test-job")
        url = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else ""
        if not url:
            print("Usage: python -m worker.main --test-job <youtube_url>")
            raise SystemExit(1)
        await test_job(url)
        return
    await serve()


if __name__ == "__main__":
    asyncio.run(_run())
