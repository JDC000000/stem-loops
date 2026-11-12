"""The 24-hour deletion promise, driven through the REAL R2 deleters.

`test_cleanup.py` swaps `delete_prefix`, `list_objects_older_than` and `delete_objects`
for an in-memory fake, so `r2_uploader`'s boto3 deleters ran in no test. Here
`cleanup.sweep_expired()` runs against a real S3 server (moto, over HTTP, see
`tests/real_r2.py`) with NOTHING in `cleanup` patched.

Three properties make these tests able to fail, and each is deliberate:

  * EVERY KEY SHAPE is seeded for every job (the seven in `real_r2.job_footprint`),
    where the fake-backed tests seed `_input.*` and one loop and never a stem.
  * Objects that must be deleted by the PER-JOB delete are seeded YOUNGER than 24 h.
    The age-based orphan pass only deletes objects older than the retention window
    whose job row is gone, so with old objects it silently repairs a broken per-job
    delete and the test cannot tell. (A credit-charged job's shell row is never
    deleted, so the orphan pass can NEVER repair it -- see the ledger test.)
  * A live job's seven objects are asserted to SURVIVE, so "delete everything" is not
    a passing implementation either.

Shape 7 (`jobs/<id>/play.chords.json`) is the one the per-job delete misses until PR #214.
It is handled by `assert_chords_gone_or_xfail`, called LAST in a test after shapes 1-6 were
asserted gone with plain `assert`s. There is deliberately no `xfail` marker: see that
function's docstring for what the marker hid.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import psycopg
import pytest
from botocore.exceptions import ClientError

from tests.real_r2 import (
    CHORDS_SHAPE,
    RealR2,
    assert_chords_gone_or_xfail,
    job_footprint,
    require_database,
    skip_or_fail,
)
from worker import cleanup

DB = os.environ.get("DATABASE_URL")


@pytest.fixture(autouse=True)
def _database():
    # A developer with no database gets a clean skip; under CI=true a missing database is
    # a FAILURE, because a skipped retention gate is a gate that did not run.
    require_database()


LEDGER_EMAIL = "test-retention-real-r2-%@example.com"


@pytest.fixture
def r2(monkeypatch):
    monkeypatch.setattr(cleanup, "DATABASE_URL", DB)
    cleanup._failed.clear()
    with RealR2(monkeypatch) as server:
        yield server
    cleanup._failed.clear()


def _insert_job(age_hours: float, status: str = "done", user_id=None, charged=False) -> str:
    """A job `age_hours` old. `charged` makes it an upload job with a credit_consumption
    row (the ledger refuses a charge against any other input_kind)."""
    job_id = str(uuid.uuid4())
    with psycopg.connect(DB) as c:
        c.execute(
            "INSERT INTO public.jobs (id, input_kind, youtube_url, upload_r2_key, status, "
            "  user_id, loop_length_bars, requested_stems, client_ip_hash, client_fingerprint, "
            "  title, created_at, expires_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,4,%s,'iphash','fp','My Title', "
            "  now() - (%s * interval '1 hour'), "
            "  now() - (%s * interval '1 hour') + interval '24 hours')",
            (
                job_id,
                "upload" if charged else "youtube",
                None if charged else "https://y/x",
                f"{job_id}/_input.wav" if charged else None,
                status,
                user_id,
                ["drums"],
                age_hours,
                age_hours,
            ),
        )
        if charged:
            c.execute(
                "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s,%s)",
                (user_id, job_id),
            )
        c.commit()
    return job_id


def _row(job_id: str):
    with psycopg.connect(DB) as c:
        return c.execute(
            "SELECT client_ip_hash, title FROM public.jobs WHERE id=%s", (job_id,)
        ).fetchone()


def _age_all(r2: RealR2, shapes: dict[str, str], hours: float) -> None:
    for key in shapes.values():
        r2.age(key, hours)


def _survivors(r2: RealR2, shapes: dict[str, str], *, skip: tuple[str, ...] = ()) -> list[str]:
    left = r2.all_keys()
    return [name for name, key in shapes.items() if key in left and name not in skip]


def test_expired_job_loses_every_prefixed_shape_even_when_its_objects_are_young(r2, tmp_path):
    """The per-job delete itself, with the age backstop unable to help.

    Kills: `delete_prefix` deleting nothing; the sweep deleting only `<id>/_input*`.
    The job expired an hour ago but its objects are 1 h old (an on-demand cut, or a
    separation that finished late), so the orphan pass -- which needs > 24 h -- is inert.
    """

    async def scenario():
        expired = _insert_job(25)
        live = _insert_job(1)
        exp_shapes = job_footprint(expired, str(tmp_path))
        live_shapes = job_footprint(live, str(tmp_path))
        _age_all(r2, exp_shapes, 1.0)
        _age_all(r2, live_shapes, 0.5)
        assert len(r2.all_keys()) == 14

        await cleanup.sweep_expired()

        assert _row(expired) is None, "the expired job's row must be deleted"
        assert _row(live) is not None, "a live job's row must be left alone"
        left = _survivors(r2, exp_shapes, skip=(CHORDS_SHAPE,))
        assert not left, (
            "the 24-hour promise is broken: these shapes of an EXPIRED job survived the "
            f"sweep while younger than the orphan backstop's cutoff: {left}"
        )
        assert {k for k in r2.all_keys() if live in k} == set(
            live_shapes.values()
        ), "a live job's objects were deleted by the sweep"

    asyncio.run(scenario())


def test_expired_job_loses_its_chords_object_even_when_young(r2, tmp_path):
    """Shapes 1-6 are asserted gone HARD; only the chords key may xfail, and only until #214."""

    async def scenario():
        expired = _insert_job(25)
        shapes = job_footprint(expired, str(tmp_path))
        _age_all(r2, shapes, 1.0)
        assert shapes[CHORDS_SHAPE] in r2.all_keys(), "fixture: the chords object was seeded"

        await cleanup.sweep_expired()

        assert _row(expired) is None, "the expired job's row must be deleted"
        left = _survivors(r2, shapes, skip=(CHORDS_SHAPE,))
        assert not left, f"shapes 1-6 of an expired job survived the sweep: {left}"
        assert_chords_gone_or_xfail(r2, shapes)

    asyncio.run(scenario())


