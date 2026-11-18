"""Paid-plan retention (Jon, 2026-11-15): Free = 24 h; Pro and Studio = kept while the
subscription is effective, plus 30 days' grace after it stops being effective; then deleted.

The rule is ONE SQL expression, used by the worker's sweep (cleanup.RETAINED_UNTIL_SQL) and by
every web route that serves a job (apps/web/src/lib/retention.ts JOB_RETAINED_UNTIL_SQL). This
file:

  1. pins the two copies IDENTICAL (no database; always runs);
  2. checks the sweep really issues it (no database; a fake connection records the SQL);
  3. against a REAL local Postgres (skipped without DATABASE_URL, refused for a non-local one by
     conftest.py), runs the real sweep over a fake R2 for every case the brief names -- free 24 h
     deleted; paid kept; paid -> canceled kept for 30 days then deleted; past_due grace;
     anonymous -- plus the edges: a job made after the plan ended is Free; account deletion
     kills paid retention; an anonymised shell is never resurrected; incomplete never retains;
     the owner's comp subscription keeps working;
  4. runs the WEB copy of the expression (read out of retention.ts) as `stemloops_app`, the
     production role, with RLS on, and checks it keeps exactly the rows the sweep kept.
"""

from __future__ import annotations

import asyncio
import os
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest

from worker import cleanup

DB = os.environ.get("DATABASE_URL")
needs_db = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")

RETENTION_TS = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "retention.ts"
EMAIL_LIKE = "test-paidret-%@example.com"
PROBE = "paidret-probe"  # client_ip_hash of every job this file creates
DAY = timedelta(days=1)
HOUR = timedelta(hours=1)


def _norm(sql: str) -> str:
    return " ".join(sql.split())


def _web_sql() -> str:
    """JOB_RETAINED_UNTIL_SQL as retention.ts builds it: its string literals, concatenated."""
    src = RETENTION_TS.read_text()
    m = re.search(r"export const JOB_RETAINED_UNTIL_SQL =(.*?);\n", src, re.S)
    assert m, f"JOB_RETAINED_UNTIL_SQL not found in {RETENTION_TS}"
    body = m.group(1)
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
    # Nothing but string literals and `+` may make up the expression: an interpolated value
    # would be invisible to this comparison.
    leftover = re.sub(r'"((?:[^"\\]|\\.)*)"', "", body)
    assert re.fullmatch(r"[\s+]*", leftover), f"unexpected tokens in the TS constant: {leftover!r}"
    return "".join(parts)


# ----------------------------------------------------------------------------- no database


def test_web_and_worker_use_the_identical_rule():
    assert _norm(_web_sql()) == _norm(cleanup.RETAINED_UNTIL_SQL)


def test_rule_constants_match_the_web_and_the_shell_marker():
    sql = cleanup.RETAINED_UNTIL_SQL
    assert "interval '30 days'" in sql, "30 days' grace (Jon, 2026-11-15)"
    # PAST_DUE_GRACE_MS in apps/web/src/lib/billing/entitlements.ts is 7 days.
    ent = (RETENTION_TS.parent / "billing" / "entitlements.ts").read_text()
    assert "PAST_DUE_GRACE_MS = 7 * 24 * 3600 * 1000" in ent
    assert "s.current_period_start + interval '7 days'" in sql
    # The literal in the SQL is the marker _anonymise_job writes.
    assert f"jobs.client_ip_hash <> '{cleanup.PURGED_MARKER}'" in sql


def test_demo_branch_is_finite_and_matches_the_web_constant():
    """Migration 040: an is_demo row is retained until a FINITE far-future date, the same
    literal the web exports as DEMO_RETAINED_UNTIL. Never 'infinity' (node-pg -> Infinity ->
    NaN -> 1-second signed URLs on the stems/download routes)."""
    sql = cleanup.RETAINED_UNTIL_SQL
    assert cleanup.DEMO_RETAINED_UNTIL == "2099-12-31T00:00:00Z"
    assert sql.startswith(
        f"(CASE WHEN jobs.is_demo THEN '{cleanup.DEMO_RETAINED_UNTIL}'::timestamptz ELSE GREATEST("
    )
    assert sql.endswith(" END)")
    assert "infinity" not in sql.lower()
    web = RETENTION_TS.read_text()
    assert f"export const DEMO_RETAINED_UNTIL = '{cleanup.DEMO_RETAINED_UNTIL}';" in web


