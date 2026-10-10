"""Per-job scratch directories that are always removed.

Retention promise: no user audio stays on the worker's disk past the job. Every temp dir a
job creates (uploaded source, decoded WAV, downloaded stems, encoded loops, yt-dlp output)
comes from `mkdtemp()` here and is registered with the active `job_scope()`, which
`shutil.rmtree`s them all when the job ends — success, failure or crash-exception. Dirs live
under one dedicated root so `sweep_stale()` (run at worker start and with each retention
sweep) can safely remove leftovers from a hard crash/OOM without touching anything else.

The scope is a ContextVar, so it follows `asyncio.to_thread` into worker threads.
"""

from __future__ import annotations

import contextlib
import contextvars
import os
import shutil
import tempfile
import time

from .logger import log_structured

WORK_ROOT = os.environ.get("WORKER_TMP_ROOT") or os.path.join(
    tempfile.gettempdir(), "stemloops-work"
)
# Leftover dirs older than this are removed by sweep_stale (matches the retention window).
STALE_AFTER_SECONDS = int(os.environ.get("TMP_STALE_SECONDS", "86400"))

_scope: contextvars.ContextVar[list[str] | None] = contextvars.ContextVar(
    "job_tmpdirs", default=None
)


def mkdtemp(prefix: str = "sl_") -> str:
    """Create a scratch dir under WORK_ROOT, registered for cleanup if a job_scope is active."""
    os.makedirs(WORK_ROOT, exist_ok=True)
    path = tempfile.mkdtemp(prefix=prefix, dir=WORK_ROOT)
    dirs = _scope.get()
    if dirs is not None:
        dirs.append(path)
    return path


@contextlib.contextmanager
def job_scope():
    """Remove every mkdtemp() dir created inside this block (incl. threads it spawns)."""
    dirs: list[str] = []
    token = _scope.set(dirs)
    try:
        yield dirs
    finally:
        _scope.reset(token)
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)


def sweep_stale(max_age_seconds: int | None = None) -> int:
    """Delete WORK_ROOT entries last modified more than max_age_seconds ago. Returns count."""
    age = STALE_AFTER_SECONDS if max_age_seconds is None else max_age_seconds
    if not os.path.isdir(WORK_ROOT):
        return 0
    cutoff = time.time() - age
    removed = 0
    for name in os.listdir(WORK_ROOT):
        path = os.path.join(WORK_ROOT, name)
        try:
            if os.path.getmtime(path) < cutoff:
                shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)
                removed += 1
        except OSError:
            continue
    if removed:
        log_structured("INFO", "tmp_swept", removed=removed)
    return removed
