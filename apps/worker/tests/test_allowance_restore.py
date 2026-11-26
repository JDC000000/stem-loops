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
     working, with nothing restored;
  8. (QA-66, #308 review L-2) the restore works as the RUNTIME role (SET ROLE stemloops_app:
     CI connects as the owner, which would pass even with a broken grant), and anon /
     authenticated hold no EXECUTE on restore_job_allowance (the PostgREST RPC path);
  9. (QA-66, L-1) a restore error never blocks failing a link job.

Local throwaway DB only (INSERTs into auth.users). Runs in CI; never against a shared DB.
"""

from __future__ import annotations

import asyncio
import os
import threading
import uuid

import psycopg
import pytest
from psycopg import sql

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
MSG = "Something went wrong on our end fetching this video. Try again later."
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


# --------------------------------------------------------------------------- 8. grants (QA-66)
RESTORE_FN = "public.restore_job_allowance(uuid, text[])"


def _ensure_role(c, role: str) -> None:
    """The CI database is Supabase-shaped (anon / authenticated / stemloops_app exist: 042
    REVOKEs from them unconditionally). A missing one is created NOLOGIN, as
    test_fetch_gates_restricted_role does, so the assertion is about the grant, not about
    whether the role exists (a fresh role holds only PUBLIC's rights, and 042 revokes those)."""
    if c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone() is None:
        c.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
    c.commit()


def test_the_runtime_role_can_restore(conn):
    """As stemloops_app (RLS on, no owner rights) the restore really runs and gives back."""
    uid = _user(conn)
    jid = _link_job(conn, uid)
    conn.execute(
        "UPDATE jobs SET status='failed', error_code='FETCH_PROXY_FAILED' WHERE id=%s", (jid,)
    )
    conn.commit()
    conn.execute("SET ROLE stemloops_app")
    try:
        rows = conn.execute(
            job_failure.RESTORE_SQL, {"job_id": jid, "our_fault_codes": list(OUR_FAULT_CODES)}
        ).fetchall()
        conn.commit()
    finally:
        conn.rollback()
        conn.execute("RESET ROLE")
    assert rows == [(True, False)]
    assert _used(conn, uid) == 0
    assert _debit(conn, jid) == (True, True, False)


def test_the_runtime_role_restore_through_the_worker_helper(conn):
    """The worker's own code path, on a connection running as stemloops_app."""
    uid = _user(conn, trial_songs_used=0)
    jid = _link_job(conn, uid, trial=True)
    conn.execute("UPDATE jobs SET status='failed', error_code='INTERNAL_ERROR' WHERE id=%s", (jid,))
    conn.commit()

    async def run():
        async with await psycopg.AsyncConnection.connect(DB) as c:  # type: ignore[arg-type]
            await c.execute("SET ROLE stemloops_app")
            got = await job_failure.restore_allowance_isolated(c, str(jid), stage="test")
            await c.commit()
            return got

    assert asyncio.run(run()) == "trial"
    assert _used(conn, uid) == 0 and _songs(conn, uid) == 0


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_unprivileged_roles_cannot_execute_restore(conn, role):
    _ensure_role(conn, role)
    (allowed,) = conn.execute(
        "SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, RESTORE_FN)
    ).fetchone()
    assert allowed is False, f"{role} can EXECUTE {RESTORE_FN}"
    uid = _user(conn)
    jid = _link_job(conn, uid)
    conn.execute("UPDATE jobs SET status='failed', error_code='INTERNAL_ERROR' WHERE id=%s", (jid,))
    conn.commit()
    conn.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(role)))
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "SELECT * FROM public.restore_job_allowance(%s::uuid, %s::text[])",
                (jid, list(OUR_FAULT_CODES)),
            )
    finally:
        conn.rollback()
        conn.execute("RESET ROLE")
    assert _used(conn, uid) == 1, "nothing was given back"


def test_the_runtime_role_holds_execute(conn):
    (allowed,) = conn.execute(
        "SELECT has_function_privilege('stemloops_app', %s, 'EXECUTE')", (RESTORE_FN,)
    ).fetchone()
    assert allowed is True