def test_sweep_selects_with_the_retention_rule():
    """The sweep's candidate query carries the rule, not just the 24 h expires_at."""

    class Cur:
        async def fetchall(self):
            return []

    class Conn:
        def __init__(self):
            self.sql: list[str] = []

        async def execute(self, sql, params=None):
            self.sql.append(sql)
            return Cur()

    conn = Conn()
    asyncio.run(cleanup._sweep_expired_jobs(conn, deadline=float("inf")))
    (select,) = [s for s in conn.sql if s.lstrip().upper().startswith("SELECT")]
    assert f"AND {cleanup.RETAINED_UNTIL_SQL} < now()" in _norm(select)


# ----------------------------------------------------------------------------- real database


class FakeR2:
    def __init__(self):
        self.objs: dict[str, datetime] = {}

    def put(self, key: str, age: timedelta) -> None:
        self.objs[key] = datetime.now(UTC) - age

    def delete_prefix(self, prefix):
        keys = [k for k in self.objs if k.startswith(prefix)]
        for k in keys:
            del self.objs[k]
        return len(keys)

    def list_older(self, cutoff, limit=2000, start_after=""):
        # Lexical order and StartAfter, like ListObjectsV2.
        return [k for k in sorted(self.objs) if k > start_after and self.objs[k] < cutoff][:limit]

    def delete_objects(self, keys):
        for k in keys:
            self.objs.pop(k, None)
        return len(keys)


def _cleanup_rows(c: Any) -> None:
    c.rollback()
    c.execute("RESET ROLE")
    c.execute("DELETE FROM public.jobs WHERE client_ip_hash = %s", (PROBE,))
    c.execute(
        "DELETE FROM public.subscriptions WHERE user_id IN (SELECT id FROM public.users WHERE email LIKE %s)",
        (EMAIL_LIKE,),
    )
    c.execute(
        "DELETE FROM public.entitlements WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE %s)",
        (EMAIL_LIKE,),
    )
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.commit()


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup_rows(c)
        yield c
        _cleanup_rows(c)


@pytest.fixture
def r2(monkeypatch):
    fake = FakeR2()
    monkeypatch.setattr(cleanup, "DATABASE_URL", DB)
    cleanup._failed.clear()
    monkeypatch.setattr(cleanup, "delete_prefix", fake.delete_prefix)
    monkeypatch.setattr(cleanup, "list_objects_older_than", fake.list_older)
    monkeypatch.setattr(cleanup, "delete_objects", fake.delete_objects)
    return fake


def _user(c: Any, tag: str) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-paidret-{tag}-{uid.hex[:8]}@example.com"),
    )
    return uid


def _sub(
    c: Any,
    user: uuid.UUID,
    status: str,
    start: timedelta,
    end: timedelta,
    updated: timedelta = timedelta(0),
    plan: str = "pro",
    provider_id: str | None = None,
) -> None:
    """A subscription; every time is an offset from now (negative = in the past)."""
    c.execute(
        "INSERT INTO public.subscriptions (user_id, provider, provider_subscription_id, plan_code, "
        "status, current_period_start, current_period_end, updated_at) "
        "VALUES (%s, 'stripe', %s, %s, %s, now() + %s, now() + %s, now() + %s)",
        (user, provider_id or f"sub_paidret_{uuid.uuid4().hex}", plan, status, start, end, updated),
    )


