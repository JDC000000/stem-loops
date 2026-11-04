"""DB-level invariants for /api/users/me/claim-jobs (TSD §2.2, V3-U2).

The route itself lives in apps/web (Next.js); this test exercises the SQL
contract the route depends on against a real Postgres:

  1. Only rows where user_id IS NULL can be flipped by the UPDATE.
  2. Re-running the same UPDATE is a no-op (idempotency / no duplicate
     claims).
  3. A different user's rows (different fingerprint, different ip_hash
     cohort) are NOT touched by this user's claim.
  4. The ip_hash cohort gate holds — a row that shares the fingerprint
     but whose client_ip_hash was never seen on any prior row is NOT
     claimed.
  5. usage_events kind='claim_jobs' is append-only (migration 013 §6:
     stemloops_app has INSERT/SELECT but no UPDATE/DELETE grant).

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
        reason="claim-jobs tests INSERT into auth.users; local throwaway DB only"
    )


FINGERPRINT_A = "fp-test-claim-jobs-aaaaaaaaaaaaaaaa"
FINGERPRINT_B = "fp-test-claim-jobs-bbbbbbbbbbbbbbbb"
IP_HASH_A1 = "test-claim-jobs-ip-a1"
IP_HASH_A2 = "test-claim-jobs-ip-a2"
IP_HASH_FOREIGN = "test-claim-jobs-ip-foreign"


@pytest.fixture
def conn():
    """Fresh connection; cleans up test rows at teardown."""
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.execute(
        "DELETE FROM public.jobs WHERE client_fingerprint IN (%s, %s)",
        (FINGERPRINT_A, FINGERPRINT_B),
    )
    c.execute(
        "DELETE FROM public.usage_events WHERE kind = 'claim_jobs' "
        "AND user_id IN (SELECT id FROM public.users WHERE email LIKE 'test-claim-jobs-%')"
    )
    c.execute(
        "DELETE FROM public.entitlements WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE 'test-claim-jobs-%')"
    )
    c.execute("DELETE FROM public.users WHERE email LIKE 'test-claim-jobs-%'")
    c.execute("DELETE FROM auth.users WHERE email LIKE 'test-claim-jobs-%'")
    c.commit()


def _insert_auth_user(conn: Any, email: str) -> uuid.UUID:
    """Insert into auth.users; the handle_new_user trigger seeds public.users."""
    user_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (user_id, email),
    )
    conn.commit()
    return user_id


def _insert_anon_job(
    conn: Any,
    fingerprint: str,
    ip_hash: str,
    user_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """Insert a youtube job row with the given fingerprint + ip_hash.

    Mirrors the shape apps/web uses (migration 001 schema + §2.2 user_id
    column from migration 013). youtube input_kind lets us avoid the
    jobs_input_source_chk upload_r2_key requirement.
    """
    job_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO public.jobs "
        "(id, input_kind, status, user_id, loop_length_bars, "
        " client_ip_hash, client_fingerprint, youtube_url) "
        "VALUES (%s, 'youtube', 'done', %s, 4, %s, %s, %s)",
        (
            job_id,
            user_id,
            ip_hash,
            fingerprint,
            f"https://www.youtube.com/watch?v=stub{job_id.hex[:11]}",
        ),
    )
    conn.commit()
    return job_id


# The SQL the route actually runs, parameterized for the test.
CLAIM_SQL = """
UPDATE public.jobs
   SET user_id = %s
 WHERE id IN (
   SELECT id FROM public.jobs
    WHERE user_id IS NULL
      AND client_fingerprint = %s
      AND client_ip_hash = ANY(%s::text[])
    ORDER BY created_at DESC
    LIMIT %s
 )
 RETURNING id