@pytest.fixture
def ledger_user():
    if not any(h in (DB or "") for h in ("127.0.0.1", "localhost")):
        skip_or_fail("DATABASE_URL is not local, and this test inserts into auth.users")

    def purge(c):
        c.rollback()
        like = "(SELECT id FROM public.users WHERE email LIKE %s)"
        c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {like}", (LEDGER_EMAIL,))
        c.execute(f"DELETE FROM public.jobs WHERE user_id IN {like}", (LEDGER_EMAIL,))
        c.execute("DELETE FROM public.users WHERE email LIKE %s", (LEDGER_EMAIL,))
        c.execute("DELETE FROM auth.users WHERE email LIKE %s", (LEDGER_EMAIL,))
        c.commit()

    uid = uuid.uuid4()
    with psycopg.connect(DB) as c:
        purge(c)
        c.execute(
            "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
            "email_confirmed_at, created_at, updated_at) "
            "VALUES (%s,%s,'authenticated','authenticated','x',now(),now(),now())",
            (uid, f"test-retention-real-r2-{uid.hex[:8]}@example.com"),
        )
        c.commit()
        yield uid
        purge(c)


def test_credit_charged_job_shell_keeps_none_of_its_objects(r2, tmp_path, ledger_user):
    """A ledger-bound job is anonymised, not deleted: its row stays, so the orphan pass
    treats it as live and will NEVER look at its objects again. The per-job delete is
    the only chance to remove them, whatever their age (25 h here, the realistic case).

    Kills: `delete_prefix` deleting nothing; the sweep deleting only `<id>/_input*`.
    """

    async def scenario():
        charged = _insert_job(26, user_id=ledger_user, charged=True)
        shapes = job_footprint(charged, str(tmp_path))
        _age_all(r2, shapes, 25.0)

        res = await cleanup.sweep_expired()

        assert res["anonymised"] >= 1
        row = _row(charged)
        assert row is not None and row[0] == cleanup.PURGED_MARKER, "must be an anonymised shell"
        assert row[1] is None, "the shell must have lost its title"
        left = _survivors(r2, shapes, skip=(CHORDS_SHAPE,))
        assert not left, (
            "a credit-charged job's shell has no row left to revisit these objects: " f"{left}"
        )
        # Run it again: a shell is not re-selected, so nothing may be silently pending.
        await cleanup.sweep_expired()
        assert not _survivors(r2, shapes, skip=(CHORDS_SHAPE,))

    asyncio.run(scenario())


