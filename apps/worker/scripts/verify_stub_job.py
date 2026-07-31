"""Assert that a completed stub job is REAL — used by the CI fixture-pipeline job.

`python -m src.worker.main --test-job <url>` exits 0 as long as nothing raised, so
on its own it proves very little. This checks the things that actually matter and
that have silently regressed before:

  * jobs.status == 'done'
  * every active stage emitted started + completed events (TSD §6.3)
  * loops rows were written
  * every loops.r2_key really exists in the bucket (the R2_ENDPOINT name mismatch
    used to leave rows pointing at objects that were never uploaded)

Usage:
    python scripts/verify_stub_job.py [job_id]   # defaults to the newest job
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import psycopg  # noqa: E402

from worker.storage.r2_uploader import _r2  # noqa: E402

ACTIVE_STAGES = ("downloading", "separating", "extracting", "uploading")


def _fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def verify(job_id: str | None = None) -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        if job_id is None:
            row = conn.execute("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1").fetchone()
            if not row:
                _fail("no jobs in the database — the stub job never inserted a row")
            job_id = str(row[0])

        status = conn.execute("SELECT status FROM jobs WHERE id=%s", (job_id,)).fetchone()
        if not status:
            _fail(f"job {job_id} not found")
        if status[0] != "done":
            _fail(f"job {job_id} status={status[0]!r}, expected 'done'")

        events = {
            (stage, phase)
            for stage, phase in conn.execute(
                "SELECT stage, phase FROM job_events WHERE job_id=%s", (job_id,)
            ).fetchall()
        }
        missing = [
            f"{stage}:{phase}"
            for stage in ACTIVE_STAGES
            for phase in ("started", "completed")
            if (stage, phase) not in events
        ]
        if missing:
            _fail(f"job {job_id} is missing job_events rows: {', '.join(missing)}")

        keys = [
            r[0]
            for r in conn.execute("SELECT r2_key FROM loops WHERE job_id=%s", (job_id,)).fetchall()
        ]

    if not keys:
        _fail(f"job {job_id} is done but produced no loops")

    bucket = os.environ["R2_BUCKET_NAME"]
    for key in keys:
        try:
            _r2().head_object(Bucket=bucket, Key=key)
        except Exception as exc:  # noqa: BLE001 — any miss is a hard failure
            _fail(f"loop r2_key {key!r} has no object in {bucket}: {exc}")

    print(f"OK: job {job_id} done, {len(keys)} loops, every r2_key present in {bucket}")


if __name__ == "__main__":
    verify(sys.argv[1] if len(sys.argv) > 1 else None)
