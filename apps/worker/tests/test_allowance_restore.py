"""A link job that fails for OUR reasons gives back what it spent, exactly once (QA-64).

A signed-in YouTube-link job spends no credit. It spends one unit of the monthly allowance
(entitlements.jobs_used; Free 5/month, Pro, Studio) and, on the free trial path, also a trial
song (trial_grants.songs_used). The web route records exactly that in job_allowance_debits
(migration 042) in the jobs-INSERT transaction; this suite plays the web's part with the same
INSERT and pins the worker's:

  1. our-fault codes (job_failure.OUR_FAULT_CODES, incl. FETCH_PROXY_FAILED) give the unit
     back, through every failure path (pipeline._fail / consumer.mark_failed / the reaper);
  2. user-fault codes (DOWNLOAD_BLOCKED, DOWNLOAD_TIMEOUT, DOWNLOAD_PRIVATE, ...) do not, and
     a later our-fault attempt on the same job cannot turn one into a restore;
  3. exactly once: repeated failure paths, a reaper rerun and CONCURRENT callers on separate
     connections restore at most one unit;
  4. never below zero, and only in the period it was spent in: after a month rollover the new
     month is not credited;
  5. the trial path gives back the trial song AND the allowance unit; an expired trial does
     not get a song;
  6. the "didn't count" sentence is appended to the stored message only when it is true;
  7. a database without migration 042's function leaves the failure (and credit refund)
     working, with nothing restored.

Local throwaway DB only (INSERTs into auth.users). Runs in CI; never against a shared DB.
"""

from __future__ import annotations

import asyncio
import os
import threading
import uuid

import psycopg
import pytest

from worker import consumer, job_failure, pipeline, reaper
from worker.job_failure import (
    ALLOWANCE_RETURNED_SENTENCE,
    OUR_FAULT_CODES,
    TRIAL_RETURNED_SENTENCE,
)

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="INSERTs into auth.users; local throwaway DB only")

EMAIL_PREFIX = "test-allowance-restore-"
IP = "test-allowance-restore-ip"
MSG = "Something went wrong on our end fetching this video. Try again in a few minutes."
USER_FAULT_CODES = [
    "DOWNLOAD_BLOCKED",
    "DOWNLOAD_TIMEOUT",
    "DOWNLOAD_PRIVATE",
    "DOWNLOAD_AGE_RESTRICTED",
    "DOWNLOAD_INVALID_URL",
    "EXTRACTION_FAILED",
]


def _cleanup(c) -> None:
    c.rollback()
    c.execute("DELETE FROM public.jobs WHERE client_ip_hash = %s", (IP,))
    c.execute(f"DELETE FROM auth.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.commit()


@pytest.fixture
def conn(monkeypatch):
    for mod in (consumer, reaper, pipeline):
        monkeypatch.setattr(mod, "DATABASE_URL", DB)
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


@pytest.fixture(autouse=True)
def _no_restart(monkeypatch):
    monkeypatch.setattr(consumer, "_restart_process", lambda: None)


def _user(c, *, jobs_used: int = 0, trial_songs_used: int | None = None) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email) VALUES (%s, %s)",
        (uid, f"{EMAIL_PREFIX}{uid.hex[:8]}@example.test"),
    )
    c.execute(
        "INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end, jobs_used)"
        " VALUES (%s, 'free', date_trunc('month', now()),"
        "         date_trunc('month', now()) + interval '1 month', %s)"
        " ON CONFLICT (user_id) DO UPDATE SET period_start = EXCLUDED.period_start,"
        "   period_end = EXCLUDED.period_end, jobs_used = EXCLUDED.jobs_used",
        (uid, jobs_used),
    )
    if trial_songs_used is not None:
        c.execute(
            "INSERT INTO public.trial_grants (user_id, songs_used) VALUES (%s, %s)",
            (uid, trial_songs_used),
        )
    c.commit()
    return uid