def _job(
    c: Any, user: uuid.UUID | None, age: timedelta, *, killed: bool = False, demo: bool = False
) -> str:
    """A done job `age` old with the default 24 h expires_at (or killed: expires_at = created_at).
    demo=True sets is_demo with a SEPARATE UPDATE, the way the operator's named write will."""
    jid = str(uuid.uuid4())
    c.execute(
        "INSERT INTO public.jobs (id, youtube_url, status, client_ip_hash, client_fingerprint, "
        "user_id, loop_length_bars, created_at, expires_at) "
        "VALUES (%s, %s, 'done', %s, '', %s, 4, now() - %s, now() - %s + %s)",
        (
            jid,
            f"https://paidret.invalid/{jid}",
            PROBE,
            user,
            age,
            age,
            timedelta(0) if killed else DAY,
        ),
    )
    if demo:
        c.execute("UPDATE public.jobs SET is_demo = true WHERE id IN (%s)", (jid,))
    return jid


def _exists(c: Any, jid: str) -> bool:
    return c.execute("SELECT 1 FROM public.jobs WHERE id = %s", (jid,)).fetchone() is not None


def _sweep_until_quiet() -> None:
    # Other tests' rows may share the database; MAX_JOBS_PER_SWEEP bounds a pass, so sweep
    # until a pass deletes nothing more.
    for _ in range(20):
        res = asyncio.run(cleanup.sweep_expired())
        if res["jobs"] == 0 and res["anonymised"] == 0:
            return
    raise AssertionError("the sweep never went quiet")


def _web_kept(c: Any, ids: list[str]) -> set[str]:
    """Which of `ids` the WEB rule serves, run as the production web role (RLS on)."""
    c.execute("SET ROLE stemloops_app")
    try:
        rows = c.execute(
            f"SELECT id::text FROM jobs WHERE id = ANY(%s::uuid[]) AND {_web_sql()} > now()",
            (ids,),
        ).fetchall()
    finally:
        c.rollback()
        c.execute("RESET ROLE")
    return {r[0] for r in rows}


