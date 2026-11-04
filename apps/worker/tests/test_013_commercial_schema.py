"""Migration 013 regression tests: credits trigger + balance view + signup trigger.

Covers the three invariants PR #21 claims:
  1. check_credit_decrement rejects credit_consumption against non-upload jobs
     (processor separation TSD §1.2a).
  2. v_credit_balance derives credits_remaining correctly from the two ledgers.
  3. handle_new_user seeds both public.users and a 'free' entitlements row on
     auth.users insert.

Also covers the UNIQUE defences:
  4. (provider, provider_charge_id) uniqueness prevents double-granting credits
     when Stripe webhook retries.
  5. credit_consumption.job_id uniqueness prevents double-charge per job.

These tests require a real Postgres (not sqlite) because they exercise plpgsql
triggers and FKs. Skipped without DATABASE_URL; refused on non-local hosts
because they INSERT into auth.users via the service role.
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
        reason="013 tests INSERT into auth.users; local throwaway DB only"
    )


@pytest.fixture
def conn():
    """Fresh connection; cleans up test rows at teardown.

    Does not drop tables — runs against a schema with migrations 001-014
    already applied (Makefile `migrate` target or CI-provisioned Postgres).
    """
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        # Wipe any prior test fixture rows. Order respects FKs.
        c.execute(
            "DELETE FROM public.credit_consumption WHERE user_id IN "
            "(SELECT id FROM public.users WHERE email LIKE 'test-013-%')"
        )
        c.execute(
            "DELETE FROM public.credit_purchases WHERE user_id IN "
            "(SELECT id FROM public.users WHERE email LIKE 'test-013-%')"
        )
        c.execute(
            "DELETE FROM public.entitlements WHERE user_id IN "
            "(SELECT id FROM public.users WHERE email LIKE 'test-013-%')"
        )
        c.execute("DELETE FROM public.users WHERE email LIKE 'test-013-%'")
        c.execute("DELETE FROM auth.users WHERE email LIKE 'test-013-%'")
        c.commit()
        yield c


def _insert_auth_user(conn: Any, email: str) -> uuid.UUID:
    """Insert into auth.users and return its id. Trips the handle_new_user trigger."""
    user_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (user_id, email),
    )
    conn.commit()
    return user_id


def _insert_job(conn: Any, user_id: uuid.UUID, input_kind: str = "upload") -> uuid.UUID:
    """Insert a job row and return its id. input_kind controls trigger behavior.

    Satisfies the full jobs schema: loop_length_bars + client_ip_hash are NOT
    NULL (migration 001), and the jobs_input_source_chk CHECK (migration 004)
    requires upload_r2_key for upload jobs OR youtube_url for youtube jobs.
    """
    job_id = uuid.uuid4()
    if input_kind == "upload":
        conn.execute(
            "INSERT INTO public.jobs "
            "(id, input_kind, status, user_id, loop_length_bars, "
            " client_ip_hash, upload_r2_key) "
            "VALUES (%s, %s, 'done', %s, 4, 'test-013-ip-hash', %s)",
            (job_id, input_kind, user_id, f"test-013-{job_id}.wav"),
        )
    else:  # 'youtube' (link ingest) — the trigger-reject branch
        conn.execute(
            "INSERT INTO public.jobs "
            "(id, input_kind, status, user_id, loop_length_bars, "
            " client_ip_hash, youtube_url) "
            "VALUES (%s, 'youtube', 'done', %s, 4, 'test-013-ip-hash', %s)",
            (job_id, user_id, "https://www.youtube.com/watch?v=test0000013"),
        )
    conn.commit()
    return job_id


# --- 1. check_credit_decrement trigger (processor separation §1.2a) -----


def test_trigger_accepts_upload_job(conn):
    user_id = _insert_auth_user(conn, "test-013-upload@example.com")
    job_id = _insert_job(conn, user_id, input_kind="upload")

    conn.execute(
        "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
        (user_id, job_id),
    )
    conn.commit()

    cur = conn.execute(
        "SELECT COUNT(*) FROM public.credit_consumption WHERE job_id = %s", (job_id,)
    )
    assert cur.fetchone()[0] == 1


def test_trigger_rejects_link_job(conn):
    user_id = _insert_auth_user(conn, "test-013-link@example.com")
    # 'youtube' is the only non-'upload' value accepted by the jobs CHECK
    # (migration 004); it is also what TSD §1.2a calls the link-ingest path.
    job_id = _insert_job(conn, user_id, input_kind="youtube")

    with pytest.raises(psycopg.errors.RaiseException) as excinfo:
        conn.execute(
            "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
            (user_id, job_id),
        )
    # Reset the aborted transaction so teardown's DELETEs still work.
    conn.rollback()
    assert "input_kind=upload" in str(excinfo.value)
    assert "§1.2a" in str(excinfo.value)


def test_trigger_rejects_missing_job(conn):
    user_id = _insert_auth_user(conn, "test-013-missing@example.com")
    # job FK would catch this before the trigger ever fires in a real insert,
    # but we also want to confirm the trigger handles a NULL input_kind path.
    # Here we rely on the FK (RESTRICT ON DELETE) catching first:
    with pytest.raises((psycopg.errors.ForeignKeyViolation, psycopg.errors.RaiseException)):
        conn.execute(
            "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
            (user_id, uuid.uuid4()),
        )
    conn.rollback()


# --- 2. v_credit_balance view derives correctly ---------------------------


def test_balance_starts_at_zero(conn):
    user_id = _insert_auth_user(conn, "test-013-balance0@example.com")
    cur = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s",
        (user_id,),
    )
    assert cur.fetchone()[0] == 0


def test_balance_adds_purchase(conn):
    user_id = _insert_auth_user(conn, "test-013-balance20@example.com")
    conn.execute(
        "INSERT INTO public.credit_purchases "
        "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
        "VALUES (%s, 'stripe', 'ch_test_0001', 'credits_20', 20, 500)",
        (user_id,),
    )
    conn.commit()
    cur = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s",
        (user_id,),
    )
    assert cur.fetchone()[0] == 20


def test_balance_subtracts_consumption(conn):
    user_id = _insert_auth_user(conn, "test-013-balance19@example.com")
    conn.execute(
        "INSERT INTO public.credit_purchases "
        "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
        "VALUES (%s, 'stripe', 'ch_test_0002', 'credits_20', 20, 500)",
        (user_id,),
    )
    job_id = _insert_job(conn, user_id, input_kind="upload")
    conn.execute(
        "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
        (user_id, job_id),
    )
    conn.commit()
    cur = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s",
        (user_id,),
    )
    assert cur.fetchone()[0] == 19


def test_balance_sums_multiple_purchases(conn):
    user_id = _insert_auth_user(conn, "test-013-balance80@example.com")
    for idx, (pack, qty) in enumerate([("credits_20", 20), ("credits_60", 60)]):
        conn.execute(
            "INSERT INTO public.credit_purchases "
            "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
            "VALUES (%s, 'stripe', %s, %s, %s, %s)",
            (user_id, f"ch_test_sum_{idx}", pack, qty, qty * 25),
        )
    conn.commit()
    cur = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s",
        (user_id,),
    )
    assert cur.fetchone()[0] == 80


# --- 3. handle_new_user trigger ------------------------------------------


def test_signup_seeds_public_users(conn):
    user_id = _insert_auth_user(conn, "test-013-signup@example.com")
    cur = conn.execute("SELECT email FROM public.users WHERE id = %s", (user_id,))
    row = cur.fetchone()
    assert row is not None, "handle_new_user did not seed public.users"
    assert row[0] == "test-013-signup@example.com"


def test_signup_seeds_free_entitlement(conn):
    user_id = _insert_auth_user(conn, "test-013-entitlement@example.com")
    cur = conn.execute("SELECT plan_code FROM public.entitlements WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    assert row is not None, "handle_new_user did not seed entitlements"
    assert row[0] == "free"


# --- 4. UNIQUE defences (idempotency against webhook retries) ------------


def test_duplicate_charge_rejected(conn):
    user_id = _insert_auth_user(conn, "test-013-dup-charge@example.com")
    conn.execute(
        "INSERT INTO public.credit_purchases "
        "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
        "VALUES (%s, 'stripe', 'ch_test_dup_0001', 'credits_20', 20, 500)",
        (user_id,),
    )
    conn.commit()
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "INSERT INTO public.credit_purchases "
            "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
            "VALUES (%s, 'stripe', 'ch_test_dup_0001', 'credits_20', 20, 500)",
            (user_id,),
        )
    conn.rollback()


def test_duplicate_consumption_rejected(conn):
    user_id = _insert_auth_user(conn, "test-013-dup-consume@example.com")
    job_id = _insert_job(conn, user_id, input_kind="upload")
    conn.execute(
        "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
        (user_id, job_id),
    )
    conn.commit()
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
            (user_id, job_id),
        )
    conn.rollback()


# --- 5. CHECK constraints -------------------------------------------------


def test_invalid_pack_code_rejected(conn):
    user_id = _insert_auth_user(conn, "test-013-bad-pack@example.com")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO public.credit_purchases "
            "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
            "VALUES (%s, 'stripe', 'ch_test_bad_0001', 'credits_9999', 20, 500)",
            (user_id,),
        )
    conn.rollback()


def test_invalid_credits_granted_rejected(conn):
    user_id = _insert_auth_user(conn, "test-013-bad-qty@example.com")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO public.credit_purchases "
            "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
            "VALUES (%s, 'stripe', 'ch_test_bad_qty', 'credits_20', 19, 500)",
            (user_id,),
        )
    conn.rollback()


def test_invalid_provider_rejected(conn):
    user_id = _insert_auth_user(conn, "test-013-bad-provider@example.com")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO public.credit_purchases "
            "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_usd_cents) "
            "VALUES (%s, 'patreon', 'ch_test_bad_prov', 'credits_20', 20, 500)",
            (user_id,),
        )
    conn.rollback()
