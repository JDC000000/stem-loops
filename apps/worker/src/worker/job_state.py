"""Job liveness (heartbeat) + write fencing — shared by pipeline/consumer/reaper.

Hardening review H1. Two halves of the same race:

  * LIVENESS. The reaper decides a worker is dead purely from `jobs.updated_at`,
    but only the separating stage bumped it repeatedly (replicate_client every
    ~20s). downloading/extracting/uploading bumped it once on stage entry and
    then went quiet for the whole stage, so a slow-but-healthy job could cross
    the 300s stale window and be re-queued underneath its still-running worker.
    `Heartbeat` gives the CPU-bound stages the same steady liveness signal.

  * FENCING. Once a job HAS been reaped and re-claimed there are two workers on
    one row, and no terminal write was guarded — the loser could overwrite the
    winner's state (e.g. stamp 'failed' over a 'done'). `jobs.attempts` is
    already the reaper's re-queue counter, so it works as a fencing token with
    no new column: every worker remembers the attempts value it started with and
    scopes its writes to `AND attempts=%s`. A superseded worker's writes then
    affect 0 rows instead of clobbering newer state.

A superseded worker also stops as soon as it notices (JobSupersededError), so it
does not keep burning CPU, R2 writes and Replicate polls on a job it has lost.
"""

from __future__ import annotations

import os
import threading
import time

import psycopg

from .errors import JobSupersededError
from .logger import log_structured

# Heartbeat cadence. Must stay well under REAPER_STALE_SECONDS (default 300s);
# matches the separation heartbeat so every stage looks alike to the reaper.
HEARTBEAT_SECONDS = int(os.environ.get("JOB_HEARTBEAT_SECONDS", "20"))


def _db():
    return psycopg.connect(os.environ.get("DATABASE_URL", ""))


def heartbeat(job_id: str, attempt: int | None = None) -> bool:
    """Bump jobs.updated_at so the reaper can see this worker is alive.

    Returns False when the write matched no row — i.e. this worker has been
    superseded (the reaper re-queued the job and `attempts` moved on) or the row
    is gone (retention sweep). Best-effort: a DB blip logs and reports alive,
    because a transient connection error is not evidence the job was taken away.
    """
    try:
        with _db() as conn:
            if attempt is None:
                cur = conn.execute("UPDATE jobs SET updated_at=now() WHERE id=%s", (job_id,))
            else:
                cur = conn.execute(
                    "UPDATE jobs SET updated_at=now() WHERE id=%s AND attempts=%s",
                    (job_id, attempt),
                )
            conn.commit()
            return cur.rowcount > 0
    except Exception as exc:  # noqa: BLE001 — a heartbeat blip must never fail a job
        log_structured("WARN", "heartbeat_failed", job_id=job_id, error=str(exc)[:120])
        return True


class Heartbeat:
    """Throttled, thread-safe heartbeat for a long-running stage.

    `beat()` is designed to be called freely at natural checkpoints (per loop,
    per stem); it only touches the DB once per `interval`. It is called from the
    encode/upload thread pool, hence the lock.
    """

    def __init__(self, job_id: str, attempt: int | None = None, interval: int | None = None):
        self.job_id = job_id
        self.attempt = attempt
        self.interval = HEARTBEAT_SECONDS if interval is None else interval
        self._lock = threading.Lock()
        self._last = time.monotonic()

    def beat(self, force: bool = False) -> None:
        """Heartbeat if the interval has elapsed. Raises JobSupersededError if this
        worker no longer owns the job, so the caller unwinds instead of racing on."""
        with self._lock:
            now = time.monotonic()
            if not force and now - self._last < self.interval:
                return
            self._last = now
        if not heartbeat(self.job_id, self.attempt):
            raise JobSupersededError(
                f"job {self.job_id} is no longer owned by attempt {self.attempt}"
            )
