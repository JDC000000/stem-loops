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
"""

from __future__ import annotations

import asyncio
import os
import uuid

import psycopg
import pytest

from tests.real_r2 import CHORDS_SHAPE, RealR2, job_footprint
from worker import cleanup

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")

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


@pytest.mark.xfail(
    strict=False,
    reason="shape 7 (jobs/<id>/play.chords.json) is not under `<id>/`, so main's per-job "
    "delete misses it until the age-based orphan pass reaches it. PR #214 fixes this; "
    "delete this marker when it lands.",
)
def test_expired_job_loses_its_chords_object_even_when_young(r2, tmp_path):
    async def scenario():
        expired = _insert_job(25)
        shapes = job_footprint(expired, str(tmp_path))
        _age_all(r2, shapes, 1.0)
        await cleanup.sweep_expired()
        assert shapes[CHORDS_SHAPE] not in r2.all_keys()

    asyncio.run(scenario())


@pytest.fixture
def ledger_user():
    if not any(h in (DB or "") for h in ("127.0.0.1", "localhost")):
        pytest.skip("inserts into auth.users; local throwaway DB only")

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
