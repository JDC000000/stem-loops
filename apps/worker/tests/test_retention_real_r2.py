"""The 24-hour deletion promise, driven through the REAL R2 deleters.

`test_cleanup.py` swaps `delete_prefix`, `list_objects_older_than` and `delete_objects`
for an in-memory fake, so `r2_uploader`'s boto3 deleters ran in no test. Here
`cleanup.sweep_expired()` runs against a real S3 server (moto, over HTTP, see
`tests/real_r2.py`).

WHAT IS NOT THE PRODUCTION PATH. This list has been wrong twice, so read its
history before trusting it. Round 2 said "NOTHING in `cleanup` patched" while its fixture
patched `cleanup.DATABASE_URL`, which hid a mutant that made every sweep fail to connect.
Round 3 replaced that with "WHAT IS STUBBED, exhaustively ... The complete list" and then
omitted the caller, the proxy and region environment, `_r2.cache_clear()`, the back-dating
through moto's internals, and named a fixture (`_backoff_clock`) that does not exist while
saying "TWO" retry tests for the three that use it. No list in a docstring can be made
correct by assertion, so this one is enumerated by reading every `setattr`, `setenv`,
`delenv`, assignment and `cache_clear` in this file and `tests/real_r2.py`, and the claims
that matter are held by mutants instead: `tests/mutation/manifest.py` lists each one with the
test that must kill it, and `tests/mutation/run_mutants.py` runs them.

  * THE CALLER. Every test here calls `cleanup.sweep_expired()` itself. `main.serve()` and
    `consumer.poll_loop()` are not involved in this file (the poll_loop chain is the last test
    in `test_consumer_sweep_wiring.py`).
  * the process environment, set through `monkeypatch` by `RealR2` and restored on exit:
    `R2_ENDPOINT_URL` (a loopback moto server), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
    ("testing"), `R2_BUCKET_NAME`, `AWS_DEFAULT_REGION=us-east-1`; the six proxy variables
    are deleted and `NO_PROXY` / `no_proxy` set to `*` (the sandbox routes HTTP through a
    proxy that a loopback server must bypass). `DATABASE_URL` is whatever the run was started
    with, and must be LOCAL (`real_r2.require_database`). `cleanup.DATABASE_URL` itself is NOT
    patched; it is the value `cleanup.py` read from that variable at import.
  * `r2_uploader._r2.cache_clear()`, on entering and leaving `RealR2`. `_r2` caches its boto3
    client; production never clears it.
  * moto's in-process backend. S3 has no API to back-date an object, so `RealR2.age_many`
    assigns `s3_backends[...].buckets[BUCKET].keys[key].last_modified` directly and then
    reads every age back through the real list call; `POST /moto-api/reset` empties the
    bucket before each test.
  * `cleanup.time`, replaced by a `SimpleNamespace` whose only attribute is `monotonic`
    (the real clock plus an offset the test advances), so the 15-minute backoff can elapse
    in zero real seconds. It is replaced in the FOUR tests that request the `backoff_clock`
    fixture (the three retry tests and the anonymise-path test), through that fixture.
    `cleanup` uses `time` only for the sweep's budget deadline and the backoff.
  * `cleanup._failed.clear()`, before and after every test that uses the `r2` fixture. It is
    module-state reset, not a stub, and no test uses it to simulate time passing.
  * the fault-injection tests wrap `delete_object` / `delete_objects` on the exact boto3
    client instance `r2_uploader._r2()` returns (`_inject_delete_failure`); everything
    else on that client, and all of `delete_prefix` / `delete_objects`, is the production
    code, meeting a real `ClientError`.
  * `tmpdirs.WORK_ROOT`, pointed at a temp dir in the one test about scratch dirs;
    elsewhere `sweep_expired` scans the machine's real scratch root, as in production.
    `tmpdirs.sweep_stale` is real everywhere in this file.
  * SEEDING. Job rows are inserted with SQL, not through any API, and the key shapes the
    worker has no function for (1 and 3) and shape 2's tracked key are literals typed in
    `real_r2.job_footprint`.

Three properties make these tests able to fail, and each is deliberate:

  * EVERY KEY SHAPE is seeded for every job (the seven in `real_r2.job_footprint`),
    where the fake-backed tests seed `_input.*` and one loop and never a stem.
  * Objects that must be deleted by the PER-JOB delete are seeded YOUNGER than 24 h.
    The age-based orphan pass only deletes objects older than the retention window
    whose job row is gone, so with old objects it silently repairs a broken per-job
    delete and the test cannot tell. (A credit-charged job's shell row is never
    deleted, so the orphan pass can NEVER repair it -- see the ledger test.)
  * A live job's seven objects are asserted to SURVIVE, so "delete everything" is not
    a passing implementation either. That job's id differs from the expired one's in its
    last hex digit only (`NEIGHBOUR_ID`), so a delete prefix cut short at any length is not
    one either.

Shape 7 (`jobs/<id>/play.chords.json`) is the one the per-job delete misses until PR #214
adds `r2_uploader.job_object_prefixes`. It is handled by `assert_chords_gone_or_xfail`,
called LAST in a test after shapes 1-6 were asserted gone with plain `assert`s: it xfails
only while that function is absent and FAILS once it exists. There is deliberately no
`xfail` marker; that function's docstring says what the marker hid. MERGE OBLIGATION: whichever
of PR #214 and this PR lands second deletes that xfail branch (see `assert_chords_gone_or_xfail`
for why the probe cannot be made rename-proof).
"""

