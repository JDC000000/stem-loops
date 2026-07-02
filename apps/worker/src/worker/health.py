"""
Minimal /health LIVENESS probe.

Deliberately cheap and non-blocking: Fly kills a machine whose health check
fails, and the worker runs CPU-heavy loop extraction in the same process, so a
blocking DB round-trip here (as before) starved the event loop and got the
machine SIGTERM'd mid-extraction. Liveness ≠ DB readiness — DB connectivity is
verified elsewhere. A deeper /ready check can be added in Phase 4 (T32).
"""

from fastapi import FastAPI

app = FastAPI(title="stem-loops-worker")


@app.get("/health")
async def health():
    return {"status": "ok"}
