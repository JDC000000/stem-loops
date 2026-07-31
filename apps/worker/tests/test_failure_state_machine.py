"""Hardening H6 (+ H1 fencing) against a real Postgres.

TSD §6.3: every active stage emits `started`, then `completed` OR `failed`, and the
`failed` event must land atomically with jobs.status='failed'. None of the three
failure paths (pipeline._fail, consumer.mark_failed, reaper's poison branch) wrote
the event at all, so every failed job left a permanently open `started` stage.

Runs against DATABASE_URL when set; skips cleanly otherwise (same contract as
test_consumer.py). Uses asyncio.run inside sync tests — no plugin required.
"""

import asyncio
import os
import uuid

import psycopg
import pytest

from worker import consumer, pipeline, reaper

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")


_CREATED: list[str] = []


@pytest.fixture(autouse=True)
def _cleanup_jobs():
    """Delete every row these tests create. One of them deliberately leaves a job in
    'queued' (the reaper re-queue path), which the consumer test would otherwise claim
    if both ran against the same database."""
    yield
    if _CREATED:
        with psycopg.connect(DB) as c:  # job_events/loops cascade
            c.execute("DELETE FROM jobs WHERE id = ANY(%s)", (_CREATED,))
            c.commit()
        _CREATED.clear()


def _insert_job(status: str = "downloading", attempts: int = 0, stale_seconds: int = 0) -> str:
    job_id = str(uuid.uuid4())
    _CREATED.append(job_id)
    with psycopg.connect(DB) as c:
        c.execute(
            """
            INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars,
                             status, attempts, client_ip_hash, client_fingerprint, updated_at)
            VALUES(%s,%s,%s,%s,%s,%s,'test','test', now() - (%s * interval '1 second'))
            """,
            (
                job_id,
                "https://www.youtube.com/watch?v=00000000000",
                ["drums"],
                4,
                status,
                attempts,
                stale_seconds,
            ),
        )
        c.commit()
    return job_id


def _job(job_id: str) -> tuple:
    with psycopg.connect(DB) as c:
        return c.execute("SELECT status, error_code FROM jobs WHERE id=%s", (job_id,)).fetchone()


def _events(job_id: str) -> list[tuple]:
    with psycopg.connect(DB) as c:
        return c.execute(
            "SELECT stage, phase FROM job_events WHERE job_id=%s ORDER BY id", (job_id,)
        ).fetchall()


def test_pipeline_fail_writes_a_failed_event_for_the_current_stage():
    job_id = _insert_job(status="separating")
    asyncio.run(pipeline._fail(job_id, "SEPARATION_FAILED", "nope", 0))
    assert _job(job_id) == ("failed", "SEPARATION_FAILED")
    assert ("separating", "failed") in _events(job_id)


def test_consumer_mark_failed_writes_a_failed_event():
    job_id = _insert_job(status="extracting")
    asyncio.run(consumer.mark_failed(job_id, "INTERNAL_ERROR", "nope", 0))
    assert _job(job_id) == ("failed", "INTERNAL_ERROR")
    assert ("extracting", "failed") in _events(job_id)


def test_reaper_poison_branch_writes_a_failed_event():
    """The reaper fails a job whose attempts are exhausted — the trace must close too."""
    job_id = _insert_job(
        status="uploading", attempts=reaper.MAX_ATTEMPTS, stale_seconds=reaper.STALE_SECONDS + 60
    )
    result = asyncio.run(reaper.reap_stale_jobs())
    assert result["failed"] >= 1
    assert _job(job_id) == ("failed", "INTERNAL_ERROR")
    assert ("uploading", "failed") in _events(job_id)


def test_reaper_requeue_still_bumps_attempts():
    """Regression guard on the branch the H6 rewrite sits next to."""
    job_id = _insert_job(status="downloading", attempts=0, stale_seconds=reaper.STALE_SECONDS + 60)
    asyncio.run(reaper.reap_stale_jobs())
    with psycopg.connect(DB) as c:
        status, attempts = c.execute(
            "SELECT status, attempts FROM jobs WHERE id=%s", (job_id,)
        ).fetchone()
    assert (status, attempts) == ("queued", 1)


# ----------------------------- H1 fencing, end to end -----------------------------
def test_superseded_worker_cannot_overwrite_state():
    """The H1 race: the reaper re-queued this job (attempts 0 -> 1) and another worker
    took it. The original worker's writes must all become no-ops."""
    job_id = _insert_job(status="downloading", attempts=1)  # already re-queued once

    stale_attempt = 0  # what the superseded worker started with
    assert asyncio.run(pipeline.set_status(job_id, "uploading", stale_attempt)) is False
    assert (
        asyncio.run(pipeline.emit_event(job_id, "uploading", "started", attempt=stale_attempt))
        is False
    )
    asyncio.run(pipeline._fail(job_id, "INTERNAL_ERROR", "nope", stale_attempt))

    assert _job(job_id) == ("downloading", None), "superseded worker corrupted the job row"
    assert _events(job_id) == [], "superseded worker wrote a trace event"


def test_current_owner_writes_normally():
    job_id = _insert_job(status="downloading", attempts=1)
    assert asyncio.run(pipeline.set_status(job_id, "separating", 1)) is True
    assert (
        asyncio.run(pipeline.emit_event(job_id, "separating", "started", pct=15, attempt=1)) is True
    )
    assert _job(job_id)[0] == "separating"
    assert ("separating", "started") in _events(job_id)


def test_terminal_state_is_never_resurrected():
    """The reaper can fail a job outright without moving attempts, so the attempts
    token alone doesn't cover this — a worker must not walk a terminal job back."""
    job_id = _insert_job(status="failed", attempts=0)
    assert asyncio.run(pipeline.set_status(job_id, "uploading", 0)) is False
    assert _job(job_id)[0] == "failed"


def test_first_failure_wins():
    """The pipeline records the precise typed error; the consumer's safety net must
    not overwrite it with a generic one."""
    job_id = _insert_job(status="downloading")
    asyncio.run(pipeline._fail(job_id, "DOWNLOAD_BLOCKED", "specific", 0))
    asyncio.run(consumer.mark_failed(job_id, "INTERNAL_ERROR", "generic", 0))
    assert _job(job_id) == ("failed", "DOWNLOAD_BLOCKED")
    assert [e for e in _events(job_id) if e[1] == "failed"] == [("downloading", "failed")]