from __future__ import annotations

import asyncio
import os
import time
import types
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
)
from worker import cleanup


@pytest.fixture(autouse=True)
def _database():
    # A developer with no database gets a clean skip; under CI=true a missing database is
    # a FAILURE, because a skipped retention gate is a gate that did not run. A database
    # that is not LOCAL is refused the same way (see `require_database`): these tests run
    # the real destructive sweep.
    require_database()


def _connect():
    """EVERY connection in this file is opened here, so none can bypass the locality guard."""
    return psycopg.connect(require_database())


LEDGER_EMAIL = "test-retention-real-r2-%@example.com"


@pytest.fixture
def r2(monkeypatch):
    cleanup._failed.clear()
    with RealR2(monkeypatch) as server:
        yield server
    cleanup._failed.clear()


def _insert_job(
    age_hours: float, status: str = "done", user_id=None, charged=False, job_id=None
) -> str:
    """A job `age_hours` old. `charged` makes it an upload job with a credit_consumption
    row (the ledger refuses a charge against any other input_kind). `job_id` pins the id
    (default: random); a pinned id is deleted first so the helper can be re-run on one
    database."""
    job_id = job_id or str(uuid.uuid4())
    with _connect() as c:
        c.execute("DELETE FROM public.jobs WHERE id = %s", (job_id,))
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
    with _connect() as c:
        return c.execute(
            "SELECT client_ip_hash, title FROM public.jobs WHERE id=%s", (job_id,)
        ).fetchone()


def _age_all(r2: RealR2, shapes: dict[str, str], hours: float) -> None:
    for key in shapes.values():
        r2.age(key, hours)


def _survivors(r2: RealR2, shapes: dict[str, str], *, skip: tuple[str, ...] = ()) -> list[str]:
    left = r2.all_keys()
    return [name for name, key in shapes.items() if key in left and name not in skip]


# A live job whose id differs from the expired one's in its LAST hex digit only. The expired
# job's delete prefix is "<EXPIRED>/", so any truncation of that prefix to 1..35 characters
# also matches every one of the live job's keys. With two random uuid4s, `Prefix=prefix[:2]`
# survived the full suite (it matches 1/256 of the other jobs' audio per swept job) and
# `prefix[:1]` was a coin flip on the 1-in-16 chance the first digits agreed (round 3's
# reviewer, 4 runs: killed once). The pair is deterministic so the outcome cannot depend on it.
EXPIRED_ID = "5eeded00-0000-4000-8000-00000000000a"
NEIGHBOUR_ID = "5eeded00-0000-4000-8000-00000000000b"
assert EXPIRED_ID[:-1] == NEIGHBOUR_ID[:-1] and EXPIRED_ID != NEIGHBOUR_ID


