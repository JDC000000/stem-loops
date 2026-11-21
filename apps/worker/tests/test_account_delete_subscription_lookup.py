"""QA-53: account deletion reads EVERY subscription that can still bill.

DELETE /api/users/me (apps/web/src/app/api/users/me/route.ts) used to read only the
deleting user's active / trialing / past_due subscriptions, so a paused or incomplete
one was never cancelled and could charge after the account was gone. It now reads
every status except 'canceled', plus the user's Stripe customer id (the provider also
lists that customer's subscriptions at Stripe; tested with Stripe mocks in
apps/web/test/account-delete-stripe-cancel.test.mjs).

The web tests stub the database. These run the two SELECTs READ FROM route.ts against
a real local Postgres AS stemloops_app (the production web role; RLS on), and pin:

  1. every subscription of the deleting user whose status is not 'canceled' is
     returned, one per status the DB allows (migration 013's CHECK);
  2. 'canceled' rows and other users' rows are not;
  3. the customer lookup returns that user's Stripe customer id and nobody else's.

Requires a local Postgres with migrations applied; skipped without DATABASE_URL, and
refused for a non-local one by conftest.py (tests/db_guard.py). It INSERTs into auth.users.
"""

from __future__ import annotations

import os
import re
import uuid
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
EMAIL_LIKE = "test-acctdel-subs-%@example.com"
# migration 013: subscriptions.status CHECK
DB_STATUSES = ("trialing", "active", "past_due", "canceled", "incomplete", "paused")


def _route_select(table: str) -> str:
    src = ROUTE.read_text()
    found = re.findall(r"`(\s*SELECT\s+[^`]*FROM\s+public\." + table + r"\b[^`]*)`", src)
    assert (
        len(found) == 1
    ), f"expected one SELECT ... FROM public.{table} in {ROUTE}, got {len(found)}"
    sql = found[0]
    assert "$1" in sql and "$2" in sql and "$3" not in sql, sql
    return sql.replace("$1", "%s").replace("$2", "%s")


def _cleanup(c: Any) -> None:
    c.rollback()
    c.execute("RESET ROLE")
    for t in ("subscriptions", "customers_billing"):
        c.execute(
            f"DELETE FROM public.{t} WHERE user_id IN "
            "(SELECT id FROM public.users WHERE email LIKE %s)",
            (EMAIL_LIKE,),
        )
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.commit()


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _user(c: Any, tag: str) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-acctdel-subs-{tag}-{uid.hex[:8]}@example.com"),
    )
    # public.users is normally filled by the auth trigger; make sure it exists.
    c.execute(
        "INSERT INTO public.users (id, email) SELECT id, email FROM auth.users WHERE id = %s "
        "ON CONFLICT (id) DO NOTHING",
        (uid,),
    )
    return uid


def _sub(c: Any, user: uuid.UUID, status: str) -> str:
    sid = f"sub_acctdel_{status}_{uuid.uuid4().hex[:10]}"
    c.execute(
        "INSERT INTO public.subscriptions (user_id, provider, provider_subscription_id, plan_code, "
        "status, current_period_start, current_period_end) "
        "VALUES (%s, 'stripe', %s, 'pro', %s, now() - interval '1 day', now() + interval '29 days')",
        (user, sid, status),
    )
    return sid


def _customer(c: Any, user: uuid.UUID) -> str:
    cid = f"cus_acctdel_{uuid.uuid4().hex[:12]}"
    c.execute(
        "INSERT INTO public.customers_billing (user_id, provider, provider_customer_id) "
        "VALUES (%s, 'stripe', %s)",
        (user, cid),
    )
    return cid


def _as_app(c: Any, sql: str, params: tuple) -> list:
    c.execute("SET ROLE stemloops_app")
    rows = c.execute(sql, params).fetchall()
    c.rollback()
    c.execute("RESET ROLE")
    return rows


def test_route_selects_every_status_but_canceled():
    sql = " ".join(_route_select("subscriptions").split())
    assert "status <> 'canceled'" in sql, sql
    assert (
        "ANY(" not in sql
    ), "no allow-list of statuses: a status the list forgets is never cancelled"


def test_every_billable_status_is_read_and_canceled_is_not(conn):
    a, b = _user(conn, "a"), _user(conn, "b")
    a_subs = {s: _sub(conn, a, s) for s in DB_STATUSES}
    b_subs = [_sub(conn, b, s) for s in ("active", "paused", "incomplete")]
    conn.commit()

    got = {r[0] for r in _as_app(conn, _route_select("subscriptions"), (a, "stripe"))}
    want = {sid for s, sid in a_subs.items() if s != "canceled"}
    assert got == want, f"missing {want - got}, extra {got - want}"
    for s in ("paused", "incomplete"):
        assert a_subs[s] in got, f"QA-53: a {s} subscription must be cancelled on deletion"
    assert not (got & set(b_subs)), "another user's subscriptions are never read"
    assert _as_app(conn, _route_select("subscriptions"), (a, "paddle")) == []


def test_customer_lookup_returns_only_that_users_stripe_customer(conn):
    a, b, none = _user(conn, "a"), _user(conn, "b"), _user(conn, "none")
    ca, _cb = _customer(conn, a), _customer(conn, b)
    conn.commit()
    assert _as_app(conn, _route_select("customers_billing"), (a, "stripe")) == [(ca,)]
    assert _as_app(conn, _route_select("customers_billing"), (none, "stripe")) == []
