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

``fetch_canary`` (QA-61) is the last result of the proxy/YouTube canary thread
(fetch_canary.py), read from memory: ``enabled``, an overall ``ok`` / ``last_checked`` /
``cause``, and the two checks separately: ``proxy`` (the ~1 KB CONNECT check, every 15 min)
and ``youtube`` (the yt-dlp metadata check, every 12 h), each ``{ok, last_checked, cause}``.
``ok`` is null before a check has run; ``cause`` is proxy_auth / proxy_connect /
youtube_bot_check / other, or null. Never a URL, a credential or yt-dlp output.
"""

import sentry_sdk
from fastapi import FastAPI

from .fetch_canary import canary_state

app = FastAPI(title="stem-loops-worker")


def sentry_state() -> str:
    """``"on"`` only if ``sentry_sdk.init()`` ran AND left a client CONFIGURED to send.

    Configured, not proven: a syntactically valid DSN pointing at an unreachable
    host still reports "on". This answers "did Sentry initialise", which is the
    question nobody could answer without the Fly dashboard — not "did an event
    arrive", which no liveness probe can answer without the network.

    Read from the SDK, not from ``os.environ["SENTRY_DSN"]``: a set-but-unusable
    env var must not report "on".

    ``transport is not None`` is the half that does the work on sentry-sdk 2.x
    (pinned 2.68.1, floor 2.66.0). A client built by ``init()`` with no usable DSN
    is still ``is_active()`` — it has ``transport is None`` and silently drops
    every event — so a bare ``is_active()`` check would report "on" for a worker
    that reports nothing.

    ``is_active()`` is DEFENSIVE and redundant on 2.66-2.75: the only client whose
    ``is_active()`` is ``False`` is ``NonRecordingClient`` (what ``get_client()``
    returns when ``init()`` never ran), and that client also has no transport. A
    mutant dropping it survives today; `tests/mutation/manifest.py` records that as
    an expected survivor, so if a future SDK makes it meaningful the runner says so.
    Keep it: it is the SDK's own documented "can this client record" predicate.

    ``transport`` is assigned in ``BaseClient.__init__`` (sentry_sdk/client.py:422),
    so it is present on every client kind and this cannot raise.
    """
    client = sentry_sdk.get_client()
    return "on" if client.is_active() and client.transport is not None else "off"


@app.get("/health")
async def health():
    # `fetch_canary` (QA-61): {"enabled", "ok", "last_checked", "cause", "proxy", "youtube"}
    # from the proxy/YouTube canary. Informational only: the status stays "ok" and the
    # response 200 whatever it says, so a dead proxy never makes anything restart the worker.
    # No secret is in it.
    return {"status": "ok", "sentry": sentry_state(), "fetch_canary": canary_state()}