def test_orphan_backstop_uses_the_real_list_and_delete_helpers(r2, tmp_path):
    """The age-based pass, through the real `list_objects_older_than` + `delete_objects`.

    Kills: `delete_objects` deleting nothing; `list_objects_older_than` listing nothing
    or ignoring the cutoff.
    """

    async def scenario():
        old_orphan, young_orphan, live = str(uuid.uuid4()), str(uuid.uuid4()), _insert_job(1)
        r2.put(f"{old_orphan}/_input.mp3", 26)
        r2.put(f"{old_orphan}/bass/4bar_verse_0003.wav", 26)
        r2.put(f"jobs/{old_orphan}/play.chords.json", 26)
        r2.put("not-a-uuid/stray.bin", 40)
        r2.put(f"{young_orphan}/_input.mp3", 0.2)  # upload not yet a job: keep
        r2.put(f"{live}/_input.wav", 25)  # old object, live row: keep

        res = await cleanup.sweep_expired()

        assert res["orphan_objects"] == 4
        assert r2.all_keys() == {f"{young_orphan}/_input.mp3", f"{live}/_input.wav"}

    asyncio.run(scenario())


def test_delete_prefix_pages_through_more_than_one_listing_page(r2):
    """`delete_prefix` over a prefix larger than one ListObjectsV2 page (1000 keys)."""
    from worker.storage import r2_uploader

    job, sibling = str(uuid.uuid4()), str(uuid.uuid4())
    for i in range(1001):
        r2.client.put_object(Bucket=os.environ["R2_BUCKET_NAME"], Key=f"{job}/s/{i:04d}.wav")
    r2.put(f"{sibling}/_input.wav")

    assert r2_uploader.delete_prefix(f"{job}/") == 1001
    assert r2.all_keys() == {f"{sibling}/_input.wav"}


def test_credit_charged_shell_loses_its_chords_object_even_when_young(r2, tmp_path, ledger_user):
    """Shapes 1-6 are asserted gone HARD; only the chords key may xfail, and only until #214.

    Objects are 1 h old on purpose. At 25 h the orphan pass removes the chords object of a
    shell too -- but only because `_job_id_of('jobs/<id>/...')` is the literal "jobs", which
    is never a live job id, so the pass treats every old chords object as an orphan (the
    same behaviour #214 says deletes a LIVE job's file). That is the wrong reason to pass.
    With a young object only the per-job delete can help, and a shell has no row left for
    any later sweep to revisit it by.
    """

    async def scenario():
        charged = _insert_job(26, user_id=ledger_user, charged=True)
        shapes = job_footprint(charged, str(tmp_path))
        _age_all(r2, shapes, 1.0)
        assert shapes[CHORDS_SHAPE] in r2.all_keys(), "fixture: the chords object was seeded"

        await cleanup.sweep_expired()
        await cleanup.sweep_expired()  # a shell is never re-selected: a second pass cannot help

        row = _row(charged)
        assert row is not None and row[0] == cleanup.PURGED_MARKER, "must be an anonymised shell"
        left = _survivors(r2, shapes, skip=(CHORDS_SHAPE,))
        assert not left, f"shapes 1-6 of a credit-charged shell survived: {left}"
        assert_chords_gone_or_xfail(r2, shapes)

    asyncio.run(scenario())


# --------------------------------------------------------------- job status filter