# --------------------------------------------------------------------------- 9. isolation (QA-66)
def test_a_restore_error_never_blocks_the_reaper_failing_a_link_job(conn, monkeypatch):
    working_sql = job_failure.RESTORE_SQL
    monkeypatch.setattr(
        job_failure,
        "RESTORE_SQL",
        "SELECT (1 / 0) > 0, false"
        " WHERE %(job_id)s::uuid IS NOT NULL AND %(our_fault_codes)s::text[] IS NOT NULL",
    )
    uid = _user(conn)
    jid = _link_job(
        conn,
        uid,
        status="separating",
        attempts=reaper.MAX_ATTEMPTS,
        stale_s=reaper.STALE_SECONDS + 60,
    )
    asyncio.run(reaper.reap_stale_jobs())
    status, code, message = _job(conn, jid)
    assert (status, code) == ("failed", "INTERNAL_ERROR")
    assert ALLOWANCE_RETURNED_SENTENCE not in (message or ""), "nothing was restored: no claim"
    assert _used(conn, uid) == 1
    # Once the restore works again, a later failure path still gives the unit back, once.
    monkeypatch.setattr(job_failure, "RESTORE_SQL", working_sql)
    _fail(jid, "INTERNAL_ERROR")
    assert _used(conn, uid) == 0
    assert _debit(conn, jid) == (True, True, False)


# --------------------------------------------------------------------------- QK-4
def _drive_link(monkeypatch, *, flag: bool, raises: Exception | None):
    """The real _run_pipeline on a real link job; only the fetch is stubbed (it raises)."""
    from worker import replicate_client

    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_URL", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_FILE", raising=False)
    if flag:
        monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    else:
        monkeypatch.delenv("ALLOW_YOUTUBE_INPUT", raising=False)

    def fetch(*_a, **_k):
        raise raises  # type: ignore[misc]

    monkeypatch.setattr(pipeline, "download_audio", fetch)
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_exception", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "_reported_once", set())
    monkeypatch.setattr(replicate_client, "_heartbeat", lambda *_: None)


def _qk4_cases():
    from worker.errors import (
        BlocklistUnavailableError,
        FetchPausedError,
        YoutubeInputDisabledError,
    )

    return [
        ("kill_switch", True, FetchPausedError("kill switch fetch_global"), FetchPausedError),
        ("blocklist", True, BlocklistUnavailableError("db"), BlocklistUnavailableError),
        ("env_split", False, None, YoutubeInputDisabledError),
    ]


@pytest.mark.parametrize("case", _qk4_cases(), ids=lambda c: c[0])
@pytest.mark.parametrize("trial", [False, True], ids=["unit", "trial"])
def test_qk4_our_link_refusals_give_the_song_back_once(conn, monkeypatch, case, trial):
    _name, flag, raises, cls = case
    uid = _user(conn, jobs_used=2, trial_songs_used=0 if trial else None)
    jid = _link_job(conn, uid, status="queued", trial=trial)
    assert _used(conn, uid) == 3
    _drive_link(monkeypatch, flag=flag, raises=raises)
    with pytest.raises(cls):
        asyncio.run(pipeline._run_pipeline(str(jid)))
    status, code, message = _job(conn, jid)
    assert (status, code) == ("failed", "INTERNAL_ERROR")
    sentence = TRIAL_RETURNED_SENTENCE if trial else ALLOWANCE_RETURNED_SENTENCE
    assert message.endswith(sentence)
    assert _used(conn, uid) == 2
    if trial:
        assert _songs(conn, uid) == 0
    # The reaper / consumer / a second failure on the same job give nothing more.
    _fail(jid, "INTERNAL_ERROR")
    asyncio.run(consumer.mark_failed(str(jid), "INTERNAL_ERROR", MSG))
    assert _used(conn, uid) == 2
    assert _job(conn, jid)[2].count(sentence) == 1


def test_qk4_a_real_youtube_block_still_keeps_the_song(conn, monkeypatch):
    from worker.errors import DownloadBlockedError

    uid = _user(conn)
    jid = _link_job(conn, uid, status="queued")
    _drive_link(monkeypatch, flag=True, raises=DownloadBlockedError("bot wall"))
    with pytest.raises(DownloadBlockedError):
        asyncio.run(pipeline._run_pipeline(str(jid)))
    assert _job(conn, jid)[:2] == ("failed", "DOWNLOAD_BLOCKED")
    assert _used(conn, uid) == 1
    assert _debit(conn, jid) == (False, None, None)
