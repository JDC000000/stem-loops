"""Migration 024 / pro-rata partial-refund clawback (M4 follow-up) DB tests.

Simulates the rows the webhook writes for a sequence of partial refunds and
checks v_credit_balance after each step, the per-event dedup UNIQUE, the
stacking of several refund rows per charge, and the "sum of previous clawbacks"
lookup the webhook runs. Requires a local Postgres migrated through 024; skipped
without DATABASE_URL, refused on non-local hosts.
"""

from __future__ import annotations

import math
import os
import uuid
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="tests INSERT into auth.users; local throwaway DB only")

EMAIL = "test-prorata-%@example.com"
CHARGE = "pi_prorata_test"


def _clawed_sql() -> str:
    return (
        "SELECT COALESCE(SUM(-credits_delta), 0) FROM public.credit_adjustments "
        "WHERE provider='stripe' AND provider_charge_id=%s AND reason='refund'"
    )


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL,))
    c.commit()


def _user_with_purchase(conn: Any, tag: str, cents: int = 3000) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-prorata-{tag}@example.com"),
    )
    conn.execute(
        "INSERT INTO public.credit_purchases (user_id, provider, provider_charge_id, "
        "pack_code, credits_granted, amount_cad_cents) VALUES (%s,'stripe',%s,'credits_60',60,%s)",
        (uid, CHARGE, cents),
    )
    conn.commit()
    return uid


def _claw(conn: Any, uid: uuid.UUID, credits: int, event: str) -> None:
    conn.execute(
        "INSERT INTO public.credit_adjustments (user_id, credits_delta, reason, provider, "
        "provider_event_id, provider_charge_id) VALUES (%s,%s,'refund','stripe',%s,%s)",
        (uid, -credits, event, CHARGE),
    )
    conn.commit()


def _balance(conn: Any, uid: uuid.UUID) -> int:
    row = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s", (uid,)
    ).fetchone()
    assert row is not None
    return int(row[0])


def _already_clawed(conn: Any) -> int:
    row = conn.execute(_clawed_sql(), (CHARGE,)).fetchone()
    assert row is not None
    return int(row[0])


def test_sequence_of_partials_then_full_balance_steps(conn):
    uid = _user_with_purchase(conn, "seq")
    assert _balance(conn, uid) == 60
    _claw(conn, uid, 20, "evt_prorata_seq1")  # $10 of $30
    assert _balance(conn, uid) == 40
    _claw(conn, uid, 20, "evt_prorata_seq2")  # cumulative $20
    assert _balance(conn, uid) == 20
    _claw(conn, uid, 20, "evt_prorata_seq3")  # full refund closes remainder
    assert _balance(conn, uid) == 0
    assert _already_clawed(conn) == 60


def test_sum_lookup_matches_floor_math_with_uneven_amounts(conn):
    uid = _user_with_purchase(conn, "floor", cents=2999)
    done = 0
    for i, refunded in enumerate((1000, 2000, 2900), start=1):
        target = math.floor(refunded * 60 / 2999)
        _claw(conn, uid, target - done, f"evt_prorata_floor{i}")
        done = target
        assert _already_clawed(conn) == target
        assert _balance(conn, uid) == 60 - target
    assert done == 58
    _claw(conn, uid, 60 - done, "evt_prorata_floor4")  # full-refund residual
    assert _balance(conn, uid) == 0


def test_duplicate_event_id_still_blocked(conn):
    uid = _user_with_purchase(conn, "dupe")
    _claw(conn, uid, 20, "evt_prorata_dupe")
    with pytest.raises(psycopg.errors.UniqueViolation):
        _claw(conn, uid, 20, "evt_prorata_dupe")
    conn.rollback()
    assert _already_clawed(conn) == 20
    assert _balance(conn, uid) == 40


def test_on_conflict_do_nothing_makes_retry_a_noop(conn):
    uid = _user_with_purchase(conn, "retry")
    sql = (
        "INSERT INTO public.credit_adjustments (user_id, credits_delta, reason, provider, "
        "provider_event_id, provider_charge_id) VALUES (%s,-30,'refund','stripe',%s,%s) "
        "ON CONFLICT DO NOTHING"
    )
    first = conn.execute(sql, (uid, "evt_prorata_retry", CHARGE)).rowcount
    second = conn.execute(sql, (uid, "evt_prorata_retry", CHARGE)).rowcount
    conn.commit()
    assert (first, second) == (1, 0)
    assert _balance(conn, uid) == 30


def test_refund_charge_index_is_non_unique_and_partial(conn):
    rows = conn.execute(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='public' "
        "AND tablename='credit_adjustments' AND indexname IN "
        "('credit_adjustments_refund_charge_idx','credit_adjustments_one_refund_per_charge_idx')"
    ).fetchall()
    defs = [r[0] for r in rows]
    assert len(defs) == 1, defs
    assert "UNIQUE" not in defs[0].upper()
    assert "refund" in defs[0]
