"""reaper.reap_stale_jobs against real Postgres: bounded retries, exponential backoff, and the
statuses it must never touch.

Mutation sweep 2026-11-12 (W6): no test in the worker suite called reap_stale_jobs() (the
consumer tests monkeypatch it away), so all of these mutants passed the whole suite:
  - fail branch `attempts >= MAX` -> `attempts > MAX`  (a poison job is never failed: it sits
    in a non-terminal status forever and counts against the web's in-flight cap)
  - backoff `power(FACTOR, attempts)` -> `power(FACTOR, 0)` (no backoff between retries)
  - `_NON_TERMINAL` gains 'queued'  (the reaper fails or re-queues jobs that are only waiting,
    e.g. behind an engaged spend brake)
  - default REAPER_MAX_ATTEMPTS "2" -> "5" (5 re-runs of a poison job instead of 2; each re-run
    can re-download, re-separate and re-bill Klangio)

Each test inserts its own rows and asserts only on them. Skipped without DATABASE_URL; refused
on a non-local host by the conftest guard.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any

import psycopg
import pytest

from worker import reaper

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
IP = "test-reaper-db-ip"


@pytest.fixture
def conn(monkeypatch):
    monkeypatch.setattr(reaper, "DATABASE_URL", DB)
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute("DELETE FROM public.jobs WHERE client_ip_hash = %s", (IP,))
        c.commit()
        yield c
        c.rollback()
        c.execute("DELETE FROM public.jobs WHERE client_ip_hash = %s", (IP,))
        c.commit()


def _job(c: Any, status: str, stale_s: int, attempts: int = 0) -> uuid.UUID:
    jid = uuid.uuid4()
    c.execute(
        "INSERT INTO public.jobs (id, input_kind, status, loop_length_bars, client_ip_hash,"
        " upload_r2_key, attempts, updated_at)"
        " VALUES (%s, 'upload', %s, 4, %s, %s, %s, now() - (%s * interval '1 second'))",
        (jid, status, IP, f"{jid}/_input.mp3", attempts, stale_s),
    )
    c.commit()
    return jid


def _row(c: Any, jid: uuid.UUID) -> tuple[str, int, str | None]:
    c.rollback()
    return c.execute(
        "SELECT status, attempts, error_code FROM public.jobs WHERE id = %s", (jid,)
    ).fetchone()


def _reap() -> dict[str, int]:
    return asyncio.run(reaper.reap_stale_jobs())


def test_a_live_job_is_left_alone_and_a_stale_one_is_requeued_once(conn):
    live = _job(conn, "separating", stale_s=reaper.STALE_SECONDS - 10)
    stale = _job(conn, "separating", stale_s=reaper.STALE_SECONDS + 10)
    _reap()
    assert _row(conn, live) == ("separating", 0, None)
    assert _row(conn, stale) == ("queued", 1, None)


def test_the_second_retry_waits_out_an_exponentially_longer_window(conn):
    """attempts=1 is re-queued only after STALE_SECONDS * FACTOR**1, not after the base window."""
    window = reaper.STALE_SECONDS * reaper.BACKOFF_FACTOR**1
    assert window > reaper.STALE_SECONDS + 20, "the backoff must lengthen the window"
    early = _job(conn, "extracting", stale_s=reaper.STALE_SECONDS + 10, attempts=1)
    late = _job(conn, "extracting", stale_s=int(window) + 10, attempts=1)
    _reap()
    assert _row(conn, early) == ("extracting", 1, None), "retried inside its backoff window"
    assert _row(conn, late) == ("queued", 2, None)


def test_a_job_out_of_attempts_is_failed_terminally_not_left_in_flight(conn):
    jid = _job(conn, "downloading", stale_s=reaper.STALE_SECONDS + 10, attempts=reaper.MAX_ATTEMPTS)
    _reap()
    assert _row(conn, jid) == ("failed", reaper.MAX_ATTEMPTS, "INTERNAL_ERROR")
    msg = conn.execute(
        "SELECT error_message_user FROM public.jobs WHERE id = %s", (jid,)
    ).fetchone()
    assert msg == ("Processing failed after repeated attempts. Please try again.",)


@pytest.mark.skipif(
    "REAPER_MAX_ATTEMPTS" in os.environ, reason="REAPER_MAX_ATTEMPTS overridden in this env"
)
def test_default_is_three_tries_in_total_two_reaper_requeues(conn):
    """The operator's 'max 3 attempts': the original run plus 2 re-queues, then failed."""
    assert reaper.MAX_ATTEMPTS == 2
    second = _job(conn, "uploading", stale_s=10**6, attempts=1)
    third = _job(conn, "uploading", stale_s=reaper.STALE_SECONDS + 10, attempts=2)
    _reap()
    assert _row(conn, second)[:2] == ("queued", 2)
    assert _row(conn, third)[:2] == ("failed", 2)


def test_queued_and_terminal_jobs_are_never_touched_however_old(conn):
    """A queued job is waiting (behind the spend brake, or a long queue), not orphaned."""
    rows = {
        _job(conn, "queued", stale_s=10**6, attempts=0): ("queued", 0, None),
        _job(conn, "queued", stale_s=10**6, attempts=reaper.MAX_ATTEMPTS): (
            "queued",
            reaper.MAX_ATTEMPTS,
            None,
        ),
        _job(conn, "done", stale_s=10**6, attempts=0): ("done", 0, None),
    }
    _reap()
    for jid, want in rows.items():
        assert _row(conn, jid) == want
