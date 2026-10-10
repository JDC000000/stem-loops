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
    monkeypatch.setattr(cleanup, "delete_prefix", fake.delete_prefix)
    monkeypatch.setattr(cleanup, "list_objects_older_than", fake.list_older)
    monkeypatch.setattr(cleanup, "delete_objects", fake.delete_objects)
    return fake


async def _insert_job(age_hours: float) -> str:
    """Insert a job `age_hours` old using the real column default for expires_at."""
    job_id = str(uuid.uuid4())
    async with await psycopg.AsyncConnection.connect(DB) as conn:
        await conn.execute(
            """
            INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars, status,
                             client_ip_hash, client_fingerprint, created_at, expires_at)
            VALUES(%s,'u',%s,4,'done','t','t', now() - (%s * interval '1 hour'),
                   now() - (%s * interval '1 hour') + interval '24 hours')
            """,
            (job_id, ["drums"], age_hours, age_hours),
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