def test_failed_jobs_are_swept_and_inflight_jobs_wait_out_their_grace(r2, tmp_path):
    """`status IN ('done','failed') OR expires_at < now() - INFLIGHT_GRACE`.

    Every case here is 30 minutes past expiry unless stated, so only the STATUS decides.
    Kills: dropping 'failed' from the status list (a failed job's audio would then outlive
    its 24 hours until it was an hour stale), and dropping or loosening the in-flight grace
    (a sibling worker's sweep would delete a job that is still being separated).
    """

    async def scenario():
        failed = _insert_job(24.5, status="failed")
        done = _insert_job(24.5, status="done")
        inflight_fresh = _insert_job(24.5, status="separating")  # 30 min past: inside the grace
        inflight_stale = _insert_job(26, status="separating")  # 2 h past: outside it
        footprints = {}
        for name, jid in (
            ("failed", failed),
            ("done", done),
            ("inflight_fresh", inflight_fresh),
            ("inflight_stale", inflight_stale),
        ):
            footprints[name] = job_footprint(jid, str(tmp_path))
            _age_all(r2, footprints[name], 1.0)  # the age backstop cannot help

        res = await cleanup.sweep_expired()

        assert res["jobs"] >= 3, f"expected failed, done and stale in-flight swept: {res}"
        for name, jid in (("failed", failed), ("done", done), ("inflight_stale", inflight_stale)):
            assert _row(jid) is None, f"the {name} job's row must be deleted"
            left = _survivors(r2, footprints[name], skip=(CHORDS_SHAPE,))
            assert not left, f"the {name} job's objects survived the sweep: {left}"
        assert _row(inflight_fresh) is not None, "an in-flight job inside the grace was deleted"
        assert {k for k in r2.all_keys() if inflight_fresh in k} == set(
            footprints["inflight_fresh"].values()
        ), "an in-flight job inside the grace lost objects"

    asyncio.run(scenario())


# ------------------------------------------------------- the orphan backstop's paging


def _put_many(r2: RealR2, keys: list[str]) -> None:
    for key in keys:
        r2.client.put_object(Bucket=os.environ["R2_BUCKET_NAME"], Key=key, Body=b"x")


def test_orphan_backstop_is_not_blind_past_the_first_1000_keys_of_the_bucket(r2):
    """The age filter runs on every page, not just the first.

    1000 YOUNG keys sort before one OLD orphan, so the old key is on page 2 of the listing.
    Kills: `list_objects_older_than` returning after the first page, which leaves the
    backstop unable to see anything past the first 1000 keys in a real bucket.
    """
    young_job, old_orphan = str(uuid.uuid4()), "ffffffff-ffff-4fff-8fff-ffffffffffff"
    _put_many(r2, [f"{young_job}/s/{i:04d}.wav" for i in range(1000)])
    r2.put(f"{old_orphan}/_input.mp3", 30)

    async def scenario():
        res = await cleanup.sweep_expired()
        assert res["orphan_objects"] == 1, f"the old orphan on page 2 was not found: {res}"

    asyncio.run(scenario())
    left = r2.all_keys()
    assert f"{old_orphan}/_input.mp3" not in left
    assert len([k for k in left if k.startswith(young_job)]) == 1000, "young objects were deleted"


def test_list_objects_older_than_collects_across_pages_and_honours_its_limit(r2):
    from datetime import UTC, datetime, timedelta

    from worker.storage import r2_uploader

    job = str(uuid.uuid4())
    keys = [f"{job}/s/{i:04d}.wav" for i in range(1001)]
    _put_many(r2, keys)
    r2.age_many(keys, 30)
    cutoff = datetime.now(UTC) - timedelta(hours=24)

    assert sorted(r2_uploader.list_objects_older_than(cutoff, 2000)) == sorted(keys)
    assert len(r2_uploader.list_objects_older_than(cutoff, 1500)) == 1001
    assert len(r2_uploader.list_objects_older_than(cutoff, 5)) == 5
    assert r2_uploader.list_objects_older_than(datetime.now(UTC) - timedelta(hours=48), 2000) == []


# ------------------------------------------------- a failing delete must not look done


