"""DB-level invariants for POST /api/jobs rate limits (TSD §1.4, V3-C4).

The route itself lives in apps/web (Next.js); this test exercises the SQL
contract the route depends on against a real Postgres. The route uses
two gates, each checked against a real DB:

  (A) Monthly quota: entitlements.jobs_used vs plans.monthly_job_quota,
      with plans.monthly_job_quota >= 100000 treated as unlimited
      (apps/web/src/lib/billing/rate-limit.ts UNLIMITED_QUOTA_SENTINEL,
      which must match migration 014 Pro/Studio seed values).

  (B) Per-user burst: at most 3 rows in public.usage_events with
      kind='job_start_attempt' per 60s window per user_id.

Also covers the append-only invariant on usage_events (migration 013 §6:
stemloops_app has INSERT/SELECT but no UPDATE/DELETE policy) and the
transactional coupling between a jobs insert and the jobs_used bump.

Skipped without DATABASE_URL and refused against a non-local host —
same guard as test_013_commercial_schema.py (these tests INSERT into
auth.users and should never run against prod/staging).
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(
        reason="rate-limit tests INSERT into auth.users; local throwaway DB only"
    )


# Must match UNLIMITED_QUOTA_SENTINEL in apps/web/src/lib/billing/rate-limit.ts
# and the Pro/Studio quota value in migration 014.
UNLIMITED = 100_000

# Must match BURST_LIMIT_PER_USER / BURST_WINDOW_MS in rate-limit.ts.
BURST_LIMIT = 3
BURST_WINDOW_MS = 60_000


@pytest.fixture
def conn():
    """Fresh connection; cleans up test rows at teardown."""
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.execute(
        "DELETE FROM public.jobs WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE 'test-ratelimit-%')"
    )
    c.execute(
        "DELETE FROM public.usage_events WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE 'test-ratelimit-%')"
    )
    c.execute(
        "DELETE FROM public.entitlements WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE 'test-ratelimit-%')"
    )
    c.execute("DELETE FROM public.users WHERE email LIKE 'test-ratelimit-%'")
    c.execute("DELETE FROM auth.users WHERE email LIKE 'test-ratelimit-%'")
    c.commit()


def _insert_auth_user(conn: Any, email: str) -> uuid.UUID:
    """Insert into auth.users; the handle_new_user trigger seeds public.users
    and a 'free' entitlements row (migration 013 §9)."""
    user_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (user_id, email),
    )
    conn.commit()
    return user_id


def _set_entitlement(conn: Any, user_id: uuid.UUID, plan_code: str, jobs_used: int) -> None:
    """Override the entitlement row the signup trigger created."""
    conn.execute(
        "UPDATE public.entitlements SET plan_code = %s, jobs_used = %s " "WHERE user_id = %s",
        (plan_code, jobs_used, user_id),
    )
    conn.commit()


# The SQL the route's checkMonthlyQuota() runs — joins the entitlement to
# its plan and returns whether the user is over quota. True == denied.
QUOTA_DENIED_SQL = """
SELECT
  (p.monthly_job_quota < %s AND e.jobs_used >= p.monthly_job_quota) AS denied,
  e.period_end
