"""
Minimal /health endpoint — available from Phase 1.
Returns DB connectivity status. Cobalt health added in Phase 4 T32.
"""

import os

import psycopg
from fastapi import FastAPI

app = FastAPI(title="stem-loops-worker")


@app.get("/health")
async def health():
    db_ok = False
    try:
        with psycopg.connect(os.environ.get("DATABASE_URL", ""), connect_timeout=2) as conn:
            conn.execute("SELECT 1")
            db_ok = True
    except Exception:
        pass
    return {
        "status": "ok" if db_ok else "degraded",
        "db": db_ok,
    }
