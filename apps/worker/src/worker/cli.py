"""CLI for `make test-job` — run one job directly, no queue, verbose redacted trace."""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

import psycopg

from .logger import log_structured
from .pipeline import run_pipeline

DEFAULT_STEMS = ["drums", "bass", "vocals", "guitar", "keys", "other"]


async def test_job(youtube_url: str) -> str:
    """Insert a queued job, run the pipeline directly, return the job id."""
    database_url = os.environ["DATABASE_URL"]
    job_id = str(uuid.uuid4())
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        await conn.execute(
            """
            INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars,
                             status, client_ip_hash, client_fingerprint)
            VALUES(%s,%s,%s,%s,'queued','test','test')
            """,
            (job_id, youtube_url, DEFAULT_STEMS, 4),
        )
        await conn.commit()
    log_structured("INFO", "test_job_created", job_id=job_id, youtube_url=youtube_url)
    await run_pipeline(job_id)
    log_structured("INFO", "test_job_done", job_id=job_id)
    return job_id


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 2 or argv[0] != "test-job":
        print("Usage: python -m worker.cli test-job <youtube_url>")
        return 1
    asyncio.run(test_job(argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