def test_expired_job_loses_every_prefixed_shape_even_when_its_objects_are_young(r2, tmp_path):
    """The per-job delete itself, with the age backstop unable to help.

    Kills: `delete_prefix` deleting nothing; the sweep deleting only `<id>/_input*`; the
    delete prefix truncated to ANY length from 1 to 35 characters (`Prefix=prefix[:1]`,
    `[:2]`, `[:4]`, `[:8]`: each deletes a live neighbour's audio). Only dropping the
    trailing slash (`prefix[:36]`, i.e. `<id>` with no `/`) is equivalent here: no other
    uuid starts with these 36 characters.
    The job expired an hour ago but its objects are 1 h old (an on-demand cut, or a
    separation that finished late), so the orphan pass -- which needs > 24 h -- is inert.
    The live job is the DETERMINISTIC `NEIGHBOUR_ID`, one hex digit from the expired one.
    """

    async def scenario():
        expired = _insert_job(25, job_id=EXPIRED_ID)
        live = _insert_job(1, job_id=NEIGHBOUR_ID)
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
    """Shapes 1-6 are asserted gone HARD. The chords key may xfail only while PR #214's
    `job_object_prefixes` is absent; once it exists a surviving chords key FAILS."""

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
    require_database()  # also inserts into auth.users: local databases only

    def purge(c):
        c.rollback()
        like = "(SELECT id FROM public.users WHERE email LIKE %s)"
        c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {like}", (LEDGER_EMAIL,))
        c.execute(f"DELETE FROM public.jobs WHERE user_id IN {like}", (LEDGER_EMAIL,))
        c.execute("DELETE FROM public.users WHERE email LIKE %s", (LEDGER_EMAIL,))
        c.execute("DELETE FROM auth.users WHERE email LIKE %s", (LEDGER_EMAIL,))
        c.commit()

    uid = uuid.uuid4()
    with _connect() as c:
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
    """Shapes 1-6 are asserted gone HARD. The chords key may xfail only while PR #214's
    `job_object_prefixes` is absent; once it exists a surviving chords key FAILS.

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

    THE GRACE IS BRACKETED, not merely bounded: an in-flight job 55 minutes past expiry is
    kept and one 65 minutes past is swept, so any grace outside (55, 65) minutes dies.
    Round 2 had only 30 min (kept) and 120 min (swept), so `expires_at < now() - interval
    '25 minutes'`-style mutants with a grace anywhere in 30..120 minutes could not be told
    from the real 1 hour.
    """

    async def scenario():
        failed = _insert_job(24.5, status="failed")
        done = _insert_job(24.5, status="done")
        inflight_fresh = _insert_job(24.5, status="separating")  # 30 min past: inside the grace
        inflight_stale = _insert_job(26, status="separating")  # 2 h past: outside it
        inflight_55 = _insert_job(24 + 55 / 60, status="separating")  # 55 min past: inside
        inflight_65 = _insert_job(24 + 65 / 60, status="separating")  # 65 min past: outside
        footprints = {}
        for name, jid in (
            ("failed", failed),
            ("done", done),
            ("inflight_fresh", inflight_fresh),
            ("inflight_stale", inflight_stale),
            ("inflight_55", inflight_55),
            ("inflight_65", inflight_65),
        ):
            footprints[name] = job_footprint(jid, str(tmp_path))
            _age_all(r2, footprints[name], 1.0)  # the age backstop cannot help

        res = await cleanup.sweep_expired()

        assert res["jobs"] >= 4, f"expected failed, done and both stale in-flight swept: {res}"
        for name, jid in (
            ("failed", failed),
            ("done", done),
            ("inflight_stale", inflight_stale),
            ("inflight_65", inflight_65),
        ):
            assert _row(jid) is None, f"the {name} job's row must be deleted"
            left = _survivors(r2, footprints[name], skip=(CHORDS_SHAPE,))
            assert not left, f"the {name} job's objects survived the sweep: {left}"
        for name, jid in (("inflight_fresh", inflight_fresh), ("inflight_55", inflight_55)):
            assert _row(jid) is not None, f"the {name} job, inside the grace, was deleted"
            assert {k for k in r2.all_keys() if jid in k} == set(
                footprints[name].values()
            ), f"the {name} job, inside the grace, lost objects"

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
    """Make the REAL boto3 client's delete raise for keys ending `doomed`.

    Both S3 delete spellings are covered, so a correct refactor between them is not a false
    red: the single-object `delete_object(Key=...)` and the batch
    `delete_objects(Delete={"Objects": [{"Key": ...}]})` (a batch fails as a whole when any
    key in it is doomed). The patch sits on the exact client instance `r2_uploader._r2()`
    returns, so `delete_prefix` / `delete_objects` run unmodified and meet a genuine
    botocore `ClientError`. `hits` counts the calls that raised. A refactor to some third
    API (the `boto3.resource` bucket helpers, say) would never be hit; `assert_hit` then
    says so, instead of reporting a product bug.
    """
    state = {"on": True, "hits": 0}
    real_one, real_many = r2.client.delete_object, r2.client.delete_objects

    def boom(op: str):
        state["hits"] += 1
        raise ClientError(
            {
                "Error": {"Code": "InternalError", "Message": "injected by the test"},
                "ResponseMetadata": {"HTTPStatusCode": 500},
            },
            op,
        )

    def flaky_one(**kwargs):
        if state["on"] and kwargs["Key"].endswith(doomed):
            boom("DeleteObject")
        return real_one(**kwargs)

    def flaky_many(**kwargs):
        if state["on"] and any(o["Key"].endswith(doomed) for o in kwargs["Delete"]["Objects"]):
            boom("DeleteObjects")
        return real_many(**kwargs)

    monkeypatch.setattr(r2.client, "delete_object", flaky_one)
    monkeypatch.setattr(r2.client, "delete_objects", flaky_many)
    return state


