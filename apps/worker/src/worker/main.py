"""
Worker entrypoint — queue consumer + /health HTTP server.
Phase 1 stub: starts server and poll loop.
Real pipeline wired in Phase 2 (T11-T17).
"""
import asyncio
import os
import sys

import uvicorn

from .health import app


async def run_consumer():
    """Queue consumer poll loop — stub until Phase 2."""
    print("[worker] Consumer poll loop started (stub — Phase 2 wires real pipeline)")
    while True:
        # Phase 1: no-op poll; Phase 2: replace with real queue consumer
        await asyncio.sleep(2)


async def main():
    if "--test-job" in sys.argv:
        idx = sys.argv.index("--test-job")
        url = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else ""
        print(f"[worker] test-job mode: {url}")
        print("[worker] Phase 2 will wire real pipeline here")
        return

    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)
    await asyncio.gather(server.serve(), run_consumer())


if __name__ == "__main__":
    asyncio.run(main())
