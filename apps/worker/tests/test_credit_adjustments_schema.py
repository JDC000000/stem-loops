"""Migration 023 (credit_adjustments) regression tests — credit-ledger review M4.

Covers: the balance view includes adjustments, the Stripe-retry idempotency
UNIQUE, one-refund-per-charge, the append-only REVOKE for stemloops_app, and
the down-migration round trip. Requires a real local Postgres with migrations
applied through 023; skipped without DATABASE_URL, refused on non-local hosts.
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
    pytestmark = pytest.mark.skip(
        reason="023 tests INSERT into auth.users; local throwaway DB only"
    )

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
EMAIL = "test-credadj-%@example.com"


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    # credit_adjustments / credit_purchases cascade from public.users.
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL,))
    c.commit()


def _user(conn: Any, tag: str) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-credadj-{tag}@example.com"),
    )
    conn.commit()
    return uid


def _purchase(conn: Any, uid: uuid.UUID, charge: str, credits: int = 20) -> None:
    pack = {20: "credits_20", 60: "credits_60", 180: "credits_180"}[credits]
    conn.execute(
        "INSERT INTO public.credit_purchases (user_id, provider, provider_charge_id, "
        "pack_code, credits_granted, amount_cad_cents) VALUES (%s,'stripe',%s,%s,%s,0)",
        (uid, charge, pack, credits),
    )
    conn.commit()


def _adjust(conn: Any, uid: uuid.UUID, delta: int, event: str, charge: str | None = None) -> None:
    conn.execute(
        "INSERT INTO public.credit_adjustments (user_id, credits_delta, reason, provider, "
        "provider_event_id, provider_charge_id) VALUES (%s,%s,'refund','stripe',%s,%s)",
        (uid, delta, event, charge),
    )


def _balance(conn: Any, uid: uuid.UUID) -> int:
    row = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s", (uid,)
    ).fetchone()
    assert row is not None
    return int(row[0])


def test_refund_adjustment_reduces_balance(conn):
    uid = _user(conn, "bal")
    _purchase(conn, uid, "pi_credadj_bal", 60)
    assert _balance(conn, uid) == 60
    _adjust(conn, uid, -60, "evt_credadj_bal", "pi_credadj_bal")
    conn.commit()
    assert _balance(conn, uid) == 0


def test_duplicate_provider_event_id_blocked(conn):
    uid = _user(conn, "dupe")
    _adjust(conn, uid, -20, "evt_credadj_dupe", "pi_credadj_dupe")
    conn.commit()
    with pytest.raises(psycopg.errors.UniqueViolation):
        _adjust(conn, uid, -20, "evt_credadj_dupe", "pi_credadj_dupe_other")
    conn.rollback()


def test_second_refund_event_for_same_charge_blocked(conn):
    uid = _user(conn, "charge")
    _adjust(conn, uid, -20, "evt_credadj_c1", "pi_credadj_charge")
    conn.commit()
    with pytest.raises(psycopg.errors.UniqueViolation):
        _adjust(conn, uid, -20, "evt_credadj_c2", "pi_credadj_charge")
    conn.rollback()


def test_zero_delta_rejected(conn):
    uid = _user(conn, "zero")
    with pytest.raises(psycopg.errors.CheckViolation):
        _adjust(conn, uid, 0, "evt_credadj_zero")
    conn.rollback()


def test_stemloops_app_is_append_only(conn):
    """stemloops_app may SELECT/INSERT but holds no UPDATE/DELETE privilege."""
    rows = conn.execute(
        "SELECT privilege_type FROM information_schema.role_table_grants "
        "WHERE table_schema='public' AND table_name='credit_adjustments' "
        "AND grantee='stemloops_app'"
    ).fetchall()
    privs = {r[0] for r in rows}
    assert {"SELECT", "INSERT"} <= privs
    assert "UPDATE" not in privs
    assert "DELETE" not in privs


def test_down_migration_round_trip(conn):
    """Down restores the 013 view and drops the table; re-applying 023 restores both."""
    down = (MIGRATIONS / "down" / "023_v3_credit_adjustments_down.sql").read_text()
    up = (MIGRATIONS / "023_v3_credit_adjustments.sql").read_text()
    try:
        conn.execute(down)
        conn.commit()
        exists = conn.execute("SELECT to_regclass('public.credit_adjustments')").fetchone()
        assert exists is not None and exists[0] is None
        # View still resolves after down.
        conn.execute("SELECT credits_remaining FROM public.v_credit_balance LIMIT 1")
    finally:
        conn.rollback()
        conn.execute(up)
        conn.commit()
    exists = conn.execute("SELECT to_regclass('public.credit_adjustments')").fetchone()
    assert exists is not None and exists[0] is not None
