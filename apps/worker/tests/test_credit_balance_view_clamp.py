"""Migration 022 regression test: v_credit_balance never goes negative (review M6).

Applies 022 to the test DB, inserts N consumption rows with zero purchases, and
asserts the view reports 0 (not -N). Also checks a normal purchase-minus-
consumption balance is unchanged and the view stays security_invoker.

Requires a real local Postgres with migrations 001-021 applied; skipped without
DATABASE_URL and refused on non-local hosts (INSERTs into auth.users).
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="022 tests INSERT into auth.users; local DB only")

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "022_v3_credit_balance_clamp.sql"
EMAIL_LIKE = "test-022-%"


def _wipe(c: Any) -> None:
    sub = "(SELECT id FROM public.users WHERE email LIKE %s)"
    c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {sub}", (EMAIL_LIKE,))
    c.execute(f"DELETE FROM public.credit_purchases WHERE user_id IN {sub}", (EMAIL_LIKE,))
    c.execute(f"DELETE FROM public.jobs WHERE user_id IN {sub}", (EMAIL_LIKE,))
    c.execute(f"DELETE FROM public.entitlements WHERE user_id IN {sub}", (EMAIL_LIKE,))
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.commit()


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(MIGRATION.read_text())
        c.commit()
        _wipe(c)
        yield c
        c.rollback()
        _wipe(c)


def _user(conn: Any, email: str) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, email),
    )
    conn.commit()
    return uid


def _consume(conn: Any, uid: uuid.UUID) -> None:
    job_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO public.jobs (id, input_kind, status, user_id, loop_length_bars, "
        "client_ip_hash, upload_r2_key) VALUES (%s, 'upload', 'done', %s, 4, "
        "'test-022-ip-hash', %s)",
        (job_id, uid, f"test-022-{job_id}.wav"),
    )
    conn.execute(
        "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
        (uid, job_id),
    )
    conn.commit()


def _balance(conn: Any, uid: uuid.UUID) -> int:
    row = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s", (uid,)
    ).fetchone()
    return int(row[0])


def test_consumption_without_purchase_clamps_to_zero(conn):
    uid = _user(conn, "test-022-clamp@example.com")
    for _ in range(3):
        _consume(conn, uid)
    assert _balance(conn, uid) == 0


def test_normal_balance_unchanged(conn):
    uid = _user(conn, "test-022-normal@example.com")
    conn.execute(
        "INSERT INTO public.credit_purchases "
        "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_cad_cents) "
        "VALUES (%s, 'stripe', 'ch_test_022_0001', 'credits_20', 20, 500)",
        (uid,),
    )
    conn.commit()
    _consume(conn, uid)
    assert _balance(conn, uid) == 19


def test_view_remains_security_invoker(conn):
    row = conn.execute(
        "SELECT reloptions FROM pg_class WHERE oid = 'public.v_credit_balance'::regclass"
    ).fetchone()
    assert "security_invoker=true" in (row[0] or [])
