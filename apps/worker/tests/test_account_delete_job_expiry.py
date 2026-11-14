"""#241 reviewer probes: account deletion expires the deleting user's live jobs.

DELETE /api/users/me runs one statement inside its erase-and-cancel transaction:

    UPDATE public.jobs SET expires_at = now()
     WHERE user_id = $1::uuid AND expires_at > now()

The web tests (apps/web/test/account-delete.test.mjs) stub the database, so they can check
the statement's text, binding and placement but not what it DOES to rows. These tests run
the statement READ FROM route.ts (so a change to the route is what is tested) against a real
local Postgres, AS stemloops_app (the production web role; RLS on), and pin:

  1. every live job of the deleting user is expired (expires_at <= now(), which every job
     route treats as gone), whatever its status;
  2. that user's already-expired job keeps its original expiry (expire, never extend);
  3. other users' jobs and anonymous jobs are untouched, to the microsecond;
  4. it is idempotent: a second run (a retried deletion) updates nothing and changes nothing.

Requires a local Postgres with migrations applied; skipped without DATABASE_URL, and
refused for a non-local one by conftest.py (tests/db_guard.py). It INSERTs into auth.users.
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")

ROUTE = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "app"
    / "api"
    / "users"
    / "me"
    / "route.ts"
)
EMAIL_LIKE = "test-acctdel-jobs-%@example.com"
STATUSES_LIVE = ("queued", "downloading", "separating", "extracting", "uploading", "done", "failed")


def _route_expiry_sql() -> str:
    """The jobs-expiry statement exactly as route.ts issues it, $1 rewritten for psycopg."""
    src = ROUTE.read_text()
    found = re.findall(r"`(\s*UPDATE\s+public\.jobs\b[^`]*)`", src)
    assert (
        len(found) == 1
    ), f"expected exactly one UPDATE public.jobs in {ROUTE}, found {len(found)}"
    sql = found[0]
    assert "$1" in sql and "$2" not in sql, sql
    return sql.replace("$1", "%s")


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    c.execute("RESET ROLE")
    c.execute("DELETE FROM public.jobs WHERE client_ip_hash = 'acctdel-probe'")
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.commit()


def _user(c: Any, tag: str) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-acctdel-jobs-{tag}-{uid.hex[:8]}@example.com"),
    )
    return uid


def _job(c: Any, user_id: uuid.UUID | None, status: str, expires_in: timedelta) -> uuid.UUID:
    jid = uuid.uuid4()
    c.execute(
        "INSERT INTO public.jobs (id, youtube_url, status, client_ip_hash, client_fingerprint, "
        "user_id, loop_length_bars, expires_at) "
        "VALUES (%s, 'https://example.test/x', %s, 'acctdel-probe', '', %s, 4, now() + %s)",
        (jid, status, user_id, expires_in),
    )
    return jid


def _expiries(c: Any) -> dict[uuid.UUID, datetime]:
    rows = c.execute(
        "SELECT id, expires_at FROM public.jobs WHERE client_ip_hash = 'acctdel-probe'"
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def _gone(c: Any, ids: list[uuid.UUID]) -> bool:
    (n,) = c.execute(
        "SELECT count(*) FROM public.jobs WHERE id = ANY(%s) AND expires_at > now()", (ids,)
    ).fetchone()
    return n == 0


def _run_as_app(c: Any, user_id: uuid.UUID) -> int:
    """One deletion's worth of the statement, as the web role, committed."""
    c.execute("SET ROLE stemloops_app")
    cur = c.execute(_route_expiry_sql(), (user_id,))
    n = cur.rowcount
    c.commit()
    c.execute("RESET ROLE")
    return n


@pytest.fixture
def world(conn):
    """Deleting user A (live jobs in every status + one already expired), user B, anon."""
    a, b = _user(conn, "a"), _user(conn, "b")
    a_live = [_job(conn, a, s, timedelta(hours=23)) for s in STATUSES_LIVE]
    a_live.append(_job(conn, a, "done", timedelta(seconds=5)))  # about to expire, still live
    a_expired = _job(conn, a, "done", timedelta(hours=-2))
    b_live = [_job(conn, b, s, timedelta(hours=12)) for s in ("queued", "separating", "done")]
    b_expired = _job(conn, b, "done", timedelta(hours=-3))
    anon = [_job(conn, None, s, timedelta(hours=20)) for s in ("queued", "done")]
    conn.commit()
    return {
        "a": a,
        "b": b,
        "a_live": a_live,
        "a_expired": a_expired,
        "bystanders": b_live + [b_expired] + anon,
        "b_live": b_live,
        "anon": anon,
    }


def test_route_statement_is_the_one_under_test():
    """Guard: the statement this file runs is read from route.ts, not copied."""
    sql = " ".join(_route_expiry_sql().split())
    assert (
        sql
        == "UPDATE public.jobs SET expires_at = now() WHERE user_id = %s::uuid AND expires_at > now()"
    )


def test_deletion_expires_every_live_job_of_that_user(conn, world):
    before = _expiries(conn)
    n = _run_as_app(conn, world["a"])
    after = _expiries(conn)

    assert n == len(world["a_live"]), "one row per live job of the deleting user, no more"
    assert _gone(conn, world["a_live"]), "every live job of the deleting user now reads as gone"
    for jid in world["a_live"]:
        assert after[jid] < before[jid], "expired: moved EARLIER, never later"
    (now,) = conn.execute("SELECT now()").fetchone()
    for jid in world["a_live"]:
        assert after[jid] <= now
    assert (
        after[world["a_expired"]] == before[world["a_expired"]]
    ), "an already-expired job keeps its original expiry"


def test_deletion_leaves_other_users_and_anonymous_jobs_untouched(conn, world):
    before = _expiries(conn)
    _run_as_app(conn, world["a"])
    after = _expiries(conn)

    for jid in world["bystanders"]:
        assert after[jid] == before[jid], f"bystander job {jid} changed"
    (live_b,) = conn.execute(
        "SELECT count(*) FROM public.jobs WHERE id = ANY(%s) AND expires_at > now()",
        (world["b_live"] + world["anon"],),
    ).fetchone()
    assert live_b == len(world["b_live"]) + len(
        world["anon"]
    ), "other users' and anon jobs stay live"


def test_deletion_is_idempotent(conn, world):
    first = _run_as_app(conn, world["a"])
    after_first = _expiries(conn)
    second = _run_as_app(conn, world["a"])
    after_second = _expiries(conn)

    assert first == len(world["a_live"])
    assert second == 0, "a retried deletion updates nothing"
    assert after_second == after_first, "and changes no row, the user's or anyone else's"


def test_deletion_of_a_user_with_no_jobs_touches_nothing(conn, world):
    nobody = _user(conn, "none")
    conn.commit()
    before = _expiries(conn)
    assert _run_as_app(conn, nobody) == 0
    assert _expiries(conn) == before


def test_rolled_back_deletion_leaves_jobs_live(conn, world):
    """The route runs the statement in a tx that a failed Stripe cancel rolls back."""
    before = _expiries(conn)
    conn.execute("SET ROLE stemloops_app")
    conn.execute(_route_expiry_sql(), (world["a"],))
    conn.rollback()
    conn.execute("RESET ROLE")
    assert _expiries(conn) == before