@pytest.fixture
def world(conn, r2):
    """Every case at once, with its expected fate. Each job owns two R2 objects."""
    c = conn
    w: dict[str, tuple[str, bool]] = {}  # name -> (job id, kept?)

    free = _user(c, "free")
    w["free_25h_deleted"] = (_job(c, free, 25 * HOUR), False)
    w["free_1h_kept"] = (_job(c, free, 1 * HOUR), True)

    w["anonymous_25h_deleted"] = (_job(c, None, 25 * HOUR), False)
    w["anonymous_1h_kept"] = (_job(c, None, 1 * HOUR), True)

    active = _user(c, "active")
    _sub(c, active, "active", -10 * DAY, 20 * DAY, plan="studio")
    w["active_10d_kept"] = (_job(c, active, 10 * DAY), True)
    w["active_200d_kept"] = (_job(c, active, 200 * DAY), True)  # a library, not a window
    w["active_killed_by_account_deletion"] = (_job(c, active, 2 * HOUR, killed=True), False)

    trialing = _user(c, "trialing")
    _sub(c, trialing, "trialing", -2 * DAY, 5 * DAY)
    w["trialing_2d_kept"] = (_job(c, trialing, 2 * DAY), True)

    # The webhook sets canceled + updated_at = now() when Stripe says the plan ended.
    canceled_recent = _user(c, "canceled-recent")
    _sub(c, canceled_recent, "canceled", -40 * DAY, -10 * DAY, updated=-10 * DAY)
    w["canceled_10d_ago_within_grace_kept"] = (_job(c, canceled_recent, 40 * DAY), True)
    # Made AFTER the plan ended: a Free job, 24 h exactly, even inside the library's grace.
    w["canceled_job_made_after_end_is_free"] = (_job(c, canceled_recent, 2 * DAY), False)
    w["canceled_job_made_after_end_fresh_kept"] = (_job(c, canceled_recent, 2 * HOUR), True)

    canceled_old = _user(c, "canceled-old")
    _sub(c, canceled_old, "canceled", -61 * DAY, -31 * DAY, updated=-31 * DAY)
    w["canceled_31d_ago_past_grace_deleted"] = (_job(c, canceled_old, 50 * DAY), False)

    # Canceled immediately mid-period: it stopped at updated_at, not at period_end.
    canceled_now = _user(c, "canceled-immediate")
    _sub(c, canceled_now, "canceled", -45 * DAY, 15 * DAY, updated=-31 * DAY)
    w["canceled_immediately_31d_ago_deleted"] = (_job(c, canceled_now, 40 * DAY), False)

    # A downgrade must not delete instantly: canceled just now, job weeks old.
    downgraded = _user(c, "downgraded-now")
    _sub(c, downgraded, "canceled", -30 * DAY, -1 * HOUR, updated=-1 * HOUR)
    w["downgrade_just_now_not_deleted_instantly"] = (_job(c, downgraded, 20 * DAY), True)

    past_due_in = _user(c, "pastdue-in")
    _sub(c, past_due_in, "past_due", -3 * DAY, 27 * DAY)
    w["past_due_in_grace_kept"] = (_job(c, past_due_in, 20 * DAY), True)

    past_due_out = _user(c, "pastdue-out")
    # Effective until start + 7 d = 33 d ago; + 30 d grace = 3 d ago.
    _sub(c, past_due_out, "past_due", -40 * DAY, -10 * DAY)
    w["past_due_lapsed_past_grace_deleted"] = (_job(c, past_due_out, 45 * DAY), False)

    incomplete = _user(c, "incomplete")
    _sub(c, incomplete, "incomplete", -1 * DAY, 29 * DAY)
    w["incomplete_never_retains"] = (_job(c, incomplete, 25 * HOUR), False)

    two = _user(c, "two-subs")
    _sub(c, two, "canceled", -400 * DAY, -370 * DAY, updated=-370 * DAY)
    _sub(c, two, "active", -5 * DAY, 25 * DAY)
    w["latest_effective_sub_wins"] = (_job(c, two, 100 * DAY), True)

    # Two QUALIFYING subscriptions (both effective after the job was made): the LATEST end
    # decides. Under MIN the canceled one (grace ended 10 days ago) would delete the library.
    both = _user(c, "two-qualifying")
    _sub(c, both, "canceled", -70 * DAY, -40 * DAY, updated=-40 * DAY)
    _sub(c, both, "active", -10 * DAY, 20 * DAY)
    w["two_qualifying_subs_latest_wins"] = (_job(c, both, 100 * DAY), True)

    owner = _user(c, "comp-owner")
    _sub(
        c,
        owner,
        "active",
        -1 * HOUR,
        365 * DAY,
        plan="studio",
        provider_id="comp_owner_jon_2026-11-15",
    )
    w["comp_owner_subscription_kept"] = (_job(c, owner, 3 * DAY), True)

    # Demo songs (migration 040): kept whatever their age, owner or plan. Owned by a
    # system account on Free (no subscription), as P3.1 specifies; plus the edges.
    demo_owner = _user(c, "demo-system")
    w["demo_owned_400d_kept"] = (_job(c, demo_owner, 400 * DAY, demo=True), True)
    w["demo_anonymous_30d_kept"] = (_job(c, None, 30 * DAY, demo=True), True)
    # Even an expires_at = created_at (the account-deletion shape) does not end a demo.
    w["demo_killed_shape_still_kept"] = (_job(c, demo_owner, 2 * DAY, killed=True, demo=True), True)
    # Control: the same owner's ordinary job is Free's 24 h.
    w["demo_owner_regular_job_deleted"] = (_job(c, demo_owner, 25 * HOUR), False)

    c.commit()
    for jid, _ in w.values():
        r2.put(f"{jid}/_input.wav", 1 * HOUR)
        r2.put(f"jobs/{jid}/play.chords.json", 1 * HOUR)
    return w


@needs_db
def test_sweep_applies_the_rule_to_every_case(conn, r2, world):
    _sweep_until_quiet()
    wrong = []
    for name, (jid, kept) in world.items():
        row = _exists(conn, jid)
        objs = [k for k in r2.objs if jid in k]
        if kept and not (row and len(objs) == 2):
            wrong.append(f"{name}: should be KEPT, row={row} objects={len(objs)}")
        if not kept and (row or objs):
            wrong.append(f"{name}: should be DELETED, row={row} objects={len(objs)}")
    assert not wrong, "\n".join(wrong)


