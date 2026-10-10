"""24h retention sweep: expired jobs lose their R2 objects AND DB rows; orphans are reaped.

Runs against DATABASE_URL (skips cleanly otherwise). R2 is replaced by an in-memory fake.
"""

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from worker import cleanup

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")


class FakeR2:
    """key -> LastModified. Mirrors the three r2_uploader helpers the sweep uses."""

    def __init__(self):
        self.objs: dict[str, datetime] = {}
        self.fail_prefix: str | None = None

    def put(self, key, age_hours=0.0):
        self.objs[key] = datetime.now(timezone.utc) - timedelta(hours=age_hours)

    def delete_prefix(self, prefix):
        if self.fail_prefix and prefix.startswith(self.fail_prefix):
            raise RuntimeError("r2 down")
        keys = [k for k in self.objs if k.startswith(prefix)]
        for k in keys:
            del self.objs[k]
        return len(keys)

    def list_older(self, cutoff, limit=2000):
        return [k for k, t in self.objs.items() if t < cutoff][:limit]

    def delete_objects(self, keys):
        for k in keys:
            self.objs.pop(k, None)
        return len(keys)


@pytest.fixture
def r2(monkeypatch):
    fake = FakeR2()
    monkeypatch.setattr(cleanup, "DATABASE_URL", DB)
    cleanup._failed.clear()
    monkeypatch.setattr(cleanup, "delete_prefix", fake.delete_prefix)
    monkeypatch.setattr(cleanup, "list_objects_older_than", fake.list_older)
    monkeypatch.setattr(cleanup, "delete_objects", fake.delete_objects)
    return fake


async def _insert_job(age_hours: float, status: str = "done") -> str:
    """Insert a job `age_hours` old (expires_at = created_at + 24h)."""
    job_id = str(uuid.uuid4())
    async with await psycopg.AsyncConnection.connect(DB) as conn:
        await conn.execute(
            """
            INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars, status,
                             client_ip_hash, client_fingerprint, created_at, expires_at)
            VALUES(%s,'u',%s,4,%s,'t','t', now() - (%s * interval '1 hour'),
                   now() - (%s * interval '1 hour') + interval '24 hours')
            """,
            (job_id, ["drums"], status, age_hours, age_hours),
        )
        await conn.commit()
    return job_id


async def _exists(job_id: str) -> bool:
    async with await psycopg.AsyncConnection.connect(DB) as conn:
        row = await (await conn.execute("SELECT 1 FROM jobs WHERE id=%s", (job_id,))).fetchone()
    return row is not None


def test_expired_job_loses_r2_objects_and_row(r2):
    async def scenario():
        old = await _insert_job(25)
        fresh = await _insert_job(1)
        for j in (old, fresh):
            r2.put(f"{j}/_input.wav", 25 if j == old else 1)
            r2.put(f"{j}/drums/a_0000.wav", 25 if j == old else 1)
        res = await cleanup.sweep_expired()
        assert res["jobs"] >= 1
        assert not await _exists(old)
        assert await _exists(fresh)
        assert not [k for k in r2.objs if k.startswith(old)]
        assert len([k for k in r2.objs if k.startswith(fresh)]) == 2

    asyncio.run(scenario())


def test_r2_failure_keeps_row_for_retry(r2):
    async def scenario():
        old = await _insert_job(30)
        r2.put(f"{old}/_input.wav", 30)
        r2.fail_prefix = f"{old}/"
        await cleanup.sweep_expired()
        assert await _exists(old), "row must survive a failed R2 delete so the next sweep retries"
        assert r2.objs
        r2.fail_prefix = None
        cleanup._failed[old] = (cleanup._failed[old][0], 0.0)  # backoff elapsed
        await cleanup.sweep_expired()
        assert not await _exists(old)
        assert not [k for k in r2.objs if k.startswith(old)]

    asyncio.run(scenario())


def test_orphan_objects_reaped_but_live_jobs_kept(r2):
    async def scenario():
        orphan = str(uuid.uuid4())  # uploaded, job never created
        young_orphan = str(uuid.uuid4())  # recent upload, job not created yet: keep
        live = await _insert_job(1)
        r2.put(f"{orphan}/_input.mp3", 26)
        r2.put(f"{young_orphan}/_input.mp3", 0.2)
        r2.put(f"{live}/_input.wav", 25)  # old object but job row still live: keep
        r2.put("not-a-uuid/stray.bin", 40)
        res = await cleanup.sweep_expired()
        assert res["orphan_objects"] == 2
        assert f"{orphan}/_input.mp3" not in r2.objs
        assert "not-a-uuid/stray.bin" not in r2.objs
        assert f"{young_orphan}/_input.mp3" in r2.objs
        assert f"{live}/_input.wav" in r2.objs

    asyncio.run(scenario())


