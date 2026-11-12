"""24h retention sweep: expired jobs lose their R2 objects AND DB rows; orphans are reaped.

Runs against DATABASE_URL (skips cleanly otherwise). R2 is replaced by an in-memory fake.
"""

import asyncio
import contextlib
import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

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
        self.objs[key] = datetime.now(UTC) - timedelta(hours=age_hours)

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


@pytest.fixture(autouse=True)
def bystander_job():
    """A job this module did not create: created 2 days ago with 30-day retention.

    That is the shape a paid tier with a longer window (claude/tiered-retention-plan)
    produces. Migration 007's UPDATE is unscoped by design -- `WHERE expires_at >
    created_at + 24h` -- so anything that APPLIES it to the session database resets this
    row to created_at + 24h (a day in the past), and the production sweep then selects it
    and deletes its audio from R2. Teardown asserts the row is exactly as seeded, then
    deletes it by id (only ever this fixture's own row).
    """
    jid = str(uuid.uuid4())
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(
            """INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars, status,
                                client_ip_hash, client_fingerprint, created_at, expires_at)
               VALUES(%s,'https://bystander.invalid/paid',%s,4,'done','bystander','bystander',
                      now() - interval '2 days', now() - interval '2 days' + interval '30 days')""",
            (jid, ["drums"]),
        )
        before = c.execute(
            "SELECT created_at, expires_at, status FROM jobs WHERE id=%s", (jid,)
        ).fetchone()
        c.commit()
    try:
        yield jid
    finally:
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            after = c.execute(
                "SELECT created_at, expires_at, status FROM jobs WHERE id=%s", (jid,)
            ).fetchone()
            c.execute("DELETE FROM jobs WHERE id=%s", (jid,))
            c.commit()
        assert after == before, (
            "the bystander job (30-day retention) was changed or deleted by a test in this "
            f"module: was {before}, now {after}"
        )


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


MIGRATION_007 = os.path.join(os.path.dirname(__file__), "..", "migrations", "007_retention_24h.sql")


@contextlib.contextmanager
def _rolled_back_session() -> Iterator[Any]:
    """One connection, one transaction, ALWAYS rolled back (the pattern of
    test_033_cut_at_backfill._session).

    Deliberately not `with psycopg.connect(...)`, whose context manager COMMITS on a clean
    exit. Migration 007 is an unscoped UPDATE on `jobs`; this is what lets a test apply it
    without it being able to touch any row but the ones the test is looking at.
    """
    conn = psycopg.connect(DB)  # type: ignore[arg-type]
    try:
        conn.execute("SET statement_timeout = 30000")
        conn.execute("SET lock_timeout = 30000")
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _apply_migration_007_and_check(conn: Any) -> None:
    """Assert 007's effect on a row of our own. Never commits: the caller rolls back."""
    with open(MIGRATION_007) as f:
        mig = f.read()
    conn.execute(mig)  # idempotent: safe to re-apply
    jid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO jobs(id,youtube_url,requested_stems,loop_length_bars,client_ip_hash)"
        " VALUES(%s,'u',%s,4,'t')",
        (jid, ["drums"]),
    )
    row = conn.execute("SELECT expires_at - created_at FROM jobs WHERE id=%s", (jid,)).fetchone()
    assert row[0] == timedelta(hours=24)
    # A legacy 7-day row gets shortened; a row already shorter is left alone.
    conn.execute("UPDATE jobs SET expires_at = created_at + interval '7 days' WHERE id=%s", (jid,))
    conn.execute(mig)
    row = conn.execute("SELECT expires_at - created_at FROM jobs WHERE id=%s", (jid,)).fetchone()
    assert row[0] == timedelta(hours=24)


def test_migration_007_default_is_24h_and_shortens_existing_rows():
    # Migration 007's UPDATE is unscoped on purpose (a one-time retention migration must
    # reach every row), so this test must not be able to COMMIT it. Everything happens in
    # a transaction that is always rolled back: the migration, the default change and our
    # rows all vanish, and no other job in the session database is touched.
    with _rolled_back_session() as conn:
        _apply_migration_007_and_check(conn)


