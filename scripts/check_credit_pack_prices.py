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
  auto                 db if DATABASE_URL is set; migration only if it is NOT
                       set. A DATABASE_URL that is set but unusable for ANY
                       reason (unreachable, auth, permission denied, driver
                       missing, credit_packs absent) is exit 2, never a silent
                       fall back to the seed: "could not read the DB" must not
                       be reported as "checked".

Env: STRIPE_SECRET_KEY, STRIPE_PRICE_CREDITS_20, STRIPE_PRICE_CREDITS_60,
     STRIPE_PRICE_CREDITS_180 (and DATABASE_URL for db/auto).

Usage: python scripts/check_credit_pack_prices.py [--source migration|db|auto]

Exit codes (each means exactly one thing):
  0  CHECKED, no drift: every pack matched Stripe. The ONLY success.
  1  CHECKED, drift found: a pack's amount or currency differs from Stripe.
  2  broken: seed missing/unparseable, or the Stripe/DB lookup itself failed.
  3  NOT CHECKED: STRIPE_SECRET_KEY or a STRIPE_PRICE_CREDITS_* var is unset
     or empty, so no comparison was attempted. This is a configuration state,
     never success. The script has no flag that turns it into 0; if a caller
     chooses to tolerate it, that policy lives in the caller (see the
     RECON_ALLOW_UNCONFIGURED switch in .github/workflows/ci.yml).

Default is `--source auto` so CI catches live-DB drift (the actual M5
scenario) when DATABASE_URL is wired, and uses the migration seed only when no
DATABASE_URL was supplied at all.
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

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_BROKEN = 2
EXIT_NOT_CHECKED = 3

_SEED_ROW_RE = re.compile(
    r"\(\s*'(credits_\d+)'\s*,\s*\d+\s*,\s*(\d+)\s*,\s*'[^']*'\s*\)"
)


class ConfigError(Exception):
    pass


def prices_from_migration(path: Path = MIGRATION) -> dict[str, int]:
    try:
        sql = path.read_text()
    except OSError as exc:
        raise ConfigError(f"cannot read migration seed {path}: {exc}") from exc
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
        return prices_from_migration(MIGRATION), "migration 020 seed"
    url = os.environ.get("DATABASE_URL")
    if source == "db":
        if not url:
            raise ConfigError("--source db requires DATABASE_URL")
        return prices_from_db(url), "credit_packs table"
    # auto: the seed is the intended source ONLY when no DATABASE_URL was given.
    # If one was given, any failure reading it propagates to main() -> exit 2.
    # Deliberately no try/except here: a forgiving branch under a broad except
    # turns "could not reach the DB" into a green check.
    if url:
        return prices_from_db(url), "credit_packs table"
    return prices_from_migration(MIGRATION), "migration 020 seed"


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
    # drifting from Stripe) when DATABASE_URL is present, and uses the
    # migration seed only when it is absent (CI default). Review of PR #56 round-1
    # flagged that `--source migration` alone misses the live-edit drift case.
    ap.add_argument("--source", choices=("migration", "db", "auto"), default="auto")
    args = ap.parse_args(argv)

    # Unset and empty are the same thing: GitHub Actions expands a secret that
    # does not exist to "". No comparison is attempted in this state, so it must
    # never share an exit code with "compared and found no drift".
    missing_secrets = [
        v for v in ("STRIPE_SECRET_KEY", *PRICE_ENV.values()) if not os.environ.get(v)
    ]
    if missing_secrets:
        print(
            "NOT CHECKED: " + ", ".join(missing_secrets) + " not set, so NO "
            "credit pack price was compared with Stripe. This is not a pass. "
            "Add the repo secrets (see PR #56 body) and re-run.",
            file=sys.stderr,
        )
        return EXIT_NOT_CHECKED

    try:
        expected, label = load_expected(args.source)
        absent = [p for p in PACKS if p not in expected]
        if absent:
            raise ConfigError(f"packs missing from {label}: {', '.join(absent)}")
        price_ids = {p: os.environ[PRICE_ENV[p]] for p in PACKS}
        actual = fetch_stripe(price_ids)
    except ConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return EXIT_BROKEN
    except Exception as exc:  # noqa: BLE001 - fail CLOSED: Stripe/DB/driver errors are 2
        print(f"LOOKUP ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_BROKEN

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
        return EXIT_DRIFT
    print("\nOK: all credit pack prices match Stripe.")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
