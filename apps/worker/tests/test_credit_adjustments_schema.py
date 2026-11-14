"""Migration 023 (credit_adjustments) regression tests — credit-ledger review M4.

Covers: the balance view includes adjustments, the Stripe-retry idempotency
UNIQUE, per-charge refund stacking (024), the append-only REVOKE for stemloops_app, and
the down-migration round trip. Requires a real local Postgres with migrations
applied through 024; skipped without DATABASE_URL, refused on non-local hosts.
"""

from __future__ import annotations

import contextlib
import os
import uuid
from collections.abc import Iterator
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


@pytest.fixture(autouse=True)
def bystander_refund():
    """A refunded user this module did not create: bought 60 credits, was clawed back 60.

    Clawbacks are stored as NEGATIVE `credits_delta` and `v_credit_balance` sums them, so
    this user's balance is 0 only while their `credit_adjustments` row exists. Dropping the
    table (down/023) makes it 60: the refunded user gets their credits back. Its email does
    not match the `test-credadj-%` pattern the `conn` fixture purges, so nothing in this
    module deletes it. Teardown asserts the row and the balance are exactly as seeded, then
    deletes the user by id (only ever this fixture's own row; purchases and adjustments
    cascade from it).
    """
    uid = uuid.uuid4()
    tag = uuid.uuid4().hex[:12]
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(
            "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
            "email_confirmed_at, created_at, updated_at) "
            "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
            (uid, f"bystander-credadj-{tag}@example.org"),
        )
        c.execute(
            "INSERT INTO public.credit_purchases (user_id, provider, provider_charge_id, "
            "pack_code, credits_granted, amount_cad_cents) VALUES (%s,'stripe',%s,'credits_60',60,0)",
            (uid, f"pi_bystander_{tag}"),
        )
        c.execute(
            "INSERT INTO public.credit_adjustments (user_id, credits_delta, reason, provider, "
            "provider_event_id, provider_charge_id) VALUES (%s,-60,'refund','stripe',%s,%s)",
            (uid, f"evt_bystander_{tag}", f"pi_bystander_{tag}"),
        )
        c.commit()
    try:
        yield uid
    finally:
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            try:
                adj = c.execute(
                    "SELECT count(*), COALESCE(sum(credits_delta), 0) "
                    "FROM public.credit_adjustments WHERE user_id = %s",
                    (uid,),
                ).fetchone()
                bal = c.execute(
                    "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s",
                    (uid,),
                ).fetchone()
            except psycopg.Error as e:  # table dropped and not restored
                adj, bal = f"unreadable: {e}", None
                c.rollback()
            c.execute("DELETE FROM public.users WHERE id = %s", (uid,))
            c.execute("DELETE FROM auth.users WHERE id = %s", (uid,))
            c.commit()
        assert (adj, bal) == ((1, -60), (0,)), (
            "the bystander's refund was lost or its balance changed by a test in this module: "
            f"adjustments (count, sum) = {adj}, v_credit_balance row = {bal} (expected "
            "(1, -60) and (0,))"
        )


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


def _user(conn: Any, tag: str, commit: bool = True) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-credadj-{tag}@example.com"),
    )
    if commit:  # False inside _rolled_back_session: a commit there would commit the DROP
        conn.commit()
    return uid


def _purchase(
    conn: Any, uid: uuid.UUID, charge: str, credits: int = 20, commit: bool = True
) -> None:
    pack = {20: "credits_20", 60: "credits_60", 180: "credits_180"}[credits]
    conn.execute(
        "INSERT INTO public.credit_purchases (user_id, provider, provider_charge_id, "
        "pack_code, credits_granted, amount_cad_cents) VALUES (%s,'stripe',%s,%s,%s,0)",
        (uid, charge, pack, credits),
    )
    if commit:
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


def test_second_refund_event_for_same_charge_allowed_after_024(conn):
    """024 dropped the one-refund-per-charge UNIQUE so pro-rata partials can stack."""
    uid = _user(conn, "charge")
    _adjust(conn, uid, -20, "evt_credadj_c1", "pi_credadj_charge")
    _adjust(conn, uid, -20, "evt_credadj_c2", "pi_credadj_charge")
    conn.commit()


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


