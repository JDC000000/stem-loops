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

Usage: python scripts/check_credit_pack_prices.py [--source migration|db|auto] [--strict]
Exit 0 all match (or: secrets absent and not --strict → SKIPPED);
     1 any mismatch;
     2 configuration/lookup error (requires --strict for missing env).

Default is `--source auto` so CI catches live-DB drift (the actual M5
scenario) when DATABASE_URL is wired, falling back to the migration seed
otherwise. Default is NOT `--strict` so an unconfigured CI job gracefully
skips rather than red-flagging every downstream PR.
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
    # Default `--source auto` covers the actual M5 scenario (live DB edits
    # drifting from Stripe) when DATABASE_URL is present, and falls back to the
    # migration seed when it isn't (CI default). Review of PR #56 round-1
    # flagged that `--source migration` alone misses the live-edit drift case.
    ap.add_argument("--source", choices=("migration", "db", "auto"), default="auto")
    # Skip gracefully when the Stripe secret isn't configured. This is the
    # CI-startup state before Jon adds the repo secrets — without this flag,
    # the job exits 2 (config error) and shows RED on every downstream PR,
    # which `safe_merge.sh` then refuses per M-1. Opt-in gate: set
    # STRICT_RECON=1 (or `--strict`) to re-enable fail-on-missing-secrets
    # once the secrets land.
    ap.add_argument(
        "--strict",
        action="store_true",
        default=os.environ.get("STRICT_RECON") == "1",
        help="Fail (exit 2) when STRIPE_SECRET_KEY is absent instead of "
        "skipping with a notice. Set once repo secrets are configured so "
        "silent-skip can no longer hide a genuine misconfiguration.",
    )
    args = ap.parse_args(argv)

    missing_secrets = [
        v for v in ("STRIPE_SECRET_KEY", *PRICE_ENV.values()) if not os.environ.get(v)
    ]
    if missing_secrets and not args.strict:
        # The whole point of the check is a Stripe lookup. If the key isn't
        # here we can't do the lookup, but we also don't want to red-flag
        # every downstream PR. Say so clearly and exit 0.
        print(
            "SKIPPED: " + ", ".join(missing_secrets) + " not set — "
            "add the repo secrets (see PR #56 body) and re-run. "
            "Pass --strict or STRICT_RECON=1 to enforce.",
            file=sys.stderr,
        )
        return 0

    try:
        if missing_secrets:
            raise ConfigError("missing env: " + ", ".join(missing_secrets))
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