@needs_db
def test_web_rule_serves_exactly_what_the_sweep_keeps(conn, world):
    """Before any sweep: the web serves exactly the KEPT set (a job past its retention is
    a 404 even while its row still exists), as the production web role."""
    ids = [jid for jid, _ in world.values()]
    kept = _web_kept(conn, ids)
    expected = {jid for jid, k in world.values() if k}
    by_id = {jid: name for name, (jid, _) in world.items()}
    assert kept == expected, (
        f"served but should not be: {sorted(by_id[j] for j in kept - expected)}; "
        f"not served but should be: {sorted(by_id[j] for j in expected - kept)}"
    )


@needs_db
def test_canceled_library_is_deleted_once_grace_ends(conn, r2):
    """The same job, before and after its 30 days: kept, then deleted (never kept forever)."""
    u = _user(conn, "grace-boundary")
    # Ended 29 days ago: 1 day of grace left.
    _sub(conn, u, "canceled", -59 * DAY, -29 * DAY, updated=-29 * DAY)
    jid = _job(conn, u, 40 * DAY)
    conn.commit()
    r2.put(f"{jid}/_input.wav", 1 * HOUR)
    _sweep_until_quiet()
    assert _exists(conn, jid), "inside the 30 days the library must survive"
    # Two days later (shift the subscription instead of the clock).
    conn.execute(
        "UPDATE public.subscriptions SET current_period_start = current_period_start - interval '2 days', "
        "current_period_end = current_period_end - interval '2 days' WHERE user_id = %s",
        (u,),
    )
    # The touch trigger set updated_at = now(); LEAST(current_period_end, updated_at) still
    # resolves to the (now 31-days-ago) period end, so a touched row cannot extend grace.
    conn.commit()
    _sweep_until_quiet()
    assert not _exists(conn, jid), "after the 30 days the library must be deleted"
    assert not [k for k in r2.objs if jid in k]


@needs_db
def test_an_anonymised_shell_is_never_resurrected_by_a_later_subscription(conn, r2):
    """A charged job's shell survives retention for the ledger. If its owner subscribes later
    the shell must stay gone to the web (its audio was deleted)."""
    u = _user(conn, "shell")
    jid = _job(conn, u, 25 * HOUR)
    conn.execute(
        "UPDATE public.jobs SET client_ip_hash = 'purged', client_fingerprint = 'purged' WHERE id = %s",
        (jid,),
    )
    _sub(conn, u, "active", -1 * HOUR, 30 * DAY)
    conn.commit()
    assert _web_kept(conn, [jid]) == set()
    conn.execute("DELETE FROM public.jobs WHERE id = %s", (jid,))
    conn.commit()


@needs_db
def test_account_deletion_statement_kills_a_paid_library(conn):
    """The statement DELETE /api/users/me issues, read from route.ts, run as stemloops_app:
    a subscriber's jobs are gone to the web at once, though the subscription is still active
    (the cancel only reaches subscriptions later, through the webhook)."""
    route = (
        Path(__file__).resolve().parents[2]
        / "web"
        / "src"
        / "app"
        / "api"
        / "users"
        / "me"
        / "route.ts"
    ).read_text()
    (stmt,) = re.findall(r"`(\s*UPDATE\s+public\.jobs\b[^`]*)`", route)
    u = _user(conn, "deleting")
    _sub(conn, u, "active", -1 * DAY, 29 * DAY)
    old = _job(conn, u, 10 * DAY)  # past its 24 h, kept only by the plan
    new = _job(conn, u, 1 * HOUR)
    conn.commit()
    assert _web_kept(conn, [old, new]) == {old, new}
    conn.execute("SET ROLE stemloops_app")
    n = conn.execute(stmt.replace("$1", "%s"), (u,)).rowcount
    conn.commit()
    conn.execute("RESET ROLE")
    assert n == 2
    assert _web_kept(conn, [old, new]) == set()
    conn.execute("SET ROLE stemloops_app")
    assert conn.execute(stmt.replace("$1", "%s"), (u,)).rowcount == 0, "idempotent"
    conn.commit()
    conn.execute("RESET ROLE")