@contextlib.contextmanager
def _rolled_back_session() -> Iterator[Any]:
    """One connection, one transaction, ALWAYS rolled back (the pattern of
    test_033_cut_at_backfill._session and, for chord edits, PR #226).

    Deliberately not `with psycopg.connect(...)`, whose context manager COMMITS on a clean
    exit. down/023 DROPs the refund ledger; inside this session the DROP, the re-applied
    migrations and every row the test writes disappear together, so the session database
    is exactly as it was found and no list of migrations has to be re-applied by hand.
    NOTHING run under this session may call `commit()` -- that would commit the DROP.
    """
    conn = psycopg.connect(DB)  # type: ignore[arg-type]
    try:
        conn.execute("SET statement_timeout = 30000")
        conn.execute("SET lock_timeout = 30000")
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _read_migrations() -> tuple[str, str, str]:
    return (
        (MIGRATIONS / "down" / "023_v3_credit_adjustments_down.sql").read_text(),
        (MIGRATIONS / "023_v3_credit_adjustments.sql").read_text(),
        (MIGRATIONS / "024_v3_credit_adjustments_partial_refund_index.sql").read_text(),
    )


def test_down_migration_round_trip():
    """Down restores the 013 view and drops the table; re-applying 023 restores both."""
    down, up, up024 = _read_migrations()
    with _rolled_back_session() as c:
        c.execute(down)
        exists = c.execute("SELECT to_regclass('public.credit_adjustments')").fetchone()
        assert exists is not None and exists[0] is None
        # View still resolves after down.
        c.execute("SELECT credits_remaining FROM public.v_credit_balance LIMIT 1")
        c.execute(up)
        # Re-apply 024 too so we assert the real post-024 schema, not a 023-only one.
        c.execute(up024)
        exists = c.execute("SELECT to_regclass('public.credit_adjustments')").fetchone()
        assert exists is not None and exists[0] is not None
        # View must be the full 022 + 023 definition: clamp AND adjustments term.
        viewdef = c.execute("SELECT pg_get_viewdef('public.v_credit_balance'::regclass)").fetchone()
        assert viewdef is not None
        assert "credit_adjustments" in viewdef[0]
        assert "GREATEST" in viewdef[0].upper()
        # Behavioural check: the re-applied view counts adjustments.
        tag = uuid.uuid4().hex[:10]
        uid = _user(c, f"roundtrip-{tag}", commit=False)
        _purchase(c, uid, f"pi_credadj_roundtrip_{tag}", 60, commit=False)
        _adjust(c, uid, -20, f"evt_credadj_roundtrip_{tag}", f"pi_credadj_roundtrip_{tag}")
        assert _balance(c, uid) == 40
        # 024 state: refund index is the non-unique one.
        idx = {
            r[0]: r[1]
            for r in c.execute(
                "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='credit_adjustments'"
            ).fetchall()
        }
        assert "credit_adjustments_one_refund_per_charge_idx" not in idx
        assert "credit_adjustments_refund_charge_idx" in idx


def test_down_migration_would_return_a_refunded_users_credits_so_it_is_never_committed(
    bystander_refund,
):
    """The non-vacuity gate for the test above, in money. Inside the transaction the
    bystander's balance really does go from 0 to 60 when down/023 drops the ledger -- the
    refunded user gets their credits back -- so the only reason the refund and the balance
    are intact afterwards is the rollback. (If this test stopped showing the 60, the
    survival check below would be passing for nothing.)"""
    down, _up, _up024 = _read_migrations()
    uid = bystander_refund
    with _rolled_back_session() as c:
        assert _balance(c, uid) == 0, "precondition: the refund zeroes the bystander's balance"
        c.execute(down)
        assert _balance(c, uid) == 60, "down/023 should hand the refunded credits back in-txn"
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        assert (
            c.execute("SELECT to_regclass('public.credit_adjustments')").fetchone()[0] is not None
        )
        n, total = c.execute(
            "SELECT count(*), sum(credits_delta) FROM public.credit_adjustments WHERE user_id=%s",
            (uid,),
        ).fetchone()
        assert (n, total) == (1, -60)
        assert _balance(c, uid) == 0