def test_migration_007_reaches_other_jobs_so_only_the_rollback_protects_them(bystander_job):
    """The non-vacuity gate for the test above. The migration really is unscoped: inside
    the transaction it DOES shorten a 30-day job this test never created, so the only
    reason that job is still 30 days afterwards is the rollback. (If 007 were ever scoped,
    or the bystander stopped matching its WHERE, the first assert says so rather than
    letting the survival check pass for nothing.)"""
    with _rolled_back_session() as conn:
        _apply_migration_007_and_check(conn)
        inside = conn.execute(
            "SELECT expires_at - created_at FROM jobs WHERE id=%s", (bystander_job,)
        ).fetchone()
        assert inside is not None and inside[0] == timedelta(hours=24), (
            "precondition: 007 should shorten the 30-day bystander INSIDE the transaction; "
            f"got {inside}"
        )
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        after = c.execute(
            "SELECT expires_at - created_at FROM jobs WHERE id=%s", (bystander_job,)
        ).fetchone()
    assert after is not None and after[0] == timedelta(
        days=30
    ), f"the bystander's retention changed and was committed: {after}"


# --------------------------------------------------------------------------------------
# Ledger-bound jobs. credit_consumption.job_id is ON DELETE RESTRICT (013) and
# chord_edits.job_id has no cascade (025): DELETE FROM jobs raises ForeignKeyViolation for any
# job that charged a credit or has a chord edit. Before the fix that exception escaped the
# sweep, every pass re-selected the same oldest row, and nothing else was ever swept.
# --------------------------------------------------------------------------------------
LEDGER_EMAIL = "test-cleanup-ledger-%@example.com"


def _purge_ledger_fixtures(c) -> None:
    c.rollback()
    like = "(SELECT id FROM public.users WHERE email LIKE %s)"
    c.execute(f"DELETE FROM public.chord_edits WHERE user_id IN {like}", (LEDGER_EMAIL,))
    c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {like}", (LEDGER_EMAIL,))
    c.execute(f"DELETE FROM public.credit_purchases WHERE user_id IN {like}", (LEDGER_EMAIL,))
    c.execute(f"DELETE FROM public.jobs WHERE user_id IN {like}", (LEDGER_EMAIL,))
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (LEDGER_EMAIL,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (LEDGER_EMAIL,))
    c.commit()


@pytest.fixture
def ledger_db():
    if not any(h in (DB or "") for h in ("127.0.0.1", "localhost")):
        pytest.skip("inserts into auth.users; local throwaway DB only")
    with psycopg.connect(DB) as c:
        _purge_ledger_fixtures(c)
        yield c
        _purge_ledger_fixtures(c)


def _ledger_user(c) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-cleanup-ledger-{uid.hex[:8]}@example.com"),
    )
    c.commit()
    return uid


def _ledger_upload_job(c, user_id, age_hours: float) -> str:
    """An expired upload job that charged a credit (credit_consumption row)."""
    job_id = str(uuid.uuid4())
    c.execute(
        "INSERT INTO public.jobs (id, input_kind, status, user_id, loop_length_bars, "
        "  client_ip_hash, client_fingerprint, upload_r2_key, original_filename, title, bpm, "
        "  created_at, expires_at) "
        "VALUES (%s,'upload','done',%s,4,'iphash','fp',%s,'secret song.wav','My Title',120, "
        "  now() - (%s * interval '1 hour'), now() - (%s * interval '1 hour') + interval '24 hours')",
        (job_id, user_id, f"{job_id}/_input.wav", age_hours, age_hours),
    )
    c.execute(
        "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s,%s)", (user_id, job_id)
    )
    c.commit()
    return job_id


def _job_row(c, job_id: str):
    return c.execute(
        "SELECT youtube_url, upload_r2_key, original_filename, title, bpm, client_ip_hash, "
        "client_fingerprint, status, user_id FROM public.jobs WHERE id=%s",
        (job_id,),
    ).fetchone()


