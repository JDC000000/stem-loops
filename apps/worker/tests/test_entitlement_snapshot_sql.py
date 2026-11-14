"""entitlements.ts::readSnapshot picks WHICH subscription decides the user's plan. Real Postgres.

Mutation sweep 2026-11-12 (W6): the LATERAL subquery's ORDER BY in readSnapshot() is the only
thing that decides, for a user with more than one `subscriptions` row, whether the paying one or
a dead one is fed to effectivePlanCode(). The web suite's fake DB cannot evaluate SQL, so
flipping `(status IN ('active','trialing')) DESC` to `ASC` passed all 1543 web tests: a Pro
customer who had once cancelled and re-subscribed would be read as `canceled` and served Free.

This file reads that statement OUT OF entitlements.ts (it is not a mirror) and runs it against
the migrated schema. Skipped without DATABASE_URL; refused on non-local hosts (it INSERTs into
auth.users), same guard as test_credit_consume.py.
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(
        reason="entitlement snapshot tests INSERT into auth.users; local throwaway DB only"
    )

EMAIL_PREFIX = "test-ent-snapshot-"
ENTITLEMENTS_TS = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "web"
    / "src"
    / "lib"
    / "billing"
    / "entitlements.ts"
)


def _snapshot_sql() -> str:
    """The `db.query<EntitlementRow>(` statement in readSnapshot, with $1 -> %(p1)s."""
    src = ENTITLEMENTS_TS.read_text()
    body = src[src.index("async function readSnapshot") :]
    m = re.search(r"db\.query<EntitlementRow>\(\s*`([^`]*)`", body)
    assert m, "readSnapshot's entitlements query not found in entitlements.ts"
    return re.sub(r"\$(\d+)", r"%(p\1)s", m.group(1))


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    like = f"(SELECT id FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%')"
    c.execute(
        f"UPDATE public.entitlements SET source_subscription_id = NULL WHERE user_id IN {like}"
    )
    c.execute(f"DELETE FROM public.subscriptions WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.entitlements WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.execute(f"DELETE FROM auth.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.commit()


def _user(conn: Any, suffix: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (user_id, f"{EMAIL_PREFIX}{suffix}-{user_id.hex[:8]}@example.com"),
    )
    now = datetime.now(UTC)
    conn.execute(
        "UPDATE public.entitlements SET plan_code = 'pro', period_start = %s, period_end = %s "
        "WHERE user_id = %s",
        (now - timedelta(days=5), now + timedelta(days=25), user_id),
    )
    conn.commit()
    return user_id


def _sub(conn: Any, user_id: uuid.UUID, status: str, start_days: int, end_days: int) -> None:
    now = datetime.now(UTC)
    conn.execute(
        "INSERT INTO public.subscriptions (user_id, provider, provider_subscription_id, plan_code,"
        " status, current_period_start, current_period_end) VALUES (%s, 'stripe', %s, 'pro', %s, %s, %s)",
        (
            user_id,
            f"sub_test_{uuid.uuid4().hex}",
            status,
            now + timedelta(days=start_days),
            now + timedelta(days=end_days),
        ),
    )
    conn.commit()


def _picked(conn: Any, user_id: uuid.UUID) -> str | None:
    cur = conn.execute(_snapshot_sql(), {"p1": str(user_id)})
    cols = [d.name for d in cur.description]
    rows = cur.fetchall()
    assert len(rows) == 1, rows
    return dict(zip(cols, rows[0], strict=True))["sub_status"]


def test_an_active_subscription_wins_over_a_canceled_one_with_a_later_period_end(conn):
    """Cancelled an annual plan, re-subscribed monthly: the live monthly sub must decide."""
    u = _user(conn, "active-vs-canceled")
    _sub(conn, u, "canceled", -30, 300)
    _sub(conn, u, "active", -5, 25)
    assert _picked(conn, u) == "active"


def test_trialing_wins_over_past_due_and_past_due_wins_over_canceled(conn):
    u = _user(conn, "trialing-vs-past-due")
    _sub(conn, u, "past_due", -3, 27)
    _sub(conn, u, "trialing", -1, 13)
    assert _picked(conn, u) == "trialing"

    v = _user(conn, "past-due-vs-canceled")
    _sub(conn, v, "canceled", -10, 200)
    _sub(conn, v, "past_due", -3, 27)
    assert _picked(conn, v) == "past_due"


def test_among_equals_the_latest_period_end_wins_and_no_sub_reads_null(conn):
    u = _user(conn, "two-canceled")
    _sub(conn, u, "canceled", -90, -60)
    _sub(conn, u, "incomplete", -2, 28)
    assert _picked(conn, u) == "incomplete"

    w = _user(conn, "no-sub")
    assert _picked(conn, w) is None