def assert_hit(state: dict) -> None:
    assert state["hits"] == 1, (
        f"the injected R2 failure was hit {state['hits']} times, expected 1. If 0: the code "
        "under test no longer deletes through client.delete_object / client.delete_objects, "
        "so this injection is not reaching it -- extend _inject_delete_failure to the new "
        "call rather than reading this as a product bug."
    )


class _BackoffClock:
    """`cleanup.time` for the retry tests: the real monotonic clock plus a settable offset."""

    def __init__(self):
        self.offset = 0.0

    def monotonic(self) -> float:
        return time.monotonic() + self.offset

    def advance(self, seconds: float) -> None:
        self.offset += seconds


@pytest.fixture
def backoff_clock(monkeypatch) -> _BackoffClock:
    """Replace ONLY `cleanup.time` (not the process-wide `time` module: asyncio reads that)."""
    clock = _BackoffClock()
    monkeypatch.setattr(cleanup, "time", types.SimpleNamespace(monotonic=clock.monotonic))
    return clock


# The first failure backs a job off for 900 s (`cleanup._backoff_seconds(1)`). Literals, on
# purpose: reading them back out of the code under test would agree with any backoff.
FIRST_BACKOFF_SEC = 900


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

    assert_hit(state)
    assert f"{job}/s/2.wav" in r2.all_keys(), "the key whose delete failed must still exist"


