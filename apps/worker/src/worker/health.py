"""
Minimal /health LIVENESS probe (manual/debug only).

The Fly worker no longer runs an HTTP health *check* (see apps/worker/fly.toml):
CPU-bound loop extraction holds the CPython GIL and starves this co-located
asyncio server, so any Fly check timed out mid-job and SIGTERM'd a healthy-but-busy
worker, orphaning the job. Liveness is now handled by Fly's restart-on-exit (a
crashed/OOM'd worker exits → Fly restarts it) plus the orphan reaper (reaper.py),
which re-queues whatever job the dead worker abandoned. This endpoint remains only
for manual probing / local Docker HEALTHCHECK. Liveness ≠ DB readiness.
"""

from fastapi import FastAPI

app = FastAPI(title="stem-loops-worker")


@app.get("/health")
async def health():
    return {"status": "ok"}
