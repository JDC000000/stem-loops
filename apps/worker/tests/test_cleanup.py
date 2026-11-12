"""24h retention sweep: expired jobs lose their R2 objects AND DB rows; orphans are reaped.

Runs against DATABASE_URL (skips cleanly otherwise). R2 is replaced by an in-memory fake.
"""

import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta

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


# --------------------------------------------------------------------------------------
# The chord artifact is the ONE object a job writes outside `{job_id}/`: r2_uploader's
# `upload_play_chords` puts it at `jobs/<job_id>/play.chords.json`. The per-job delete was
# `delete_prefix(f"{job_id}/")` alone, so it missed that key on EVERY job and the file only
# died if the capped, best-effort orphan sweep happened to reach it.
#
# Every key below is written as a LITERAL, never via job_object_prefixes() or
# play_chords_r2_key(). A test that rebuilds the key with the same function the code used
# proves only that the code applied its own rule; these assert the on-the-wire path.
# --------------------------------------------------------------------------------------


def test_job_id_of_resolves_the_job_under_the_named_prefix():
    """`jobs/<id>/...` must resolve to <id>, not to the literal "jobs"."""
    jid = "1f0c3a74-5b21-4e9c-8d10-77aa2b5e6c31"
    assert cleanup._job_id_of(f"{jid}/_input.wav") == jid
    assert cleanup._job_id_of(f"{jid}/_stems/play/drums.opus") == jid
    assert cleanup._job_id_of(f"{jid}/drums/a_0000.wav") == jid
    # The defect: this returned "jobs" and no job row could ever match it.
    assert cleanup._job_id_of(f"jobs/{jid}/play.chords.json") == jid
    assert cleanup._job_id_of(f"JOBS/{jid.upper()}/play.chords.json") == jid
    # Not a job at all: still "no live job owns this", so the orphan sweep may reap it.
    assert cleanup._job_id_of("not-a-uuid/stray.bin") == "not-a-uuid"
    assert cleanup._job_id_of("jobs/") == ""
    assert cleanup._job_id_of("jobs/stray.bin") == "stray.bin"


def test_expired_job_chord_file_is_deleted_by_the_per_job_sweep(r2):
    """The leak. Asserts the OBJECT is gone, not that a prefix string appears in the source.

    The chord file is seeded YOUNG against an EXPIRED job, so it is NOT orphan-eligible
    (list_objects_older_than skips it) and `orphan_objects == 0` proves it. The only thing
    that can delete it is the per-job sweep — which is exactly what was broken.
    """

    async def scenario():
        job = await _insert_job(25)
        r2.put(f"{job}/_input.wav", 25)
        r2.put(f"{job}/_stems/play/drums.opus", 25)
        r2.put(f"jobs/{job}/play.chords.json", 0.0)  # fresh: orphan sweep cannot see it
        res = await cleanup.sweep_expired()
        assert not await _exists(job)
        assert res["orphan_objects"] == 0, "the orphan sweep must not be what deleted it"
        assert (
            f"jobs/{job}/play.chords.json" not in r2.objs
        ), "the chord artifact escaped the per-job retention delete"
        assert not [k for k in r2.objs if job in k], "nothing of this job may survive"

    asyncio.run(scenario())


def test_live_job_chord_file_survives_the_sweep(r2):
    """The negative, and the direction that is unrecoverable. Deleting too much is worse.

    Two properties, in ONE pass so each is tested next to the other:

    1. `in_flight` is PAST expires_at but held back by INFLIGHT_GRACE, and its chord file is
       old enough for the orphan sweep. Because `_job_id_of` used to read "jobs" as the job
       id, no row could match and the orphan sweep deleted that file up to an hour before the
       job itself was swept — a live job losing its chords.
    2. BLAST RADIUS. An EXPIRED job is swept in the same pass, so the per-job delete runs
       while live jobs' chord files sit under the same `jobs/` top prefix. Without it, a
       `job_object_prefixes` that leaked the bare `jobs/` prefix deleted every live chord
       file and the suite stayed green, because no other test put an expired job and a
       live job's chord in one pass.
    """

    async def scenario():
        fresh = await _insert_job(1)
        in_flight = await _insert_job(24.5, status="separating")  # 30 min past expiry
        expired = await _insert_job(25)  # swept in THIS pass, next to the live chord files
        r2.put(f"jobs/{fresh}/play.chords.json", 1)
        r2.put(f"{fresh}/_input.wav", 1)
        r2.put(f"jobs/{in_flight}/play.chords.json", 25)  # aged, but the job is ALIVE
        r2.put(f"{in_flight}/_input.wav", 25)
        r2.put(f"{expired}/_input.wav", 25)
        r2.put(f"jobs/{expired}/play.chords.json", 0.0)  # fresh: only the per-job sweep reaches it
        res = await cleanup.sweep_expired()
        assert not await _exists(expired), "the expired job must actually have been swept"
        assert not [k for k in r2.objs if expired in k], "the expired job's objects must go"
        assert res["orphan_objects"] == 0, "the orphan sweep must not be what deleted anything"
        assert await _exists(fresh) and await _exists(in_flight)
        assert (
            f"jobs/{fresh}/play.chords.json" in r2.objs
        ), "sweeping an expired job deleted a LIVE job's chord file (blast radius)"
        assert f"{fresh}/_input.wav" in r2.objs
        assert (
            f"jobs/{in_flight}/play.chords.json" in r2.objs
        ), "a live job's chord file must not be reaped as an orphan or by a sibling's sweep"
        assert f"{in_flight}/_input.wav" in r2.objs

    asyncio.run(scenario())