def test_a_failed_r2_delete_keeps_the_expired_jobs_row_and_is_retried_after_the_backoff(
    r2, tmp_path, monkeypatch, backoff_clock
):
    """The retry is EXECUTED: the job is left alone for the whole 900 s backoff, then retried.

    Kills: a backoff that never elapses (`_backoff_seconds` returning `inf`: the failed job
    is skipped for ever and its audio outlives the 24 h promise -- measured against round
    2's `_failed.clear()` stand-in, full suite unchanged); a backoff of zero (the stuck job
    is retried on every sweep and hogs the batch).
    """

    async def scenario():
        expired = _insert_job(25)
        shapes = job_footprint(expired, str(tmp_path))
        _age_all(r2, shapes, 1.0)
        doomed = f"{expired}/bass/intro_0010.wav"
        assert doomed in shapes.values(), "fixture: the key we make fail is one of the seven"
        state = _inject_delete_failure(monkeypatch, r2, "/bass/intro_0010.wav")

        await cleanup.sweep_expired()

        assert_hit(state)
        assert _row(expired) is not None, "the row was deleted although an R2 delete failed"
        assert expired in cleanup._failed, "the failure must be recorded for backoff"
        assert doomed in r2.all_keys(), "the object whose delete failed has vanished?"

        # Inside the backoff the job must not be touched. The injection is STILL ON, so an
        # early retry would hit it a second time.
        backoff_clock.advance(FIRST_BACKOFF_SEC - 1)
        await cleanup.sweep_expired()
        assert state["hits"] == 1, (
            f"the job was retried {FIRST_BACKOFF_SEC - 1}s after its first failure, inside "
            f"the {FIRST_BACKOFF_SEC}s backoff (delete attempts that failed: {state['hits']})"
        )

        # The backoff elapses and R2 is healthy again: the SAME job is retried and swept.
        state["on"] = False
        backoff_clock.advance(2)
        await cleanup.sweep_expired()
        assert _row(expired) is None, (
            f"the job was not retried {FIRST_BACKOFF_SEC + 1}s after its failure although R2 "
            "is healthy again: a failed delete is never retried"
        )
        assert not _survivors(r2, shapes, skip=(CHORDS_SHAPE,)), "the retry left objects behind"

    asyncio.run(scenario())


def test_a_failed_r2_delete_never_anonymises_a_credit_charged_shell(
    r2, tmp_path, ledger_user, monkeypatch, backoff_clock
):
    """The case that cannot be repaired afterwards: once a ledger-bound job is anonymised
    its row is never re-selected, and the orphan pass sees a live row, so an object whose
    delete was swallowed is never revisited. The shell must stay un-anonymised until every
    delete has succeeded, and it must be retried once the backoff elapses."""

    async def scenario():
        charged = _insert_job(26, user_id=ledger_user, charged=True)
        shapes = job_footprint(charged, str(tmp_path))
        _age_all(r2, shapes, 25.0)
        state = _inject_delete_failure(monkeypatch, r2, "/bass/intro_0010.wav")

        await cleanup.sweep_expired()

        assert_hit(state)
        row = _row(charged)
        assert row is not None and row[0] != cleanup.PURGED_MARKER, (
            "a shell was anonymised after an R2 delete failed: the failed object is now "
            "unreachable by every later sweep"
        )
        assert row[1] == "My Title", "the shell lost its title although R2 still holds its audio"

        state["on"] = False
        backoff_clock.advance(FIRST_BACKOFF_SEC + 1)
        await cleanup.sweep_expired()
        row = _row(charged)
        assert row is not None and row[0] == cleanup.PURGED_MARKER
        assert not _survivors(r2, shapes, skip=(CHORDS_SHAPE,))

    asyncio.run(scenario())