def _link_job(
    c,
    uid: uuid.UUID,
    *,
    status: str = "downloading",
    trial: bool = False,
    record: bool = True,
    attempts: int = 0,
    stale_s: int = 0,
) -> uuid.UUID:
    """What POST /api/jobs does for a signed-in link job: insert, spend, record (one tx)."""
    jid = uuid.uuid4()
    c.execute(
        "INSERT INTO public.jobs (id, youtube_url, status, user_id, loop_length_bars,"
        " requested_stems, client_ip_hash, attempts, updated_at)"
        " VALUES (%s, 'https://youtu.be/dQw4w9WgXcQ', %s, %s, 4, ARRAY['drums'], %s, %s,"
        "         now() - (%s * interval '1 second'))",
        (jid, status, uid, IP, attempts, stale_s),
    )
    if trial:
        c.execute(
            "UPDATE public.trial_grants SET songs_used = songs_used + 1 WHERE user_id = %s",
            (uid,),
        )
    c.execute("UPDATE public.entitlements SET jobs_used = jobs_used + 1 WHERE user_id = %s", (uid,))
    if record:
        # The same statement as lib/billing/rate-limit.ts recordAllowanceDebit().
        c.execute(
            "INSERT INTO public.job_allowance_debits"
            " (job_id, user_id, allowance_period_start, trial_song)"
            " VALUES (%s, %s, (SELECT period_start FROM public.entitlements WHERE user_id = %s),"
            "         %s)"
            " ON CONFLICT (job_id) DO NOTHING",
            (jid, uid, uid, trial),
        )
    c.commit()
    return jid


def _used(c, uid) -> int:
    c.commit()
    return c.execute(
        "SELECT jobs_used FROM public.entitlements WHERE user_id = %s", (uid,)
    ).fetchone()[0]


def _songs(c, uid) -> int:
    c.commit()
    return c.execute(
        "SELECT songs_used FROM public.trial_grants WHERE user_id = %s", (uid,)
    ).fetchone()[0]


def _job(c, jid) -> tuple:
    c.commit()
    return c.execute(
        "SELECT status, error_code, error_message_user FROM jobs WHERE id = %s", (jid,)
    ).fetchone()


def _debit(c, jid) -> tuple | None:
    c.commit()
    return c.execute(
        "SELECT restored_at IS NOT NULL, allowance_restored, trial_restored"
        " FROM public.job_allowance_debits WHERE job_id = %s",
        (jid,),
    ).fetchone()


def _fail(jid, code: str, msg: str = MSG) -> None:
    asyncio.run(pipeline._fail(str(jid), code, msg))


def _call_restore(conninfo: str, jid) -> list[tuple]:
    with psycopg.connect(conninfo) as c:
        rows = c.execute(
            "SELECT * FROM public.restore_job_allowance(%s::uuid, %s::text[])",
            (jid, list(OUR_FAULT_CODES)),
        ).fetchall()
        c.commit()
        return rows


# --------------------------------------------------------------------------- policy pins
def test_our_fault_codes_are_ours_and_no_download_code_is():
    assert "FETCH_PROXY_FAILED" in OUR_FAULT_CODES
    for code in USER_FAULT_CODES:
        assert code not in OUR_FAULT_CODES, code


# --------------------------------------------------------------------------- 1. our fault
@pytest.mark.parametrize("code", list(OUR_FAULT_CODES))
def test_our_fault_failure_gives_the_monthly_song_back(conn, code):
    uid = _user(conn, jobs_used=2)
    jid = _link_job(conn, uid)
    assert _used(conn, uid) == 3
    _fail(jid, code)
    assert _used(conn, uid) == 2, f"{code}: the monthly song this job used was not given back"
    assert _job(conn, jid) == ("failed", code, f"{MSG} {ALLOWANCE_RETURNED_SENTENCE}")
    assert _debit(conn, jid) == (True, True, False)


def test_consumer_mark_failed_restores_too(conn):
    uid = _user(conn)
    jid = _link_job(conn, uid)
    asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", MSG))
    assert _used(conn, uid) == 0
    assert _debit(conn, jid) == (True, True, False)


def test_reaper_poison_job_restores_once_in_the_same_savepoint(conn):
    uid = _user(conn)
    jid = _link_job(
        conn,
        uid,
        status="separating",
        attempts=reaper.MAX_ATTEMPTS,
        stale_s=reaper.STALE_SECONDS + 60,
    )
    assert asyncio.run(reaper.reap_stale_jobs())["failed"] >= 1
    status, code, message = _job(conn, jid)
    assert (status, code) == ("failed", "INTERNAL_ERROR")
    assert message.endswith(ALLOWANCE_RETURNED_SENTENCE)
    assert _used(conn, uid) == 0
    # A reaper rerun and the pipeline's own failure path on the same job give nothing more.
    asyncio.run(reaper.reap_stale_jobs())
    _fail(jid, "INTERNAL_ERROR")
    assert _used(conn, uid) == 0
    assert message.count(ALLOWANCE_RETURNED_SENTENCE) == 1
    assert _job(conn, jid)[2] == message, "the sentence is appended once"