def test_orphaned_chord_file_with_no_job_row_is_still_reaped(r2):
    """Fixing `_job_id_of` must not turn the backstop off for a genuinely dead job."""

    async def scenario():
        gone = str(uuid.uuid4())  # job row never existed / already deleted
        r2.put(f"jobs/{gone}/play.chords.json", 30)
        res = await cleanup.sweep_expired()
        assert res["orphan_objects"] >= 1
        assert f"jobs/{gone}/play.chords.json" not in r2.objs

    asyncio.run(scenario())


def test_purged_shell_stragglers_are_reaped_not_kept_for_ever(r2):
    """A shell row must not make its leftover objects immortal.

    Second-order consequence of fixing `_job_id_of`. An anonymised shell (_anonymise_job)
    keeps its row for ever to anchor the credit ledger and is excluded from
    _sweep_expired_jobs, so it is never re-swept. Once `jobs/<id>/...` resolves to <id>,
    treating that shell as a live job would keep its chord file FOREVER — strictly worse
    than the bug being fixed. The orphan sweep therefore does not count a shell as live.
    """

    async def scenario():
        shell = await _insert_job(48)
        async with await psycopg.AsyncConnection.connect(DB) as conn:
            await conn.execute(
                "UPDATE jobs SET client_ip_hash=%s, client_fingerprint=%s WHERE id=%s",
                (cleanup.PURGED_MARKER, cleanup.PURGED_MARKER, shell),
            )
            await conn.commit()
        r2.put(f"jobs/{shell}/play.chords.json", 48)
        r2.put(f"{shell}/_input.wav", 48)
        res = await cleanup.sweep_expired()
        assert await _exists(shell), "the ledger's FK target must survive"
        assert res["anonymised"] == 0, "a shell is never re-anonymised"
        assert f"jobs/{shell}/play.chords.json" not in r2.objs
        assert f"{shell}/_input.wav" not in r2.objs

    asyncio.run(scenario())


def test_r2_failure_on_the_chord_prefix_keeps_the_row_for_retry(r2):
    """A half-done footprint must not lose the row — the DB row is the retry handle."""

    async def scenario():
        old = await _insert_job(30)
        r2.put(f"{old}/_input.wav", 30)
        r2.put(f"jobs/{old}/play.chords.json", 30)
        r2.fail_prefix = f"jobs/{old}/"  # the SECOND prefix fails
        await cleanup.sweep_expired()
        assert await _exists(old), "row must survive a failed chord-prefix delete"
        assert f"jobs/{old}/play.chords.json" in r2.objs
        r2.fail_prefix = None
        cleanup._failed[old] = (cleanup._failed[old][0], 0.0)  # backoff elapsed
        await cleanup.sweep_expired()
        assert not await _exists(old)
        assert not [k for k in r2.objs if old in k]

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
        # The chord artifact of the LEDGER-BOUND job. FRESH, so the orphan sweep cannot be what
        # removes it: only the per-job delete, which must run BEFORE the row delete raises
        # ForeignKeyViolation. These are the paying jobs and the only ones that become shells.
        r2.put(f"jobs/{ledger_job}/play.chords.json", 0.0)
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
        # `in`, not startswith: the chord key is `jobs/<id>/...`, which starts with "jobs/".
        assert not [
            k for k in r2.objs if ledger_job in k
        ], "a credit-charged job's objects (incl. its chord file) must be gone"
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
        # Direct evidence: the prefixes pass 2 actually asked R2 to delete.
        #
        # This used to seed an aged `{ledger_job}/late.wav` and assert it SURVIVED. That
        # inference no longer holds, and it should not: an aged object under a purged shell
        # is content retention already promised to delete, and _sweep_orphaned_objects now
        # reaps it (a shell is not a live job). The property this test wants is that the JOB
        # sweep does not re-select the shell, so assert that directly instead of inferring it
        # from a leak.
        attempted: list[str] = []
        real = cleanup.delete_prefix
        monkeypatch.setattr(cleanup, "delete_prefix", lambda p: (attempted.append(p), real(p))[1])
        second = await cleanup.sweep_expired()
        assert second["jobs"] == 1 and not await _exists(newer), "pass 2 reaches the newer job"
        assert second["anonymised"] == 0
        assert not [
            p for p in attempted if ledger_job in p
        ], "pass 2 must not re-sweep the anonymised shell"

    asyncio.run(scenario())
