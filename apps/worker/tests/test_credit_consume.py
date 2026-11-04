"""Credit consumption (credit-ledger review 2026-11-03: B1 + M3).

`apps/web/src/lib/billing/credits.ts::consumeCreditInTx` runs, inside the same
tx as the `jobs` INSERT:

    SELECT pg_advisory_xact_lock(hashtext('credit_consume' || ':' || $user));
    INSERT INTO credit_consumption (user_id, job_id)
    SELECT $user, $job
     WHERE (SELECT credits_remaining FROM v_credit_balance WHERE user_id = $user) > 0
    RETURNING id;

rowCount == 0 -> EntitlementError('CREDIT_BALANCE_INSUFFICIENT').

These tests execute that exact SQL against real Postgres (same approach as
test_trial_grants.py, which mirrors lib/trial.ts). The Pro/Studio skip lives in
the route; it is covered by a source guard here plus the route-level node test
(apps/web/test/jobs-trial-channel.test.mjs).

Credit packs are constrained to 20/60/180 by the credit_purchases CHECK, so
"balance N" fixtures buy a 20-pack and pre-consume the difference.

Skipped without DATABASE_URL; refused on non-local hosts (INSERTs into
auth.users) — same guard as test_013_commercial_schema.py.
"""

from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(
        reason="credit-consume tests INSERT into auth.users; local throwaway DB only"
    )

EMAIL_PREFIX = "test-credit-consume-"

LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext(%s || ':' || %s::text))"
CONSUME_SQL = """
INSERT INTO public.credit_consumption (user_id, job_id)
SELECT %s::uuid, %s::uuid
 WHERE (SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s::uuid) > 0
RETURNING id
"""


class CreditBalanceInsufficient(Exception):
    """Python mirror of EntitlementError('CREDIT_BALANCE_INSUFFICIENT')."""


def consume_credit_in_tx(conn: Any, user_id: uuid.UUID, job_id: uuid.UUID) -> None:
    """Mirror of credits.ts::consumeCreditInTx. Caller owns the transaction."""
    conn.execute(LOCK_SQL, ("credit_consume", str(user_id)))
    cur = conn.execute(CONSUME_SQL, (user_id, job_id, user_id))
    if cur.rowcount == 0:
        raise CreditBalanceInsufficient()


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    like = f"(SELECT id FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%')"
    c.execute(f"DELETE FROM public.credit_consumption WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.credit_purchases WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.jobs WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.entitlements WHERE user_id IN {like}")
    c.execute(f"DELETE FROM public.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.execute(f"DELETE FROM auth.users WHERE email LIKE '{EMAIL_PREFIX}%'")
    c.commit()


def _insert_auth_user(conn: Any, suffix: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (user_id, f"{EMAIL_PREFIX}{suffix}@example.com"),
    )
    conn.commit()
    return user_id


def _insert_upload_job(conn: Any, user_id: uuid.UUID) -> uuid.UUID:
    job_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO public.jobs "
        "(id, input_kind, status, user_id, loop_length_bars, client_ip_hash, upload_r2_key) "
        "VALUES (%s, 'upload', 'queued', %s, 4, 'test-credit-consume-ip', %s)",
        (job_id, user_id, f"test-credit-consume-{job_id}.wav"),
    )
    conn.commit()
    return job_id


def _buy_20_pack(conn: Any, user_id: uuid.UUID) -> None:
    conn.execute(
        "INSERT INTO public.credit_purchases "
        "(user_id, provider, provider_charge_id, pack_code, credits_granted, amount_cad_cents) "
        "VALUES (%s, 'stripe', %s, 'credits_20', 20, 500)",
        (user_id, f"ch_test_cc_{uuid.uuid4().hex}"),
    )
    conn.commit()


def _balance(conn: Any, user_id: uuid.UUID) -> int:
    row = conn.execute(
        "SELECT credits_remaining FROM public.v_credit_balance WHERE user_id = %s",
        (user_id,),
    ).fetchone()
    return int(row[0])


def _consumption_count(conn: Any, user_id: uuid.UUID) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = %s", (user_id,)
    ).fetchone()[0]