def test_in_flight_jobs_not_swept_until_an_hour_past_expiry(r2):
    async def scenario():
        just_expired = await _insert_job(24.5, status="separating")  # 30 min past expiry
        long_stale = await _insert_job(27, status="separating")  # 3h past expiry
        await cleanup.sweep_expired()
        assert await _exists(just_expired), "in-flight job must survive a just-expired sweep"
        assert not await _exists(long_stale)

    asyncio.run(scenario())


def test_stuck_job_is_skipped_and_does_not_block_others(r2):
    async def scenario():
        stuck = await _insert_job(40)  # oldest -> head of the ORDER BY
        ok = await _insert_job(30)
        r2.put(f"{stuck}/_input.wav", 40)
        r2.put(f"{ok}/_input.wav", 30)
        r2.fail_prefix = f"{stuck}/"
        await cleanup.sweep_expired()
        assert not await _exists(ok), "a healthy job behind a stuck one must still be swept"
        assert await _exists(stuck)
        assert cleanup._failed[stuck][0] == 1
        # Backoff: an immediate second pass doesn't hammer R2 for the stuck job again.
        attempts = []
        real = r2.delete_prefix
        r2.delete_prefix = lambda p: (attempts.append(p), real(p))[1]
        cleanup.delete_prefix = r2.delete_prefix
        await cleanup.sweep_expired()
        assert not [p for p in attempts if p.startswith(stuck)]

    asyncio.run(scenario())


def test_repeated_failures_are_reported_as_stuck(r2):
    async def scenario():
        stuck = await _insert_job(40)
        r2.fail_prefix = f"{stuck}/"
        res = {}
        for _ in range(cleanup.STUCK_AFTER_FAILURES):
            if stuck in cleanup._failed:  # let the backoff window elapse
                cleanup._failed[stuck] = (cleanup._failed[stuck][0], 0.0)
            res = await cleanup.sweep_expired()
        assert res["stuck"] >= 1

    asyncio.run(scenario())


def test_budget_stops_the_sweep_early(r2, monkeypatch):
    async def scenario():
        a = await _insert_job(30)
        monkeypatch.setattr(cleanup, "SWEEP_BUDGET_SECONDS", 0.0)
        res = await cleanup.sweep_expired()
        assert res["jobs"] == 0 and await _exists(a), "zero budget -> nothing swept this pass"
        monkeypatch.setattr(cleanup, "SWEEP_BUDGET_SECONDS", 60.0)
        await cleanup.sweep_expired()
        assert not await _exists(a), "next pass continues the work"

    asyncio.run(scenario())


def test_migration_007_default_is_24h_and_shortens_existing_rows():
    async def scenario():
        mig_path = os.path.join(
            os.path.dirname(__file__), "..", "migrations", "007_retention_24h.sql"
        )
        with open(mig_path) as f:
            mig = f.read()
        async with await psycopg.AsyncConnection.connect(DB) as conn:
            await conn.execute(mig)  # idempotent: safe to re-apply
            jid = str(uuid.uuid4())
            await conn.execute(
                "INSERT INTO jobs(id,youtube_url,requested_stems,loop_length_bars,client_ip_hash)"
                " VALUES(%s,'u',%s,4,'t')",
                (jid, ["drums"]),
            )
            row = await (
                await conn.execute("SELECT expires_at - created_at FROM jobs WHERE id=%s", (jid,))
            ).fetchone()
            assert row[0] == timedelta(hours=24)
            # A legacy 7-day row gets shortened; a row already shorter is left alone.
            await conn.execute(
                "UPDATE jobs SET expires_at = created_at + interval '7 days' WHERE id=%s", (jid,)
            )
            await conn.execute(mig)
            row = await (
                await conn.execute("SELECT expires_at - created_at FROM jobs WHERE id=%s", (jid,))
            ).fetchone()
            assert row[0] == timedelta(hours=24)
            await conn.execute("DELETE FROM jobs WHERE id=%s", (jid,))
            await conn.commit()

    asyncio.run(scenario())