def test_credit_charged_job_is_anonymised_and_later_jobs_still_swept(r2, ledger_db):
    c = ledger_db

    async def scenario():
        uid = _ledger_user(c)
        ledger_job = _ledger_upload_job(c, uid, 48)  # oldest -> head of ORDER BY expires_at
        later = [await _insert_job(30 + i) for i in range(3)]
        orphan = str(uuid.uuid4())
        for j in [ledger_job, *later]:
            r2.put(f"{j}/_input.wav", 48)
        r2.put(f"{orphan}/_input.mp3", 40)  # orphan sweep only runs if the job sweep returns
        async with await psycopg.AsyncConnection.connect(DB) as conn:
            await conn.execute(
                "INSERT INTO upload_rate_events(client_ip_hash, created_at) "
                "VALUES('x', now() - interval '3 days')"
            )
            await conn.commit()

        res = await cleanup.sweep_expired()

        # The sweep survived the FK violation and carried on past it.
        for j in later:
            assert not await _exists(j), "jobs behind a ledger-bound job must still be swept"
        assert f"{orphan}/_input.mp3" not in r2.objs, "orphan sweep must still run"
        assert res["upload_events"] >= 1, "upload_rate_events prune must still run"
        assert res["jobs"] == 3 and res["anonymised"] == 1

        # The ledger job is kept as an anonymised shell; its R2 objects are gone.
        assert not [k for k in r2.objs if k.startswith(ledger_job)]
        row = _job_row(c, ledger_job)
        assert row is not None, "ledger FK target must survive"
        yt, key, fname, title, bpm, iph, fp, status, user = row
        assert (yt, key, fname, title, bpm) == (None, "", None, None, None)
        assert iph == fp == cleanup.PURGED_MARKER
        assert status == "done" and user == uid
        # The append-only ledger is untouched.
        assert (
            c.execute(
                "SELECT COUNT(*) FROM public.credit_consumption WHERE job_id=%s", (ledger_job,)
            ).fetchone()[0]
            == 1
        )

    asyncio.run(scenario())


def test_chord_edit_job_is_anonymised_not_deleted(r2, ledger_db):
    c = ledger_db

    async def scenario():
        uid = _ledger_user(c)
        job = await _insert_job(30)
        c.execute("UPDATE public.jobs SET user_id=%s WHERE id=%s", (uid, job))
        c.execute(
            "INSERT INTO public.chord_edits (user_id, job_id, track_hash, provider, "
            "provider_version, start_sec, end_sec, original_label, corrected_label, alphabet_sha) "
            "VALUES (%s,%s,%s,'klangio','v1',0,1,'C','G',%s)",
            (uid, job, "b" * 64, "a" * 64),
        )
        c.commit()
        res = await cleanup.sweep_expired()
        assert res["anonymised"] == 1
        row = _job_row(c, job)
        assert row is not None and row[0] == "" and row[5] == cleanup.PURGED_MARKER
        assert (
            c.execute("SELECT COUNT(*) FROM public.chord_edits WHERE job_id=%s", (job,)).fetchone()[
                0
            ]
            == 1
        )

    asyncio.run(scenario())


def test_anonymised_shell_is_not_reselected_so_it_cannot_starve_the_batch(
    r2, ledger_db, monkeypatch
):
    """With a batch of 1, the oldest ledger shell must not be re-picked on every pass."""
    c = ledger_db

    async def scenario():
        uid = _ledger_user(c)
        ledger_job = _ledger_upload_job(c, uid, 48)
        newer = await _insert_job(30)
        # Drop expired rows left by other tests so the batch of 1 is deterministic.
        c.execute(
            "DELETE FROM public.jobs WHERE expires_at < now() AND id NOT IN (%s, %s)",
            (ledger_job, newer),
        )
        c.commit()
        monkeypatch.setattr(cleanup, "MAX_JOBS_PER_SWEEP", 1)
        first = await cleanup.sweep_expired()
        assert first["anonymised"] == 1 and await _exists(newer)
        r2.put(f"{ledger_job}/late.wav", 48)  # would reappear in delete_prefix if re-selected
        second = await cleanup.sweep_expired()
        assert second["jobs"] == 1 and not await _exists(newer), "pass 2 reaches the newer job"
        assert any(k.startswith(ledger_job) for k in r2.objs), "shell was not swept a second time"

    asyncio.run(scenario())
