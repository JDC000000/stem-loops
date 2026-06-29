"""P1-15: a poison job fails in isolation without blocking healthy jobs.

Integration test: runs against DATABASE_URL when set (skips cleanly otherwise, so
CI without a DB stays green). Uses asyncio.run inside sync tests so no
pytest-asyncio plugin is required.
"""

import asyncio
import os
import uuid

import psycopg
import pytest

from worker import consumer

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")


async def _insert_queued(url: str) -> str:
    job_id = str(uuid.uuid4())
    async with await psycopg.AsyncConnection.connect(DB) as conn:
        await conn.execute(
            """
            INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars,
                             status, client_ip_hash, client_fingerprint)
            VALUES(%s,%s,%s,%s,'queued','test','test')
            """,
            (job_id, url, ["drums"], 4),
        )
        await conn.commit()
    return job_id


async def _status(job_id: str) -> tuple[str, str | None]:
    async with await psycopg.AsyncConnection.connect(DB) as conn:
        row = await (
            await conn.execute("SELECT status, error_code FROM jobs WHERE id=%s", (job_id,))
        ).fetchone()
    return row[0], row[1]


def test_poison_job_isolated(monkeypatch):
    async def scenario():
        # Poison inserted first (older) so it is claimed first.
        poison_id = await _insert_queued("https://www.youtube.com/watch?v=poison00000")
        healthy_id = await _insert_queued("https://www.youtube.com/watch?v=healthy0000")

        async def fake_pipeline(job_id: str):
            if job_id == poison_id:
                raise RuntimeError("deliberate poison failure")
            # healthy success path: mark done, mirroring the real pipeline's final step
            async with await psycopg.AsyncConnection.connect(DB) as conn:
                await conn.execute("UPDATE jobs SET status='done' WHERE id=%s", (job_id,))
                await conn.commit()

        monkeypatch.setattr(consumer, "run_pipeline", fake_pipeline, raising=True)

        # Claim #1: poison — must NOT raise, must mark failed.
        claimed1 = await consumer.claim_and_run()
        # Claim #2: healthy — must complete.
        claimed2 = await consumer.claim_and_run()

        assert claimed1 is True and claimed2 is True
        p_status, p_err = await _status(poison_id)
        h_status, _ = await _status(healthy_id)
        assert p_status == "failed", f"poison not failed: {p_status}"
        assert p_err == "INTERNAL_ERROR", f"poison error_code wrong: {p_err}"
        assert h_status == "done", f"healthy blocked by poison: {h_status}"

    asyncio.run(scenario())