def test_repeated_failures_back_off_exponentially_then_report_stuck_and_clear_on_success(
    r2, tmp_path, monkeypatch, backoff_clock, capsys
):
    """Four consecutive failures, each interval pinned from BOTH sides: 900 s, 1800 s,
    3600 s, 7200 s. The third consecutive failure is `stuck`; the fourth is retried like
    the others; success forgets the job.

    Every interval is bracketed (nothing happens `interval - 1` s after the failure, a retry
    happens `interval + 1` s after it), so no backoff is pinned only from one side.
    Kills: removing `_failed.pop` on the DELETE path (the job stays counted as `stuck` for
    the life of the process -- measured on round 2: full suite unchanged); a backoff that
    does not double; a third backoff of 1800 s (`MAX_BACKOFF_SECONDS = 1800`, or an exponent
    capped at 1; both survived round 3, which stopped at the third failure); a backoff
    that becomes infinite after the third failure (`_backoff_seconds` returning `inf` for
    `failures > 3`: an R2 outage lasting four attempts, 1 h 45 m, would skip the job until
    the process restarts); a skip list that permanently includes any job with more than
    three failures; `_record_failure` never escalating to `retention_r2_delete_stuck`.
    """

    async def scenario():
        expired = _insert_job(25)
        shapes = job_footprint(expired, str(tmp_path))
        _age_all(r2, shapes, 1.0)
        state = _inject_delete_failure(monkeypatch, r2, "/bass/intro_0010.wav")

        res = await cleanup.sweep_expired()  # failure 1, now backed off for 900 s
        assert state["hits"] == 1 and cleanup._failed[expired][0] == 1 and res["stuck"] == 0

        backoff_clock.advance(FIRST_BACKOFF_SEC + 1)
        res = await cleanup.sweep_expired()  # failure 2, now backed off for 1800 s
        assert state["hits"] == 2 and cleanup._failed[expired][0] == 2 and res["stuck"] == 0

        backoff_clock.advance(2 * FIRST_BACKOFF_SEC - 1)
        await cleanup.sweep_expired()
        assert state["hits"] == 2, "retried inside the second (1800 s) backoff"

        backoff_clock.advance(2)
        capsys.readouterr()
        res = await cleanup.sweep_expired()  # failure 3, now backed off for 3600 s
        assert state["hits"] == 3 and cleanup._failed[expired][0] == 3
        assert res["stuck"] == 1, f"three consecutive failures must count as stuck: {res}"
        assert "retention_r2_delete_stuck" in capsys.readouterr().err

        backoff_clock.advance(4 * FIRST_BACKOFF_SEC - 1)
        await cleanup.sweep_expired()
        assert state["hits"] == 3, "retried inside the third (3600 s) backoff"

        backoff_clock.advance(2)
        res = await cleanup.sweep_expired()  # failure 4, now backed off for 7200 s
        assert state["hits"] == 4 and cleanup._failed[expired][0] == 4, (
            f"not retried {4 * FIRST_BACKOFF_SEC + 1}s after the third failure: the third "
            f"backoff is shorter or longer than 3600 s (delete attempts that failed: {state['hits']})"
        )
        assert res["stuck"] == 1

        backoff_clock.advance(8 * FIRST_BACKOFF_SEC - 1)
        await cleanup.sweep_expired()
        assert state["hits"] == 4, "retried inside the fourth (7200 s) backoff"

        # R2 is healthy again and the fourth interval has elapsed: a job that has failed more
        # than three times must still be retried, or its audio outlives the promise for good.
        state["on"] = False
        backoff_clock.advance(2)
        res = await cleanup.sweep_expired()
        assert _row(expired) is None and res["jobs"] == 1, (
            "a job that failed four times was never retried after its fourth backoff: it is "
            f"skipped for ever (sweep result {res})"
        )
        assert res["stuck"] == 0, f"a job that finally succeeded is still counted stuck: {res}"
        assert expired not in cleanup._failed

    asyncio.run(scenario())


def test_a_credit_charged_shell_that_finally_succeeds_is_forgotten_not_counted_stuck(
    r2, tmp_path, ledger_user, monkeypatch, backoff_clock
):
    """The ANONYMISE path's own `_failed.pop` (the delete path has another, covered by the
    test above). A ledger-bound job that failed three times and is then anonymised must stop
    being counted `stuck`; without the pop it is reported stuck until the process restarts,
    although its audio is gone and its shell is done.

    Kills: removing `_failed.pop(job_id, None)` after `_anonymise_job`.
    """

    async def scenario():
        charged = _insert_job(26, user_id=ledger_user, charged=True)
        shapes = job_footprint(charged, str(tmp_path))
        _age_all(r2, shapes, 25.0)
        state = _inject_delete_failure(monkeypatch, r2, "/bass/intro_0010.wav")

        for hits, wait in enumerate((0, FIRST_BACKOFF_SEC + 1, 2 * FIRST_BACKOFF_SEC + 1), 1):
            backoff_clock.advance(wait)
            res = await cleanup.sweep_expired()
            assert state["hits"] == hits
        assert res["stuck"] == 1 and cleanup._failed[charged][0] == 3, "fixture: stuck"

        state["on"] = False
        backoff_clock.advance(4 * FIRST_BACKOFF_SEC + 1)
        res = await cleanup.sweep_expired()

        row = _row(charged)
        assert row is not None and row[0] == cleanup.PURGED_MARKER, "must be an anonymised shell"
        assert res["anonymised"] == 1
        assert res["stuck"] == 0, f"an anonymised shell is still counted stuck: {res}"
        assert charged not in cleanup._failed

    asyncio.run(scenario())


