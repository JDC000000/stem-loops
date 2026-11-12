"""DB-level invariants for POST /api/jobs rate limits (TSD §1.4, V3-C4).

The route itself lives in apps/web (Next.js); this test exercises the SQL
contract the route depends on against a real Postgres. The route uses
two gates, each checked against a real DB:

  (A) Monthly quota: entitlements.jobs_used vs plans.monthly_job_quota.
      rate-limit.ts still carries UNLIMITED_QUOTA_SENTINEL (100000) and
      short-circuits at or above it, but as of migration 034 NO PLAN
      REACHES IT -- free 5, pro 50, studio 150 -- so every plan is really
      metered and the sentinel branch is unreachable. These tests assert
      that, rather than the "pro is unlimited" invariant they used to.

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


# Must match UNLIMITED_QUOTA_SENTINEL in apps/web/src/lib/billing/rate-limit.ts.
# Retained because the route still applies it, but migration 034 put every plan
# BELOW it on purpose: an unmetered paid tier is an open-ended cost liability.
# test_plan_quotas_match_migration_034 asserts it stays unreachable.
UNLIMITED = 100_000

# The catalog migration 034_v3_pricing_model_truth.sql installs. Jon's approved
# 2026-11-11 model, metered on tracks converted to play-along per month.
APPROVED_QUOTAS = {"free": 5, "pro": 50, "studio": 150}

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


def _plan_quota(conn: Any, code: str) -> int:
    """The plan's real quota, read from the DB the migrations built.

    The boundary tests below derive their jobs_used from this rather than
    hardcoding 89/90, which is what broke them when the catalog was
    re-priced. The VALUE itself is pinned separately, against literals, in
    test_plan_quotas_match_migration_034 -- so this is not circular: one
    test asserts what the number is, the others assert how the gate behaves
    at its boundary.
    """
    cur = conn.execute("SELECT monthly_job_quota FROM public.plans WHERE code = %s", (code,))
    row = cur.fetchone()
    assert row is not None, f"plan {code} missing from public.plans"
    return int(row[0])


def _is_over_quota(conn: Any, user_id: uuid.UUID) -> bool:
    cur = conn.execute(QUOTA_DENIED_SQL, (UNLIMITED, user_id))
    row = cur.fetchone()
    assert row is not None, "entitlement missing for user"
    return bool(row[0])


# -- (A) Monthly quota ---------------------------------------------------


def test_free_quota_at_zero_allowed(conn):
    """0 used → not over quota; the route allows the insert."""
    user_id = _insert_auth_user(conn, "test-ratelimit-q0@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=0)
    assert _is_over_quota(conn, user_id) is False


def test_free_quota_one_below_cap_allowed(conn):
    """quota-1 used → still under; route allows the last insert."""
    quota = _plan_quota(conn, "free")
    user_id = _insert_auth_user(conn, "test-ratelimit-qunder@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=quota - 1)
    assert _is_over_quota(conn, user_id) is False


def test_free_quota_at_cap_denied(conn):
    """quota/quota → over quota; route returns 402 quota_exceeded. resets_at
    is the user's period_end (ISO8601 in the JSON body)."""
    quota = _plan_quota(conn, "free")
    user_id = _insert_auth_user(conn, "test-ratelimit-qcap@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=quota)
    assert _is_over_quota(conn, user_id) is True
    # resets_at comes from entitlements.period_end — must be present.
    cur = conn.execute(
        "SELECT period_end FROM public.entitlements WHERE user_id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    assert row is not None and row[0] is not None


@pytest.mark.parametrize("code", ["pro", "studio"])
def test_paid_plans_are_really_metered(conn, code):
    """The invariant this REPLACES was "Pro/Studio never hit quota", which
    held because both sat on the 100000 sentinel. Migration 034 retired that:
    an unmetered paid tier is an open-ended cost liability against a real
    per-job Replicate spend. So the paid gate must now actually bite at the
    plan's own boundary -- allowed one below, denied at it."""
    quota = _plan_quota(conn, code)
    assert quota < UNLIMITED, f"{code} is back on the unlimited sentinel"
    user_id = _insert_auth_user(conn, f"test-ratelimit-{code}@example.com")
    _set_entitlement(conn, user_id, code, jobs_used=quota - 1)
    assert _is_over_quota(conn, user_id) is False, f"{code} denied below its quota"
    _set_entitlement(conn, user_id, code, jobs_used=quota)
    assert _is_over_quota(conn, user_id) is True, f"{code} not gated AT its quota"


def test_plan_quotas_match_migration_034(conn):
    """Pins the approved catalog against literals, so a migration that moves a
    quota has to come here and say so. This is the test that makes the
    boundary tests above non-circular: they read the quota from the DB, this
    one asserts what that number must be.

    It also guards the direction the OLD version of this test guarded, from
    the other side: a future migration putting a plan back at or above the
    sentinel would make that plan silently unmetered again."""
    cur = conn.execute(
        "SELECT code, monthly_job_quota FROM public.plans "
        "WHERE code IN ('free', 'pro', 'studio') ORDER BY code"
    )
    rows = dict(cur.fetchall())
    assert (
        rows == APPROVED_QUOTAS
    ), f"plan quotas drifted from the approved model: {rows} != {APPROVED_QUOTAS}"
    for code, quota in rows.items():
        assert 0 < quota < UNLIMITED, f"{code} quota {quota} is not a real bound"


def test_no_plan_advertises_an_unbuilt_export(conn):
    """Migration 034 sets export_stems and export_wav24 false on every plan:
    there is no stem-export route, and 24-bit WAV loops are available on every
    tier rather than being a paid differentiator. A plan row flipping either
    back to true would make /pricing advertise a capability the app lacks."""
    cur = conn.execute("SELECT code, export_stems, export_wav24 FROM public.plans ORDER BY code")
    for code, stems, wav24 in cur.fetchall():
        assert stems is False, f"{code}.export_stems is true but no stem-export route exists"
        assert wav24 is False, f"{code}.export_wav24 is true but every tier gets 24-bit WAV"


def test_no_plan_lists_an_unimplemented_service(conn):
    """Spotify and SoundCloud have no downloader, route or error code anywhere
    in the repo. They were on the free plan row, so /pricing advertised both.
    Migration 034 removed them; this stops them coming back."""
    cur = conn.execute("SELECT code, services FROM public.plans ORDER BY code")
    for code, services in cur.fetchall():
        for bad in ("spotify", "soundcloud"):
            assert bad not in (
                services or []
            ), f"{code}.services lists {bad!r}, which has no implementation"


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
    on usage_events (migration 013 §6 + migration 017 explicit REVOKE).
    Belt-and-braces: a compromised worker credential cannot erase burst
    evidence to restart the counter.

    PR #33 round-2 context: 011_role_catchup's ALTER DEFAULT PRIVILEGES
    granted all CRUD to stemloops_app on future tables, so 013's plain
    GRANT SELECT, INSERT did NOT remove the inherited UPDATE/DELETE on
    usage_events. Migration 017 adds the missing REVOKE."""
    # Postgres role grants — the migrations grant stemloops_app only
    # SELECT, INSERT (no UPDATE/DELETE grant, no UPDATE/DELETE policy).
    cur = conn.execute(
        "SELECT has_table_privilege('stemloops_app', 'public.usage_events', 'DELETE') AS d, "
        "       has_table_privilege('stemloops_app', 'public.usage_events', 'UPDATE') AS u"
    )
    row = cur.fetchone()
    assert row[0] is False, "stemloops_app must NOT have DELETE on usage_events"
    assert row[1] is False, "stemloops_app must NOT have UPDATE on usage_events"


@pytest.mark.parametrize(
    "table",
    ["credit_purchases", "credit_consumption", "promo_redemptions"],
)
def test_other_append_only_tables_also_revoked(conn, table):
    """Same invariant for the other three tables migration 013 declared
    append-only. Without migration 017 these would inherit UPDATE/DELETE
    from 011's ALTER DEFAULT PRIVILEGES, breaking the audit trail."""
    cur = conn.execute(
        "SELECT has_table_privilege('stemloops_app', %s, 'DELETE') AS d, "
        "       has_table_privilege('stemloops_app', %s, 'UPDATE') AS u",
        (f"public.{table}", f"public.{table}"),
    )
    row = cur.fetchone()
    assert row[0] is False, f"stemloops_app must NOT have DELETE on {table}"
    assert row[1] is False, f"stemloops_app must NOT have UPDATE on {table}"


# -- (E) incrementJobsUsed UPSERT + period rollover -----------------------
#
# These exercise the SQL emitted by incrementJobsUsed() in
# apps/web/src/lib/billing/rate-limit.ts. The web-side test harness doesn't
# own a Postgres, so the invariant is pinned here against a real DB.

INCREMENT_SQL = """
INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end, jobs_used)
VALUES (
  %s::uuid,
  'free',
  date_trunc('month', now()),
  date_trunc('month', now()) + interval '1 month',
  1
)
ON CONFLICT (user_id) DO UPDATE SET
  jobs_used = CASE
    WHEN public.entitlements.period_end <= now() THEN 1
    ELSE public.entitlements.jobs_used + 1
  END,
  period_start = CASE
    WHEN public.entitlements.period_end <= now() THEN date_trunc('month', now())
    ELSE public.entitlements.period_start
  END,
  period_end = CASE
    WHEN public.entitlements.period_end <= now()
      THEN date_trunc('month', now()) + interval '1 month'
    ELSE public.entitlements.period_end
  END
"""


def test_increment_creates_row_when_missing(conn):
    """When no entitlement row exists (e.g. the handle_new_user trigger has
    not run yet for this user), the UPSERT must seed a free-tier row with
    jobs_used = 1 and the current calendar month as the period. Prevents
    the silent-no-op quota bypass identified in PR #33 round-2 review."""
    user_id = _insert_auth_user(conn, "test-ratelimit-upsert-missing@example.com")
    # Remove the row the handle_new_user trigger seeded so we exercise the
    # row-missing branch of the UPSERT.
    conn.execute("DELETE FROM public.entitlements WHERE user_id = %s", (user_id,))
    conn.commit()

    conn.execute(INCREMENT_SQL, (user_id,))
    conn.commit()

    cur = conn.execute(
        "SELECT plan_code, jobs_used, "
        "       period_start = date_trunc('month', now()) AS start_ok, "
        "       period_end   = date_trunc('month', now()) + interval '1 month' AS end_ok "
        "FROM public.entitlements WHERE user_id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    assert row is not None, "UPSERT must INSERT when the row is missing"
    assert row[0] == "free"
    assert row[1] == 1
    assert row[2] is True
    assert row[3] is True


def test_increment_bumps_within_current_period(conn):
    """Row present, period still current → jobs_used = jobs_used + 1, and
    neither period_start nor period_end moves."""
    user_id = _insert_auth_user(conn, "test-ratelimit-upsert-current@example.com")
    _set_entitlement(conn, user_id, "free", jobs_used=5)
    cur = conn.execute(
        "SELECT period_start, period_end FROM public.entitlements WHERE user_id = %s",
        (user_id,),
    )
    before = cur.fetchone()

    conn.execute(INCREMENT_SQL, (user_id,))
    conn.commit()

    cur = conn.execute(
        "SELECT jobs_used, period_start, period_end " "FROM public.entitlements WHERE user_id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    assert row[0] == 6
    assert row[1] == before[0]
    assert row[2] == before[1]


def test_increment_rolls_over_stale_period(conn):
    """Row present but period_end is in the past → jobs_used resets to 1 and
    period_start / period_end jump to the current calendar month. Verifies
    PR #33 round-2 review fix #3."""
    user_id = _insert_auth_user(conn, "test-ratelimit-upsert-stale@example.com")
    # Back-date the period two months so NOW() > period_end.
    conn.execute(
        "UPDATE public.entitlements SET "
        "  jobs_used = 90, "
        "  period_start = date_trunc('month', now() - interval '2 months'), "
        "  period_end   = date_trunc('month', now() - interval '1 month') "
        "WHERE user_id = %s",
        (user_id,),
    )
    conn.commit()

    conn.execute(INCREMENT_SQL, (user_id,))
    conn.commit()

    cur = conn.execute(
        "SELECT jobs_used, "
        "       period_start = date_trunc('month', now()) AS start_ok, "
        "       period_end   = date_trunc('month', now()) + interval '1 month' AS end_ok "
        "FROM public.entitlements WHERE user_id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    assert row[0] == 1, "stale period must reset jobs_used, not keep bumping it"
    assert row[1] is True
    assert row[2] is True
