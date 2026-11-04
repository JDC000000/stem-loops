"""DB-level invariants for trial_grants (TSD §1.6, V3-C10).

The HTTP route lives in apps/web; this file exercises the SQL contract
the Next.js route and lib/trial.ts both depend on against real Postgres:

  1. Grant is idempotent: INSERT ... ON CONFLICT DO NOTHING on PK=user_id
     means a re-call reads the existing row (no double-grant).
  2. Consume increments songs_used by 1 and the CHECK clamps it at 3.
  3. Default expires_at is granted_at + 7 days (schema default).
  4. An expired grant must NOT be consumable (route uses the same
     "expires_at > now()" guard the test asserts here).
  5. Cross-user isolation: user A's consume does not touch user B's row.

Skipped without DATABASE_URL and refused against a non-local host — same
guard as test_013_commercial_schema.py (these tests INSERT into
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
        reason="trial-grants tests INSERT into auth.users; local throwaway DB only"
    )


EMAIL_PREFIX = "test-trial-grants-"

# The two SQL statements the route runs, kept in sync with apps/web/src/lib/trial.ts.
GRANT_SQL = """
INSERT INTO public.trial_grants (user_id)
VALUES (%s)
ON CONFLICT (user_id) DO NOTHING
RETURNING user_id, granted_at, songs_used, expires_at
"""

CONSUME_SQL = """
UPDATE public.trial_grants
   SET songs_used = songs_used + 1
 WHERE user_id = %s
   AND songs_used < 3
   AND expires_at > now()
 RETURNING user_id, granted_at, songs_used, expires_at
"""


@pytest.fixture
def conn():
    """Fresh connection; cleans up test rows at teardown."""
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.execute(
        "DELETE FROM public.trial_grants WHERE user_id IN "
        f"(SELECT id FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%')"
    )
    c.execute(
        "DELETE FROM public.entitlements WHERE user_id IN "
        f"(SELECT id FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%')"
    )
    c.execute(f"DELETE FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.execute(f"DELETE FROM auth.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.commit()


def _insert_auth_user(conn: Any, suffix: str) -> uuid.UUID:
    """Insert into auth.users; handle_new_user trigger seeds public.users."""
    user_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (user_id, f"{EMAIL_PREFIX}{suffix}@example.com"),
    )
    conn.commit()
    return user_id


def _grant(conn: Any, user_id: uuid.UUID) -> tuple[bool, dict[str, Any] | None]:
    """Run the grant SQL; returns (was_insert, row_or_none).

    Mirrors @/lib/trial grantTrial(): INSERT ... ON CONFLICT DO NOTHING then
    SELECT when nothing was returned.
    """
    cur = conn.execute(GRANT_SQL, (user_id,))
    row = cur.fetchone()
    was_insert = row is not None
    if row is None:
        cur = conn.execute(
            "SELECT user_id, granted_at, songs_used, expires_at "
            "FROM public.trial_grants WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
    conn.commit()
    if row is None:
        return was_insert, None
    cols = ["user_id", "granted_at", "songs_used", "expires_at"]
    return was_insert, dict(zip(cols, row, strict=True))


def _consume(conn: Any, user_id: uuid.UUID) -> dict[str, Any] | None:
    cur = conn.execute(CONSUME_SQL, (user_id,))
    row = cur.fetchone()
    conn.commit()
    if row is None:
        return None
    cols = ["user_id", "granted_at", "songs_used", "expires_at"]
    return dict(zip(cols, row, strict=True))


# --- 1. Idempotency ------------------------------------------------------


def test_grant_is_idempotent(conn):
    u = _insert_auth_user(conn, "idem")
    first_insert, first_row = _grant(conn, u)
    assert first_insert is True
    assert first_row is not None
    assert first_row["songs_used"] == 0

    # Mutate the row so we can tell "read existing" from "re-insert"
    conn.execute("UPDATE public.trial_grants SET songs_used = 1 WHERE user_id = %s", (u,))
    conn.commit()

    second_insert, second_row = _grant(conn, u)
    assert second_insert is False, "second grant must NOT insert"
    assert second_row is not None
    assert second_row["songs_used"] == 1, "existing songs_used must be preserved"
    assert (
        second_row["granted_at"] == first_row["granted_at"]
    ), "granted_at must not be rewritten on re-call"


# --- 2. Consume increments + CHECK caps at 3 -----------------------------


def test_consume_increments_and_caps_at_three(conn):
    u = _insert_auth_user(conn, "cap")
    _grant(conn, u)

    for expected in (1, 2, 3):
        row = _consume(conn, u)
        assert row is not None, f"consume #{expected} must update"
        assert row["songs_used"] == expected

    # 4th consume: the WHERE songs_used < 3 guard trips, 0 rows.
    row = _consume(conn, u)
    assert row is None, "4th consume must update 0 rows (exhausted)"

    # Belt-and-braces: the table CHECK also refuses a raw UPDATE past 3.
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "UPDATE public.trial_grants SET songs_used = songs_used + 1 WHERE user_id = %s",
            (u,),
        )
    conn.rollback()


# --- 3. Default expires_at is granted_at + 7 days ------------------------


def test_default_expiry_is_seven_days(conn):
    u = _insert_auth_user(conn, "exp")
    _, row = _grant(conn, u)
    assert row is not None
    gap = row["expires_at"] - row["granted_at"]
    # 7 days plus/minus a second for clock skew between NOW() calls.
    assert abs(gap.total_seconds() - 7 * 24 * 3600) < 2


# --- 4. Expired grant cannot be consumed ---------------------------------


def test_expired_grant_rejected_by_consume(conn):
    u = _insert_auth_user(conn, "expired")
    _grant(conn, u)
    # Backdate expires_at into the past.
    conn.execute(
        "UPDATE public.trial_grants SET expires_at = now() - interval '1 second' "
        "WHERE user_id = %s",
        (u,),
    )
    conn.commit()
    row = _consume(conn, u)
    assert row is None, "consume must refuse an expired trial"

    # Counter should not have moved.
    cur = conn.execute("SELECT songs_used FROM public.trial_grants WHERE user_id = %s", (u,))
    fetched = cur.fetchone()
    assert fetched is not None
    assert fetched[0] == 0


# --- 5. Cross-user isolation --------------------------------------------


def test_cross_user_isolation(conn):
    a = _insert_auth_user(conn, "iso-a")
    b = _insert_auth_user(conn, "iso-b")
    _grant(conn, a)
    _grant(conn, b)

    _consume(conn, a)
    _consume(conn, a)  # a now at 2

    cur = conn.execute("SELECT songs_used FROM public.trial_grants WHERE user_id = %s", (b,))
    fetched = cur.fetchone()
    assert fetched is not None
    assert fetched[0] == 0, "user B must not be affected by user A's consumes"

    cur = conn.execute("SELECT songs_used FROM public.trial_grants WHERE user_id = %s", (a,))
    fetched = cur.fetchone()
    assert fetched is not None
    assert fetched[0] == 2
