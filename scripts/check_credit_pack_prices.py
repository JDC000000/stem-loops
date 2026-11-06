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
  auto                 THREE states, not two:
                         DATABASE_URL set         -> read the live table. Set
                           but unusable for ANY reason (unreachable, auth,
                           permission denied, driver missing, credit_packs
                           absent) is exit 2, never a silent fall back to the
                           seed: "could not read the DB" must not be reported
                           as "checked".
                         DATABASE_URL SET BUT EMPTY -> exit 2. A secret was
                           wired and did not expand. Substituting the seed here
                           would let a renamed or rotated secret degrade this
                           job to seed-vs-Stripe silently and permanently.
                         DATABASE_URL unset       -> the seed, honestly.

Env: STRIPE_SECRET_KEY, STRIPE_PRICE_CREDITS_20, STRIPE_PRICE_CREDITS_60,
     STRIPE_PRICE_CREDITS_180 (and DATABASE_URL for db/auto).

Usage: python scripts/check_credit_pack_prices.py [--source migration|db|auto]

Exit codes (each means exactly one thing):
  0  CHECKED, no drift: every pack matched Stripe. The ONLY success.
  1  CHECKED, drift found: a pack's amount or currency differs from Stripe.
  2  broken: seed missing/unparseable, the Stripe/DB lookup itself failed, or
     DATABASE_URL is set but empty (a wired secret that did not expand).
  3  NOT CHECKED: STRIPE_SECRET_KEY or a STRIPE_PRICE_CREDITS_* var is unset
     or empty, so no comparison was attempted. This is a configuration state,
     never success. The script has no flag that turns it into 0; if a caller
     chooses to tolerate it, that policy lives in the caller (see the
     RECON_ALLOW_UNCONFIGURED switch in .github/workflows/ci.yml).

Default is `--source auto` so CI catches live-DB drift (the actual M5
scenario) when DATABASE_URL is wired, and uses the migration seed only when
DATABASE_URL is entirely UNSET.

"Unset" and "empty" are different facts here, and review round 2 found that
distinction load-bearing: `ci.yml` used to map DATABASE_URL to a secret
unconditionally, GitHub expands a missing secret to "", and so the empty state
was the ONLY way CI ever reached the seed. The mapping is now absent from
ci.yml until the secret exists; see the comment block there.
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
    # auto. Three states, not two -- review round 2 found the middle one was
    # both unpinned and the ONLY state CI ever actually reaches.
    #
    #   DATABASE_URL set            -> read the live table. Any failure
    #                                  propagates to main() -> exit 2. No
    #                                  try/except here on purpose: a forgiving
    #                                  branch under a broad except turns
    #                                  "could not reach the DB" into a green.
    #   DATABASE_URL SET BUT EMPTY  -> refuse. Someone wired a secret and the
    #                                  secret did not arrive. Substituting the
    #                                  seed here would mean that a renamed,
    #                                  rotated, environment-scoped or deleted
    #                                  DATABASE_URL_CREDIT_PACKS_RO silently
    #                                  degrades this job to seed-vs-Stripe --
    #                                  green, forever, with one stdout line as
    #                                  the only trace. The M5 scenario this job
    #                                  exists for would then go unchecked.
    #   DATABASE_URL unset          -> the seed is the intended source. This is
    #                                  a real comparison, not a consolation:
    #                                  seed vs Stripe is what `--source
    #                                  migration` does and what the Makefile
    #                                  target runs.
    #
    # Nine lines below, this same file already treats an empty STRIPE_SECRET_KEY
    # as "not configured". Same GitHub mechanism; it would be incoherent to
    # reach the opposite conclusion here. The sibling drift gate draws the same
    # line for the same reason.
    if url is not None and not url.strip():
        raise ConfigError(
            "DATABASE_URL is set but empty: DATABASE_URL_CREDIT_PACKS_RO did "
            "not expand. Refusing to substitute the migration seed -- that "
            "would compare the seed while reporting on the live table. If this "
            "job should use the seed, stop setting DATABASE_URL at all."
        )
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
    # migration seed only when DATABASE_URL is entirely UNSET -- set-but-empty
    # is exit 2, see load_expected(). Round-1 review flagged that
    # `--source migration` alone misses the live-edit drift case.
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