def test_the_sweep_removes_stale_scratch_dirs_of_user_audio(r2, monkeypatch, tmp_path):
    """`sweep_expired`'s own call to `tmpdirs.sweep_stale`, with the real function.

    Kills: deleting that call from `cleanup.sweep_expired` (measured on round 2: the
    consumer tests stub `tmpdirs.sweep_stale` for the whole module and nothing else
    reaches it, so the full suite stayed green). Stubbed here: `tmpdirs.WORK_ROOT`, pointed
    at a temp dir.
    """
    from worker import tmpdirs

    root = tmp_path / "work"
    stale, fresh = root / "sl_crashed", root / "sl_running"
    for d in (stale, fresh):
        d.mkdir(parents=True)
        (d / "audio.wav").write_bytes(b"x")
    long_ago = time.time() - 25 * 3600
    os.utime(stale, (long_ago, long_ago))
    monkeypatch.setattr(tmpdirs, "WORK_ROOT", str(root))

    asyncio.run(cleanup.sweep_expired())

    assert not stale.exists(), "sweep_expired left a 25 h-old scratch dir of user audio"
    assert fresh.exists(), "sweep_expired removed a scratch dir younger than the window"


# ------------------------------------------- a failing ORPHAN delete must not look done


def test_delete_objects_raises_when_one_delete_fails_and_does_not_report_success(r2, monkeypatch):
    """The orphan backstop's deleter, which `delete_prefix`'s fault tests do not touch.

    Kills: `delete_objects` swallowing `delete_object` errors and returning `len(keys)`.
    """
    from worker.storage import r2_uploader

    keys = [f"{uuid.uuid4()}/_input.mp3" for _ in range(3)]
    _put_many(r2, keys)
    doomed = sorted(keys)[1]
    state = _inject_delete_failure(monkeypatch, r2, doomed)

    with pytest.raises(ClientError):
        r2_uploader.delete_objects(keys)

    assert_hit(state)
    assert doomed in r2.all_keys(), "the key whose delete failed must still exist"


def test_a_failed_orphan_delete_is_logged_and_never_counted_then_retried_next_sweep(
    r2, monkeypatch, capsys
):
    """Through `sweep_expired`: the orphan pass is stateless, so a persistent failure is
    visible ONLY as the `retention_orphan_sweep_failed` log line and a count that does not
    claim the object. A deleter that swallows the error removes both signals while the
    audio stays in the bucket.

    Kills: `delete_objects` swallowing errors (measured on round 2: orphan_objects=1, the
    object still in the bucket, no error log, full suite unchanged).
    """
    orphan_key = f"{uuid.uuid4()}/_input.mp3"
    r2.put(orphan_key, 26)  # past the retention window, no job row
    state = _inject_delete_failure(monkeypatch, r2, "/_input.mp3")
    capsys.readouterr()

    res = asyncio.run(cleanup.sweep_expired())

    assert_hit(state)
    assert orphan_key in r2.all_keys(), "fixture: the failing delete must leave the object"
    assert res["orphan_objects"] == 0, (
        f"the sweep reported {res['orphan_objects']} orphan objects deleted although the "
        "only orphan is still in the bucket"
    )
    assert "retention_orphan_sweep_failed" in capsys.readouterr().err, (
        "an orphan delete failed and nothing was logged: a persistent R2 failure is now "
        "invisible"
    )

    state["on"] = False
    res = asyncio.run(cleanup.sweep_expired())
    assert res["orphan_objects"] == 1
    assert orphan_key not in r2.all_keys(), "the next sweep did not retry the orphan"
