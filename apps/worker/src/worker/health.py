"""
Minimal /health LIVENESS probe (manual/debug only).

The Fly worker no longer runs an HTTP health *check* (see apps/worker/fly.toml):
CPU-bound loop extraction holds the CPython GIL and starves this co-located
asyncio server, so any Fly check timed out mid-job and SIGTERM'd a healthy-but-busy
worker, orphaning the job. Liveness is now handled by Fly's restart-on-exit (a
crashed/OOM'd worker exits → Fly restarts it) plus the orphan reaper (reaper.py),
which re-queues whatever job the dead worker abandoned. This endpoint remains only
for manual probing / local Docker HEALTHCHECK. Liveness ≠ DB readiness.

It also reports whether Sentry initialised (``"sentry": "on" | "off"``). Nobody
could answer that without opening the Fly dashboard, because main.py's
``if os.environ.get("SENTRY_DSN"): sentry_sdk.init(...)`` logs nothing either
way. The DSN itself is a credential and is NEVER in the response — on/off only.
Still cheap and dependency-free: no DB, no network, just the SDK's in-process state.
"""

import sentry_sdk
from fastapi import FastAPI

app = FastAPI(title="stem-loops-worker")


def sentry_state() -> str:
    """``"on"`` only if ``sentry_sdk.init()`` ran AND produced a client that can send.

    Read from the SDK, not from ``os.environ["SENTRY_DSN"]``: a set-but-unusable
    env var must not report "on", because the whole point of the field is to tell
    us whether events actually reach Sentry.

    Both halves are load-bearing on sentry-sdk 2.x (pinned 2.68.1, floor 2.66.0):

    * ``get_client()`` returns a ``NonRecordingClient`` when ``init()`` never ran;
      its ``is_active()`` is ``False``.
    * ``is_active()`` alone is NOT enough — a client built by ``init()`` with no
      usable DSN is still "active" but has ``transport is None`` and silently
      drops every event. ``transport`` is ``None`` on ``BaseClient``, so the
      attribute is present on both client kinds and this never raises.
    """
    client = sentry_sdk.get_client()
    return "on" if client.is_active() and client.transport is not None else "off"


@app.get("/health")
async def health():
    return {"status": "ok", "sentry": sentry_state()}