def test_reaper_requeue_restores_nothing(conn):
    uid = _user(conn)
    jid = _link_job(conn, uid, status="extracting", attempts=0, stale_s=reaper.STALE_SECONDS + 60)
    asyncio.run(reaper.reap_stale_jobs())
    assert _job(conn, jid)[:2] == ("queued", None)
    assert _used(conn, uid) == 1
    assert _debit(conn, jid) == (False, None, None)


# --------------------------------------------------------------------------- 2. user fault
@pytest.mark.parametrize("code", USER_FAULT_CODES)
def test_user_fault_failure_is_not_given_back(conn, code):
    uid = _user(conn)
    jid = _link_job(conn, uid)
    _fail(jid, code, "That video is private.")
    assert _used(conn, uid) == 1
    assert _job(conn, jid) == ("failed", code, "That video is private.")
    assert _debit(conn, jid) == (False, None, None), "a user-fault failure leaves the row unclaimed"


def test_a_later_our_fault_attempt_cannot_turn_a_user_fault_failure_into_a_restore(conn):
    uid = _user(conn)
    jid = _link_job(conn, uid)
    _fail(jid, "DOWNLOAD_BLOCKED")
    _fail(jid, "INTERNAL_ERROR")  # the wall deadline landing late: first failure wins
    asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", MSG))
    assert _job(conn, jid)[1] == "DOWNLOAD_BLOCKED"
    assert _used(conn, uid) == 1


def test_a_job_still_running_is_never_restored(conn):
    uid = _user(conn)
    jid = _link_job(conn, uid, status="separating")
    assert _call_restore(DB, jid) == []
    assert _used(conn, uid) == 1


def test_a_job_with_no_debit_record_restores_nothing(conn):
    """Created before migration 042 + the web change, or anonymous: nothing to give back."""
    uid = _user(conn)
    jid = _link_job(conn, uid, record=False)
    _fail(jid, "FETCH_PROXY_FAILED")
    assert _used(conn, uid) == 1
    assert _job(conn, jid)[2] == MSG, "no sentence claims a song came back"


# --------------------------------------------------------------------------- 3. exactly once
def test_repeated_failure_paths_restore_once(conn):
    uid = _user(conn, jobs_used=3)
    jid = _link_job(conn, uid)
    for _ in range(3):
        _fail(jid, "SEPARATION_FAILED")
        asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", MSG))
    assert _used(conn, uid) == 3
    assert _job(conn, jid)[2].count(ALLOWANCE_RETURNED_SENTENCE) == 1


def test_concurrent_restores_on_separate_connections_give_back_one_unit(conn):
    uid = _user(conn, jobs_used=4)
    jid = _link_job(conn, uid)
    conn.execute(
        "UPDATE jobs SET status='failed', error_code='FETCH_PROXY_FAILED' WHERE id=%s", (jid,)
    )
    conn.commit()
    n = 8
    barrier = threading.Barrier(n)
    results: list[list[tuple]] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker():
        try:
            with psycopg.connect(DB) as c:  # type: ignore[arg-type]
                barrier.wait(timeout=10)
                rows = c.execute(
                    "SELECT * FROM public.restore_job_allowance(%s::uuid, %s::text[])",
                    (jid, list(OUR_FAULT_CODES)),
                ).fetchall()
                c.commit()
            with lock:
                results.append(rows)
        except BaseException as exc:  # noqa: BLE001
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert errors == []
    winners = [r for r in results if r]
    assert winners == [[(True, False)]], results
    assert _used(conn, uid) == 4, "eight concurrent sweeps gave back exactly one unit"


def test_concurrent_fail_job_calls_append_the_sentence_once(conn):
    uid = _user(conn, jobs_used=1)
    jid = _link_job(conn, uid)

    async def many():
        await asyncio.gather(
            *(job_failure.fail_job(DB, str(jid), "INTERNAL_ERROR", MSG) for _ in range(6))
        )

    asyncio.run(many())
    assert _used(conn, uid) == 1
    assert _job(conn, jid)[2] == f"{MSG} {ALLOWANCE_RETURNED_SENTENCE}"


