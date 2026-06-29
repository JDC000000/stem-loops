"""Worker entrypoint — /health HTTP server + queue consumer poll loop.

Run modes:
  python -m worker.main                      # serve /health + run the consumer
  python -m worker.main --test-job <url>     # run one job directly (no queue)

The consumer claims jobs via FOR UPDATE SKIP LOCKED (Gate 0 S2 decision) so the
worker is stateless and horizontally scalable (PRD §8 anti-goal #5).
"""

import asyncio
import sys

import uvicorn

from .consumer import poll_loop
from .health import app


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