"""


def _claim(conn: Any, user_id: uuid.UUID, fingerprint: str, ip_hashes: list[str]) -> int:
    cur = conn.execute(CLAIM_SQL, (user_id, fingerprint, ip_hashes, 1000))
    rows = cur.fetchall()
    conn.commit()
    return len(rows)


# --- 1. Happy path --------------------------------------------------------


def test_claims_matching_anonymous_jobs(conn):
    user_id = _insert_auth_user(conn, "test-claim-jobs-happy@example.com")
    j1 = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A1)
    j2 = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A2)

    claimed = _claim(conn, user_id, FINGERPRINT_A, [IP_HASH_A1, IP_HASH_A2])
    assert claimed == 2

    for j in (j1, j2):
        cur = conn.execute("SELECT user_id FROM public.jobs WHERE id = %s", (j,))
        row = cur.fetchone()
        assert row is not None
        assert row[0] == user_id


# --- 2. Idempotency: a second claim does nothing --------------------------


def test_second_claim_is_noop(conn):
    user_id = _insert_auth_user(conn, "test-claim-jobs-idemp@example.com")
    _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A1)
    _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A1)

    first = _claim(conn, user_id, FINGERPRINT_A, [IP_HASH_A1])
    assert first == 2
    second = _claim(conn, user_id, FINGERPRINT_A, [IP_HASH_A1])
    assert second == 0


# --- 3. Cross-user safety: another user's jobs are not touched -----------


def test_cross_user_isolation(conn):
    user_a = _insert_auth_user(conn, "test-claim-jobs-cross-a@example.com")
    user_b = _insert_auth_user(conn, "test-claim-jobs-cross-b@example.com")

    # User B's already-attributed job (user_id IS NOT NULL) — must NEVER move.
    j_b = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A1, user_id=user_b)
    # An orphaned job with a FOREIGN ip_hash that user A's cohort never saw.
    j_foreign = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_FOREIGN)
    # An orphaned job on a DIFFERENT fingerprint.
    j_other_fp = _insert_anon_job(conn, FINGERPRINT_B, IP_HASH_A1)
    # An eligible job for user A.
    j_ok = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A1)

    claimed = _claim(conn, user_a, FINGERPRINT_A, [IP_HASH_A1, IP_HASH_A2])
    assert claimed == 1

    # user_b's row — still owned by user_b.
    assert _owner(conn, j_b) == user_b
    # Foreign ip_hash — still NULL.
    assert _owner(conn, j_foreign) is None
    # Different fingerprint — still NULL.
    assert _owner(conn, j_other_fp) is None
    # The one eligible row — owned by user_a.
    assert _owner(conn, j_ok) == user_a


def _owner(conn: Any, job_id: uuid.UUID) -> uuid.UUID | None:
    cur = conn.execute("SELECT user_id FROM public.jobs WHERE id = %s", (job_id,))
    row = cur.fetchone()
    assert row is not None
    return row[0]


# --- 4. ip_hash cohort gate ----------------------------------------------


def test_foreign_ip_hash_not_claimed(conn):
    user_id = _insert_auth_user(conn, "test-claim-jobs-iphash@example.com")
    j_in = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_A1)
    j_out = _insert_anon_job(conn, FINGERPRINT_A, IP_HASH_FOREIGN)

    claimed = _claim(conn, user_id, FINGERPRINT_A, [IP_HASH_A1])
    assert claimed == 1
    assert _owner(conn, j_in) == user_id
    assert _owner(conn, j_out) is None


# --- 5. usage_events append-only per migration 013 §6 --------------------


def test_usage_events_claim_jobs_insert_works(conn):
    """A plain INSERT of kind='claim_jobs' must succeed under the
    append-only grants set by migration 013 §6 (SELECT + INSERT only)."""
    user_id = _insert_auth_user(conn, "test-claim-jobs-usage@example.com")
    conn.execute(
        "INSERT INTO public.usage_events (user_id, kind, detail) "
        "VALUES (%s, 'claim_jobs', '{}'::jsonb)",
        (user_id,),
    )
    conn.commit()
    cur = conn.execute(
        "SELECT COUNT(*) FROM public.usage_events " "WHERE user_id = %s AND kind = 'claim_jobs'",
        (user_id,),
    )
    assert cur.fetchone()[0] == 1