def _claim_sql() -> str:
    """The claim UPDATE exactly as POST /api/users/me/claim-jobs issues it."""
    route = (
        Path(__file__).resolve().parents[2] / "web/src/app/api/users/me/claim-jobs/route.ts"
    ).read_text()
    (stmt,) = re.findall(r"`(\s*UPDATE\s+public\.jobs\b[^`]*)`", route)
    return re.sub(r"\$(\d)", "%s", stmt)


def _anon_job(c: Any, age: timedelta, fp: str) -> str:
    jid = _job(c, None, age)
    c.execute("UPDATE public.jobs SET client_fingerprint = %s WHERE id = %s", (fp, jid))
    return jid


@needs_db
def test_claim_refuses_a_job_already_past_its_24_hours(conn):
    """An anonymous job past 24 h but not yet swept cannot be claimed back to life."""
    u = _user(conn, "claim-expired")
    _sub(conn, u, "active", -1 * DAY, 29 * DAY)
    fp = f"fp-paidret-{uuid.uuid4().hex}"
    old = _anon_job(conn, 25 * HOUR, fp)
    conn.commit()
    n = conn.execute(_claim_sql(), (u, fp, [PROBE], 1000)).rowcount
    conn.commit()
    assert n == 0
    assert conn.execute("SELECT user_id FROM jobs WHERE id = %s", (old,)).fetchone() == (None,)
    assert _web_kept(conn, [old]) == set()


@needs_db
def test_a_claimed_anonymous_job_keeps_its_24_hours_for_a_paid_owner(conn, r2):
    """Started without an account -> /privacy promises 24 h, even after a Pro user claims it."""
    u = _user(conn, "claim-live")
    _sub(conn, u, "active", -1 * DAY, 29 * DAY, plan="studio")
    fp = f"fp-paidret-{uuid.uuid4().hex}"
    jid = _anon_job(conn, 2 * HOUR, fp)
    own = _job(conn, u, 2 * HOUR)  # control: started signed in
    conn.commit()
    assert conn.execute(_claim_sql(), (u, fp, [PROBE], 1000)).rowcount == 1
    conn.commit()
    assert conn.execute("SELECT user_id FROM jobs WHERE id = %s", (jid,)).fetchone() == (u,)
    (until,) = conn.execute(
        f"SELECT {_web_sql()} - created_at FROM jobs WHERE id = %s", (jid,)
    ).fetchone()
    assert until <= DAY + timedelta(seconds=1), f"claimed job kept for {until}"
    # Time passes: both jobs are now 25 h old.
    conn.execute(
        "UPDATE public.jobs SET created_at = created_at - interval '23 hours', "
        "expires_at = expires_at - interval '23 hours' WHERE id = ANY(%s::uuid[])",
        ([jid, own],),
    )
    conn.commit()
    r2.put(f"{jid}/_input.wav", 25 * HOUR)
    r2.put(f"{own}/_input.wav", 25 * HOUR)
    _sweep_until_quiet()
    assert not _exists(conn, jid), "a claimed anonymous job must be deleted at created_at + 24 h"
    assert not [k for k in r2.objs if jid in k]
    assert _exists(conn, own), "the owner's own signed-in job is library"


# ----------------------------------------------------------------------------- demo songs


@needs_db
def test_is_demo_column_defaults_false_and_is_not_null(conn):
    """Migration 040: every job not named by the operator's write is is_demo = false."""
    row = conn.execute(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'is_demo'"
    ).fetchone()
    assert row == ("boolean", "NO", "false")
    jid = _job(conn, None, 1 * HOUR)
    conn.commit()
    assert conn.execute("SELECT is_demo FROM jobs WHERE id = %s", (jid,)).fetchone() == (False,)


@needs_db
def test_demo_expiry_reads_2099_12_31_from_both_copies(conn):
    """The value the web returns AS expires_at (and the sweep compares) for a demo row."""
    jid = _job(conn, None, 30 * DAY, demo=True)
    conn.commit()
    want = datetime(2099, 12, 31, tzinfo=UTC)
    for sql in (_web_sql(), cleanup.RETAINED_UNTIL_SQL):
        (until,) = conn.execute(f"SELECT {sql} FROM jobs WHERE id = %s", (jid,)).fetchone()
        assert until == want, until
    assert _web_kept(conn, [jid]) == {jid}


