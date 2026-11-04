#!/usr/bin/env python3
"""
Audit M5 CI gate: reconcile credit pack prices with Stripe.

`credit_packs.price_cad_cents` is display-only; the checkout route charges the
Stripe price_id from STRIPE_PRICE_CREDITS_{20,60,180}. If the two drift, the
pricing page advertises one amount and Stripe bills another. This script
compares, per pack, the expected CAD cents against Stripe `price.unit_amount`
(and currency, which must be cad).

Expected-price source (--source):
  migration (default)  parse the seed INSERT in migration 020. This is the
                       source of truth for a fresh deploy and needs no DB.
  db                   SELECT pack_code, price_cad_cents FROM credit_packs
                       using DATABASE_URL (staging/prod drift check).
  auto                 db if DATABASE_URL is set and reachable, else migration.

Env: STRIPE_SECRET_KEY, STRIPE_PRICE_CREDITS_20, STRIPE_PRICE_CREDITS_60,
     STRIPE_PRICE_CREDITS_180 (and DATABASE_URL for db/auto).

Usage: python scripts/check_credit_pack_prices.py [--source migration|db|auto]
Exit 0 all match; 1 any mismatch; 2 configuration/lookup error.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

PACKS = ("credits_20", "credits_60", "credits_180")
PRICE_ENV = {
    "credits_20": "STRIPE_PRICE_CREDITS_20",
    "credits_60": "STRIPE_PRICE_CREDITS_60",
    "credits_180": "STRIPE_PRICE_CREDITS_180",
}
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "apps/worker/migrations/020_v3_credit_packs_table.sql"
)
EXPECTED_CURRENCY = "cad"

_SEED_ROW_RE = re.compile(
    r"\(\s*'(credits_\d+)'\s*,\s*\d+\s*,\s*(\d+)\s*,\s*'[^']*'\s*\)"
)


class ConfigError(Exception):
    pass


def prices_from_migration(path: Path = MIGRATION) -> dict[str, int]:
    sql = path.read_text()
    idx = sql.find("INSERT INTO public.credit_packs")
    if idx < 0:
        raise ConfigError(f"no credit_packs seed INSERT found in {path}")
    end = sql.find(";", idx)
    return {m.group(1): int(m.group(2)) for m in _SEED_ROW_RE.finditer(sql[idx:end])}


def prices_from_db(database_url: str) -> dict[str, int]:
    import psycopg

    with psycopg.connect(database_url, connect_timeout=10) as conn:
        rows = conn.execute(
            "SELECT pack_code, price_cad_cents FROM public.credit_packs"
        ).fetchall()
    return {code: int(cents) for code, cents in rows}


def load_expected(source: str) -> tuple[dict[str, int], str]:
    if source == "migration":
        return prices_from_migration(), "migration 020 seed"
    url = os.environ.get("DATABASE_URL")
    if source == "db":
        if not url:
            raise ConfigError("--source db requires DATABASE_URL")
        return prices_from_db(url), "credit_packs table"
    # auto
    if url:
        try:
            return prices_from_db(url), "credit_packs table"
        except Exception as exc:  # noqa: BLE001 - fall back on any DB failure
            print(f"DB unreachable ({exc}); falling back to migration seed")
    return prices_from_migration(), "migration 020 seed"


def fetch_stripe(price_ids: dict[str, str]) -> dict[str, tuple[int | None, str | None]]:
    import stripe

    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    out = {}
    for pack, pid in price_ids.items():
        price = stripe.Price.retrieve(pid)
        cur = price["currency"]
        out[pack] = (price["unit_amount"], cur.lower() if cur else None)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Reconcile credit_packs with Stripe prices"
    )
    ap.add_argument(
        "--source", choices=("migration", "db", "auto"), default="migration"
    )
    args = ap.parse_args(argv)

    try:
        missing = [
            v
            for v in ("STRIPE_SECRET_KEY", *PRICE_ENV.values())
            if not os.environ.get(v)
        ]
        if missing:
            raise ConfigError("missing env: " + ", ".join(missing))
        expected, label = load_expected(args.source)
        absent = [p for p in PACKS if p not in expected]
        if absent:
            raise ConfigError(f"packs missing from {label}: {', '.join(absent)}")
        price_ids = {p: os.environ[PRICE_ENV[p]] for p in PACKS}
        actual = fetch_stripe(price_ids)
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - Stripe/network errors
        print(f"LOOKUP ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    print(f"Expected source: {label}")
    header = f"{'pack':<12} {'price_id':<32} {'expected':>9} {'stripe':>9} cur  status"
    print(header)
    print("-" * len(header))
    bad = 0
    for p in PACKS:
        amount, cur = actual[p]
        ok = amount == expected[p] and cur == EXPECTED_CURRENCY
        bad += not ok
        print(
            f"{p:<12} {price_ids[p]:<32} {expected[p]:>9} {str(amount):>9} "
            f"{cur or '?':<4} {'OK' if ok else 'MISMATCH'}"
        )
    if bad:
        print(
            f"\nFAIL: {bad} pack(s) differ between credit_packs and Stripe. "
            "Fix the DB value or the Stripe price_id so customers are billed "
            "what /pricing shows.",
            file=sys.stderr,
        )
        return 1
    print("\nOK: all credit pack prices match Stripe.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