# --------------------------------------------------------------------------- 4. period / floor
def test_month_rolled_over_the_new_month_is_not_credited(conn):
    uid = _user(conn, jobs_used=4)
    jid = _link_job(conn, uid)  # spent in this month: 5/5
    # The month rolls over (rollPeriodIfStale on the user's next job): a new period, 1 used.
    conn.execute(
        "UPDATE public.entitlements SET period_start = period_start + interval '1 month',"
        " period_end = period_end + interval '1 month', jobs_used = 1 WHERE user_id = %s",
        (uid,),
    )
    conn.commit()
    _fail(jid, "FETCH_PROXY_FAILED")
    assert _used(conn, uid) == 1, "a unit spent last month was credited to the new month"
    assert _debit(conn, jid) == (True, False, False), "claimed, with the outcome on record"
    assert _job(conn, jid)[2] == MSG, "no sentence: nothing came back"


def test_period_ended_but_not_yet_rolled_is_not_credited(conn):
    uid = _user(conn, jobs_used=2)
    jid = _link_job(conn, uid)
    conn.execute(
        "UPDATE public.entitlements SET period_start = period_start - interval '1 month',"
        " period_end = now() - interval '1 second' WHERE user_id = %s",
        (uid,),
    )
    conn.execute(
        "UPDATE public.job_allowance_debits SET allowance_period_start ="
        " (SELECT period_start FROM public.entitlements WHERE user_id = %s) WHERE job_id = %s",
        (uid, jid),
    )
    conn.commit()
    _fail(jid, "INTERNAL_ERROR")
    assert _used(conn, uid) == 3
    assert _debit(conn, jid) == (True, False, False)


def test_never_below_zero(conn):
    uid = _user(conn)
    jid = _link_job(conn, uid)
    conn.execute("UPDATE public.entitlements SET jobs_used = 0 WHERE user_id = %s", (uid,))
    conn.commit()
    _fail(jid, "UPLOAD_FAILED")
    assert _used(conn, uid) == 0
    assert _debit(conn, jid) == (True, False, False)


# --------------------------------------------------------------------------- 5. trial path
def test_trial_path_gives_back_the_trial_song_and_the_allowance_unit(conn):
    uid = _user(conn, trial_songs_used=1)
    jid = _link_job(conn, uid, trial=True)
    assert (_songs(conn, uid), _used(conn, uid)) == (2, 1)
    _fail(jid, "FETCH_PROXY_FAILED")
    assert (_songs(conn, uid), _used(conn, uid)) == (1, 0)
    assert _debit(conn, jid) == (True, True, True)
    assert _job(conn, jid)[2] == f"{MSG} {TRIAL_RETURNED_SENTENCE}"
    _fail(jid, "FETCH_PROXY_FAILED")
    assert (_songs(conn, uid), _used(conn, uid)) == (1, 0), "once"


def test_expired_trial_gets_no_song_back_but_the_unit_still_comes_back(conn):
    uid = _user(conn, trial_songs_used=0)
    jid = _link_job(conn, uid, trial=True)
    conn.execute(
        "UPDATE public.trial_grants SET expires_at = now() - interval '1 second' WHERE user_id = %s",
        (uid,),
    )
    conn.commit()
    _fail(jid, "INTERNAL_ERROR")
    assert _songs(conn, uid) == 1
    assert _used(conn, uid) == 0
    assert _debit(conn, jid) == (True, True, False)
    assert _job(conn, jid)[2] == f"{MSG} {ALLOWANCE_RETURNED_SENTENCE}"


# --------------------------------------------------------------------------- 7. unmigrated
def test_without_migration_042_the_failure_still_commits_and_nothing_is_restored(conn):
    """Simulated in one transaction (DROP FUNCTION, then ROLLBACK), so the schema is untouched."""
    uid = _user(conn)
    jid = _link_job(conn, uid)
    job_failure._restore_unmigrated_warned = False

    async def run():
        async with await psycopg.AsyncConnection.connect(DB) as c:  # type: ignore[arg-type]
            await c.execute("DROP FUNCTION public.restore_job_allowance(uuid, text[])")
            await c.execute(
                "UPDATE jobs SET status='failed', error_code='INTERNAL_ERROR' WHERE id=%s", (jid,)
            )
            got = await job_failure.restore_allowance_if_owed(c, str(jid))
            # The transaction is still usable after the tolerated error.
            row = await (await c.execute("SELECT status FROM jobs WHERE id=%s", (jid,))).fetchone()
            await c.rollback()
            return got, row

    got, row = asyncio.run(run())
    assert got is None
    assert row == ("failed",)
    assert job_failure._restore_unmigrated_warned is True
    assert _used(conn, uid) == 1
    assert _call_restore(DB, jid) == [], "function is back (rolled back) and the job is not failed"