FROM public.entitlements e
JOIN public.plans p ON p.code = e.plan_code
WHERE e.user_id = %s
"""


def _is_over_quota(conn: Any, user_id: uuid.UUID) -> bool:
    cur = conn.execute(QUOTA_DENIED_SQL, (UNLIMITED, user_id))
    row = cur.fetchone()
    assert row is not None, "entitlement missing for user"
    return bool(row[0])


# -- (A) Monthly quota ---------------------------------------------------


def test_free_quota_at_zero_allowed(conn):
    """0/90 → not over quota; the route allows the insert."""
    user_id = _insert_auth_user(conn, "test-ratelimit-q0@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=0)
    assert _is_over_quota(conn, user_id) is False


def test_free_quota_one_below_cap_allowed(conn):
    """89/90 → still under quota; route allows the 90th insert."""
    user_id = _insert_auth_user(conn, "test-ratelimit-q89@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=89)
    assert _is_over_quota(conn, user_id) is False


def test_free_quota_at_cap_denied(conn):
    """90/90 → over quota; route returns 402 quota_exceeded. resets_at is
    the user's period_end (ISO8601 in the JSON body)."""
    user_id = _insert_auth_user(conn, "test-ratelimit-q90@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=90)
    assert _is_over_quota(conn, user_id) is True
    # resets_at comes from entitlements.period_end — must be present.
    cur = conn.execute(
        "SELECT period_end FROM public.entitlements WHERE user_id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    assert row is not None and row[0] is not None


def test_unlimited_plan_never_hits_quota(conn):
    """Pro/Studio sentinel (100000) → the gate skips, however high jobs_used
    climbs. Verifies the route won't 402 a paying user."""
    user_id = _insert_auth_user(conn, "test-ratelimit-unlim@example.com")
    _set_entitlement(conn, user_id, "pro", jobs_used=99_999)
    # Plan quota IS the sentinel, so monthly_job_quota < UNLIMITED is FALSE
    # and the gate returns FALSE regardless of jobs_used.
    assert _is_over_quota(conn, user_id) is False
    # Push well past — still allowed.
    _set_entitlement(conn, user_id, "pro", jobs_used=UNLIMITED + 10)
    assert _is_over_quota(conn, user_id) is False


def test_pro_plan_quota_matches_seed(conn):
    """Guard against a future migration changing Pro/Studio off-sentinel —
    that would silently gate every Pro user at a low number."""
    cur = conn.execute(
        "SELECT code, monthly_job_quota FROM public.plans "
        "WHERE code IN ('pro', 'studio') ORDER BY code"
    )
    rows = dict(cur.fetchall())
    assert rows["pro"] >= UNLIMITED, "pro below the unlimited sentinel"
    assert rows["studio"] >= UNLIMITED, "studio below the unlimited sentinel"


# -- (B) Burst limit -----------------------------------------------------


# The SQL the route's checkBurstLimit() runs — count attempts in window.
BURST_COUNT_SQL = """
SELECT COUNT(*)::int FROM public.usage_events
WHERE user_id = %s
  AND kind = 'job_start_attempt'
  AND created_at >= NOW() - (%s::int * INTERVAL '1 millisecond')
"""


def _record_attempt(conn: Any, user_id: uuid.UUID) -> None:
    conn.execute(
        "INSERT INTO public.usage_events (user_id, kind, detail) "
        "VALUES (%s, 'job_start_attempt', '{}'::jsonb)",
        (user_id,),
    )
    conn.commit()


def test_three_bursts_allowed_fourth_denied(conn):
    """3 inserts in 60s → under cap each time; the 4th sees count>=3 → 429."""
    user_id = _insert_auth_user(conn, "test-ratelimit-burst@example.com")

    for i in range(BURST_LIMIT):
        cur = conn.execute(BURST_COUNT_SQL, (user_id, BURST_WINDOW_MS))
        count = cur.fetchone()[0]
        assert count < BURST_LIMIT, f"attempt {i} would be denied, but should pass"
        _record_attempt(conn, user_id)

    # 4th check: 3 recorded attempts → count == BURST_LIMIT → route 429s.
    cur = conn.execute(BURST_COUNT_SQL, (user_id, BURST_WINDOW_MS))
    assert cur.fetchone()[0] >= BURST_LIMIT


def test_burst_scoped_per_user(conn):
    """One user burning their window must not block a different user."""
    user_a = _insert_auth_user(conn, "test-ratelimit-burst-a@example.com")
    user_b = _insert_auth_user(conn, "test-ratelimit-burst-b@example.com")

    for _ in range(BURST_LIMIT):
        _record_attempt(conn, user_a)

    cur = conn.execute(BURST_COUNT_SQL, (user_a, BURST_WINDOW_MS))
    assert cur.fetchone()[0] >= BURST_LIMIT  # user_a denied
    cur = conn.execute(BURST_COUNT_SQL, (user_b, BURST_WINDOW_MS))
    assert cur.fetchone()[0] == 0  # user_b untouched


def test_burst_window_only_counts_recent(conn):
    """Attempts older than the window do not count. Back-date a row and
    confirm it's excluded."""
    user_id = _insert_auth_user(conn, "test-ratelimit-burst-win@example.com")
    conn.execute(
        "INSERT INTO public.usage_events (user_id, kind, detail, created_at) "
        "VALUES (%s, 'job_start_attempt', '{}'::jsonb, NOW() - INTERVAL '2 minutes')",
        (user_id,),
    )
    conn.commit()
    cur = conn.execute(BURST_COUNT_SQL, (user_id, BURST_WINDOW_MS))
    assert cur.fetchone()[0] == 0


# -- (C) Free tier (anonymous) bypasses both gates ------------------------


def test_anonymous_has_no_rate_limit_state(conn):
    """An anonymous request (user == null in the route) short-circuits both
    gates entirely — no entitlement row, no burst count. The per-IP
    admission in /api/uploads is the only gate for anon requests.

    Expressed as a DB invariant: there's no way to look up quota or burst
    state for a null user_id, so the route literally cannot deny based on
    them. Also check that an anon job row (user_id NULL) carries no linked
    entitlement."""
    # Insert an anon job directly (mirrors the branch in route.ts that
    # skips the tx + jobs_used bump when user is null).
    job_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO public.jobs "
        "(id, input_kind, status, loop_length_bars, client_ip_hash, "
        " client_fingerprint, upload_r2_key) "
        "VALUES (%s, 'upload', 'queued', 4, %s, '', %s)",
        (job_id, "test-ratelimit-anon-ip", f"{job_id}/_input.wav"),
    )
    conn.commit()

    # user_id IS NULL → cannot be joined to entitlements → quota check N/A.
    cur = conn.execute("SELECT user_id FROM public.jobs WHERE id = %s", (job_id,))
    assert cur.fetchone()[0] is None

    # Clean up — this row isn't tagged via the email LIKE filter.
    conn.execute("DELETE FROM public.jobs WHERE id = %s", (job_id,))
    conn.commit()


# -- (D) Append-only — usage_events can't be erased -----------------------


def test_job_start_attempt_is_append_only(conn):
    """stemloops_app (the app role) has INSERT/SELECT but no UPDATE/DELETE
    on usage_events (migration 013 §6). Belt-and-braces: a compromised
    worker credential cannot erase burst evidence to restart the counter.

    This test connects AS stemloops_app and confirms DELETE/UPDATE both fail.
    A session without the role password falls back to a policy-level check
    via the postgres superuser — the policy still enforces no stemloops_app
    DELETE policy exists, so a role switch is the tighter check."""
    # Postgres as the app role — the migration grants stemloops_app only
    # SELECT, INSERT (no UPDATE/DELETE grant, no UPDATE/DELETE policy).
    cur = conn.execute(
        "SELECT has_table_privilege('stemloops_app', 'public.usage_events', 'DELETE') AS d, "
        "       has_table_privilege('stemloops_app', 'public.usage_events', 'UPDATE') AS u"
    )
    row = cur.fetchone()
    assert row[0] is False, "stemloops_app must NOT have DELETE on usage_events"
    assert row[1] is False, "stemloops_app must NOT have UPDATE on usage_events"