@needs_db
def test_sweep_never_selects_a_demo_row(conn, r2):
    """The candidate SELECT itself, run against the database: a long-expired demo row is not
    a candidate (so neither its R2 objects nor its row can be touched)."""
    demo = _job(conn, None, 90 * DAY, demo=True)
    plain = _job(conn, None, 90 * DAY)
    conn.commit()

    class Rec:
        def __init__(self, c):
            self.c = c
            self.rows: list[str] = []

        async def execute(self, sql, params=None):
            cur = self.c.execute(sql, params)
            if sql.lstrip().upper().startswith("SELECT"):
                self.rows = [r[0] for r in cur.fetchall()]

            class Cur:
                async def fetchall(_self):
                    return [(r,) for r in self.rows]

            return Cur()

        async def commit(self):
            self.c.commit()

        async def rollback(self):
            self.c.rollback()

    rec = Rec(conn)
    # Selection only: the fake R2 + real DELETE run, so assert on what was selected.
    asyncio.run(cleanup._sweep_expired_jobs(rec, deadline=float("inf")))
    assert plain in rec.rows, "control: an ordinary expired job is selected"
    assert demo not in rec.rows, "a demo row must never be a sweep candidate"
    assert _exists(conn, demo)


@needs_db
def test_account_deletion_statement_ends_a_demo(conn, r2):
    """DELETE /api/users/me's job UPDATE (read from route.ts, run as stemloops_app) clears
    is_demo, so a deleted demo owner never leaves demos retained until 2099 AND anonymous
    (user_id ON DELETE SET NULL). Covers a live demo and one already in the killed shape
    (expires_at = created_at), then deletes the owner and runs the real sweep."""
    route = (
        Path(__file__).resolve().parents[2]
        / "web"
        / "src"
        / "app"
        / "api"
        / "users"
        / "me"
        / "route.ts"
    ).read_text()
    (stmt,) = re.findall(r"`(\s*UPDATE\s+public\.jobs\b[^`]*)`", route)
    u = _user(conn, "demo-owner-deleting")
    live_demo = _job(conn, u, 10 * DAY, demo=True)
    killed_demo = _job(conn, u, 2 * DAY, killed=True, demo=True)
    other = _user(conn, "demo-bystander")
    bystander_demo = _job(conn, other, 10 * DAY, demo=True)
    conn.commit()
    for jid in (live_demo, killed_demo, bystander_demo):
        r2.put(f"{jid}/_input.wav", 1 * HOUR)
    assert _web_kept(conn, [live_demo, killed_demo]) == {live_demo, killed_demo}

    conn.execute("SET ROLE stemloops_app")
    n = conn.execute(stmt.replace("$1", "%s"), (u,)).rowcount
    conn.commit()
    conn.execute("RESET ROLE")
    assert n == 2, "both demos of the deleting owner, the killed-shape one included"
    flags = dict(
        conn.execute(
            "SELECT id::text, is_demo FROM jobs WHERE id = ANY(%s::uuid[])",
            ([live_demo, killed_demo, bystander_demo],),
        ).fetchall()
    )
    assert flags == {live_demo: False, killed_demo: False, bystander_demo: True}
    assert _web_kept(conn, [live_demo, killed_demo]) == set(), "gone to the web at once"

    # The FK step of the real deletion: the owner goes, user_id SET NULL. The rows are past
    # retention and anonymous now, and the sweep deletes them; another owner's demo stays.
    conn.execute("DELETE FROM public.users WHERE id = %s", (u,))
    conn.execute("DELETE FROM auth.users WHERE id = %s", (u,))
    conn.commit()
    _sweep_until_quiet()
    assert not _exists(conn, live_demo) and not _exists(conn, killed_demo)
    assert not [k for k in r2.objs if live_demo in k or killed_demo in k]
    assert _exists(conn, bystander_demo), "another owner's demo is untouched"

    conn.execute("SET ROLE stemloops_app")
    assert conn.execute(stmt.replace("$1", "%s"), (u,)).rowcount == 0, "idempotent"
    conn.commit()
    conn.execute("RESET ROLE")