def _drain_to(conn: Any, user_id: uuid.UUID, remaining: int) -> None:
    """Pre-consume credits (one upload job each) until `remaining` are left."""
    while _balance(conn, user_id) > remaining:
        job_id = _insert_upload_job(conn, user_id)
        conn.execute(
            "INSERT INTO public.credit_consumption (user_id, job_id) VALUES (%s, %s)",
            (user_id, job_id),
        )
        conn.commit()


def test_consume_decrements_balance(conn):
    user_id = _insert_auth_user(conn, "decrement")
    _buy_20_pack(conn, user_id)
    assert _balance(conn, user_id) == 20

    job_id = _insert_upload_job(conn, user_id)
    consume_credit_in_tx(conn, user_id, job_id)
    conn.commit()

    assert _balance(conn, user_id) == 19
    assert _consumption_count(conn, user_id) == 1


def test_consume_rejects_at_zero(conn):
    user_id = _insert_auth_user(conn, "zero")  # never bought anything
    assert _balance(conn, user_id) == 0

    job_id = _insert_upload_job(conn, user_id)
    with pytest.raises(CreditBalanceInsufficient):
        consume_credit_in_tx(conn, user_id, job_id)
    conn.rollback()

    assert _consumption_count(conn, user_id) == 0
    assert _balance(conn, user_id) == 0


def test_rolled_back_tx_does_not_burn_credit(conn):
    """If the caller aborts after consuming, the consumption row rolls back."""
    user_id = _insert_auth_user(conn, "rollback")
    _buy_20_pack(conn, user_id)
    job_id = _insert_upload_job(conn, user_id)

    consume_credit_in_tx(conn, user_id, job_id)
    conn.rollback()

    assert _balance(conn, user_id) == 20


def test_concurrent_consume_blocks_double_spend(conn):
    """10 concurrent uploads, 1 credit left: exactly one may succeed (M3)."""
    user_id = _insert_auth_user(conn, "concurrent")
    _buy_20_pack(conn, user_id)
    _drain_to(conn, user_id, remaining=1)
    assert _balance(conn, user_id) == 1

    n = 10
    job_ids = [_insert_upload_job(conn, user_id) for _ in range(n)]
    barrier = threading.Barrier(n)
    results: list[str] = [""] * n

    def worker(i: int) -> None:
        # Own connection == own tx == what separate serverless instances do.
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            barrier.wait(timeout=30)
            try:
                consume_credit_in_tx(c, user_id, job_ids[i])
                c.commit()
                results[i] = "ok"
            except CreditBalanceInsufficient:
                c.rollback()
                results[i] = "insufficient"
            except Exception as exc:  # pragma: no cover - surfaced by assert below
                c.rollback()
                results[i] = f"error:{exc!r}"

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert results.count("ok") == 1, results
    assert results.count("insufficient") == n - 1, results
    assert _balance(conn, user_id) == 0  # never negative (M3: was -N pre-fix)


def test_consume_skipped_for_pro_plan(conn):
    """Pro/Studio uploads never write credit_consumption.

    The skip lives in the /api/jobs route (`chargeCredit` is false for
    pro/studio), so assert (a) a Pro user's upload job lands with no
    consumption row and an untouched balance, and (b) the route source still
    carries the guard. Route behaviour itself is covered in
    apps/web/test/jobs-trial-channel.test.mjs.
    """
    user_id = _insert_auth_user(conn, "pro")
    _buy_20_pack(conn, user_id)
    conn.execute("UPDATE public.entitlements SET plan_code = 'pro' WHERE user_id = %s", (user_id,))
    conn.commit()
    plan = conn.execute(
        "SELECT plan_code FROM public.entitlements WHERE user_id = %s", (user_id,)
    ).fetchone()[0]
    assert plan == "pro"

    _insert_upload_job(conn, user_id)  # what the route does for Pro: insert, no consume

    assert _consumption_count(conn, user_id) == 0
    assert _balance(conn, user_id) == 20

    route = (
        Path(__file__).resolve().parents[3]
        / "apps"
        / "web"
        / "src"
        / "app"
        / "api"
        / "jobs"
        / "route.ts"
    ).read_text()
    assert re.search(
        r"chargeCredit\s*=\s*entSnap\.plan_code\s*!==\s*'pro'\s*&&\s*entSnap\.plan_code\s*!==\s*'studio'",
        route,
    ), "route.ts must skip credit charge for pro/studio"
