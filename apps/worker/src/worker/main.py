"""Worker entrypoint — /health HTTP server + queue consumer poll loop.

Run modes:
  python -m worker.main                      # serve /health + run the consumer
  python -m worker.main --test-job <url>     # run one job directly (no queue)

The consumer claims jobs via FOR UPDATE SKIP LOCKED (Gate 0 S2 decision) so the
worker is stateless and horizontally scalable (PRD §8 anti-goal #5). It also reaps
jobs orphaned by a crashed/restarted worker at startup and periodically (reaper.py).
The /health server has no Fly check pointed at it (see fly.toml) — liveness is
restart-on-exit + the reaper — so it stays purely for manual probes.

SHUTDOWN (QA-63, shutdown.py). SIGINT and SIGTERM DRAIN the worker: stop claiming, let the
job in hand finish inside the drain budget (or release it back to 'queued'), stop /health,
exit 0. uvicorn's own signal capture is switched off (_Server) because it re-raises the
signal after its shutdown, which is the KeyboardInterrupt that killed jobs mid-upload.
"""

import asyncio
import contextlib
import os
import signal
import sys

import sentry_sdk
import uvicorn

from .consumer import poll_loop
from .health import app
from .logger import log_structured
from .sentry_config import sentry_options
from .shutdown import drain

# No-op until SENTRY_DSN is set (Fly secret). Tracing off and events scrubbed; see
# sentry_config.py (security review 2026-10-03).
if os.environ.get("SENTRY_DSN"):
    sentry_sdk.init(**sentry_options())


# Signals the worker drains on. Fly sends fly.toml's `kill_signal` (set to SIGTERM there);
# SIGINT is Fly's documented default on some paths and what Ctrl+C sends locally. Both drain.
DRAIN_SIGNALS = (signal.SIGINT, signal.SIGTERM)
# How long the stopped /health server may take to close once the consumer has drained.
HTTP_SHUTDOWN_TIMEOUT_S = 5.0


class _Server(uvicorn.Server):
    """uvicorn WITHOUT its signal capture (QA-63).

    `uvicorn.Server.serve()` wraps itself in `capture_signals()`, which installs handlers for
    SIGINT/SIGTERM, shuts the server down on one, and then RE-RAISES the captured signal once
    serve() returns -- a KeyboardInterrupt (SIGINT) or a default-action death (SIGTERM) in
    the middle of whatever job the consumer was running. The worker owns its signals instead
    (`_install_drain_handlers`); this server is stopped by `should_exit`, set after the drain.
    tests/test_worker_drain.py fails if uvicorn stops routing serve() through this hook.
    """

    @contextlib.contextmanager
    def capture_signals(self):
        yield


def _install_drain_handlers(loop: asyncio.AbstractEventLoop) -> None:
    for sig in DRAIN_SIGNALS:
        loop.add_signal_handler(sig, drain.request, sig.name)


def _exit_drained() -> None:
    """Exit 0 NOW. `os._exit`, not a return: asyncio.run's teardown joins the default
    executor, and a pipeline thread orphaned by a released job (it cannot be cancelled) would
    hold the process open until Fly's SIGKILL. The job is already back in the queue, so
    nothing in flight is lost by not waiting; Sentry and stdio are flushed first."""
    log_structured("INFO", "worker_exit_drained", signal=drain.signal_name, exit_code=0)
    with contextlib.suppress(Exception):
        sentry_sdk.flush(timeout=2)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


async def serve() -> None:
    _install_drain_handlers(asyncio.get_running_loop())
    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = _Server(config)
    http = asyncio.create_task(server.serve())
    poll = asyncio.create_task(poll_loop())
    done, _ = await asyncio.wait({http, poll}, return_when=asyncio.FIRST_COMPLETED)
    if poll not in done:
        # /health ended on its own (e.g. the port could not be bound): fail the process as the
        # old asyncio.gather did, so Fly restarts it, rather than run on without it.
        poll.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poll
        http.result()
        raise RuntimeError("health server stopped unexpectedly")
    poll.result()  # poll_loop only returns after a drain; re-raise anything else
    server.should_exit = True
    try:
        await asyncio.wait_for(http, timeout=HTTP_SHUTDOWN_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 — exiting regardless
        log_structured("WARN", "health_shutdown_error", error=str(e)[:200])
    _exit_drained()


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