def _inject_delete_failure(monkeypatch, r2: RealR2, doomed: str) -> dict:
    """Make the REAL boto3 client's `delete_object` raise for keys ending `doomed`.

    The patch sits on the exact client instance `r2_uploader._r2()` returns, so
    `delete_prefix` runs unmodified and meets a genuine botocore `ClientError`.
    """
    state = {"on": True, "hits": 0}
    real = r2.client.delete_object

    def flaky(**kwargs):
        if state["on"] and kwargs["Key"].endswith(doomed):
            state["hits"] += 1
            raise ClientError(
                {
                    "Error": {"Code": "InternalError", "Message": "injected by the test"},
                    "ResponseMetadata": {"HTTPStatusCode": 500},
                },
                "DeleteObject",
            )
        return real(**kwargs)

    monkeypatch.setattr(r2.client, "delete_object", flaky)
    return state


def test_delete_prefix_raises_when_one_delete_fails_and_does_not_report_success(r2, monkeypatch):
    """Kills: `delete_prefix` swallowing `delete_object` errors. It documents that it
    raises so its caller keeps the DB row; a version that returns a count instead lets the
    caller believe the job is gone."""
    from worker.storage import r2_uploader

    job = str(uuid.uuid4())
    keys = [f"{job}/s/{i}.wav" for i in range(5)]
    _put_many(r2, keys)
    state = _inject_delete_failure(monkeypatch, r2, "/2.wav")

    with pytest.raises(ClientError):
        r2_uploader.delete_prefix(f"{job}/")

    assert state["hits"] == 1
    assert f"{job}/s/2.wav" in r2.all_keys(), "the key whose delete failed must still exist"


def test_a_failed_r2_delete_keeps_the_expired_jobs_row_so_the_next_sweep_retries(
    r2, tmp_path, monkeypatch
):
    async def scenario():
        expired = _insert_job(25)
        shapes = job_footprint(expired, str(tmp_path))
        _age_all(r2, shapes, 1.0)
        doomed = f"{expired}/bass/intro_0010.wav"
        assert doomed in shapes.values(), "fixture: the key we make fail is one of the seven"
        state = _inject_delete_failure(monkeypatch, r2, "/bass/intro_0010.wav")

        await cleanup.sweep_expired()

        assert state["hits"] == 1
        assert _row(expired) is not None, "the row was deleted although an R2 delete failed"
        assert expired in cleanup._failed, "the failure must be recorded for backoff"
        assert doomed in r2.all_keys(), "the object whose delete failed has vanished?"

        state["on"] = False
        cleanup._failed.clear()  # stand-in for the 15-minute backoff elapsing
        await cleanup.sweep_expired()
        assert _row(expired) is None, "the retry did not delete the row"
        assert not _survivors(r2, shapes, skip=(CHORDS_SHAPE,)), "the retry left objects behind"

    asyncio.run(scenario())


def test_a_failed_r2_delete_never_anonymises_a_credit_charged_shell(
    r2, tmp_path, ledger_user, monkeypatch
):
    """The case that cannot be repaired afterwards: once a ledger-bound job is anonymised
    its row is never re-selected, and the orphan pass sees a live row, so an object whose
    delete was swallowed is never revisited. The shell must stay un-anonymised until every
    delete has succeeded."""

    async def scenario():
        charged = _insert_job(26, user_id=ledger_user, charged=True)
        shapes = job_footprint(charged, str(tmp_path))
        _age_all(r2, shapes, 25.0)
        state = _inject_delete_failure(monkeypatch, r2, "/bass/intro_0010.wav")

        await cleanup.sweep_expired()

        assert state["hits"] == 1
        row = _row(charged)
        assert row is not None and row[0] != cleanup.PURGED_MARKER, (
            "a shell was anonymised after an R2 delete failed: the failed object is now "
            "unreachable by every later sweep"
        )
        assert row[1] == "My Title", "the shell lost its title although R2 still holds its audio"

        state["on"] = False
        cleanup._failed.clear()
        await cleanup.sweep_expired()
        row = _row(charged)
        assert row is not None and row[0] == cleanup.PURGED_MARKER
        assert not _survivors(r2, shapes, skip=(CHORDS_SHAPE,))

    asyncio.run(scenario())
