#!/usr/bin/env python3
"""
Code-to-schema drift gate — L34, seam class 6 (Deployment).

THE BUG THIS EXISTS TO PREVENT
------------------------------
On 2026-11-06 production was discovered to be on migration 008 while the code
on `v3/main` required 031 — twenty-three migrations of drift that had gone
unnoticed for days. Every money-path fix merged that week was guarding tables
production did not have. Nothing appeared broken, because none of that code was
reachable in production; the first `POST /api/jobs` after a deploy would have
returned 500.

Code and schema are versioned separately and, until this script, NOTHING
compared them. That is seam class 6, whose failure mode is silence: a green CI
run, a clean deploy, and a database that cannot serve the code it was deployed
alongside.

WHAT IT DOES
------------
Compares the migrations the repo contains against the rows in the target
database's `public._migrations` ledger, and fails if the database is behind.

Discovery deliberately mirrors `apps/worker/src/worker/migrate.py` exactly:
`sorted(glob("*.sql"))` over the TOP LEVEL of apps/worker/migrations only.
`down/` is not globbed by the runner, so it is not globbed here. If the runner's
discovery ever changes, this check must change with it or it will compare the
wrong sets.

WHY IT DOES NOT EXIT 0 WHEN IT CANNOT CHECK
-------------------------------------------
`claude/seam-inventory.md` lists "secret present vs. job meaningful" as an
unguarded seam, citing a sibling script that exits 0 when its credentials are
absent — passing while checking nothing. A drift gate that silently skips is
worse than no gate, because it produces a green tick that a reader trusts.

So: no DATABASE_URL, an unreachable database, or a missing `_migrations` table
all exit 2. Only `--allow-unreachable` downgrades that to 0, and it says so
loudly. A missing `_migrations` table is a hard failure rather than "assume
zero": staging has no such table, and its true migration level is therefore
unknowable from inside — see the cutover plan.

EXIT CODES
----------
  0  no drift: every repo migration is recorded as applied
  1  DRIFT: the database is missing migrations the code requires
  2  cannot determine (no DATABASE_URL, unreachable, no ledger table)

USAGE
-----
  DATABASE_URL=postgresql://... python scripts/check_migration_drift.py
  python scripts/check_migration_drift.py --expect 30
  python scripts/check_migration_drift.py --allow-unreachable   # CI without a DB

STATUS. The Supabase-prelude matrix job runs this against the database it has
just migrated, which exercises the gate end to end but CANNOT report drift —
it is checking a ledger it populated itself from the same checkout.

The thing this script exists for is still NOT WIRED: nothing points it at a
real deployed database. As of 2026-11-06 production's `public._migrations`
holds 8 rows (max `008_fetch_gates.sql`) against 30 in the repo, and no job in
this repo turns red over it. Closing that needs a read-only ledger credential
as a secret — the house pattern is `DATABASE_URL_CREDIT_PACKS_RO`, used by
`check_credit_pack_prices` — or a deploy-time hook. Until one of those exists,
do not describe this gate as preventing R-1.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# scripts/check_migration_drift.py -> apps/worker/migrations
DEFAULT_MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[1] / "apps" / "worker" / "migrations"
)

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_UNKNOWN = 2


class Unreachable(Exception):
    """The database could not be CONNECTED to. The only forgivable failure.

    Keyed on the PHASE, not on an exception class. Two earlier versions got
    this wrong in the same direction:

      v1  `except Exception` — a reachable database with an unreadable ledger
          was called "unreachable" and --allow-unreachable returned 0.
      v2  `except psycopg.OperationalError` — narrower in name only. That class
          has ~92 subclasses in psycopg 3, including QUERY-time ones: a
          `lock_timeout` or `statement_timeout` cancelling the ledger SELECT
          still landed here, and the flag still returned 0.

    Both let through the exact case the flag must never forgive: the database
    answered and we still do not know what is applied. Only a failure raised by
    `psycopg.connect` can be an Unreachable; anything raised afterwards is a
    database that answered.
    """


class LedgerMissing(Exception):
    """`public._migrations` is absent, so the applied set is unknowable.

    Deliberately NOT one of the errors --allow-unreachable forgives. Staging
    has exactly this shape: tables present, no ledger. "Which tables exist" and
    "which migrations ran" are different questions, and no flag should let the
    second be answered by guessing.
    """


@dataclass
class Drift:
    """Result of comparing repo migrations against the applied ledger."""

    missing: list[str] = field(default_factory=list)  # in repo, not applied
    extra: list[str] = field(default_factory=list)  # applied, not in repo

    @property
    def has_drift(self) -> bool:
        # Only `missing` is a deploy blocker. `extra` means the database has a
        # migration this checkout does not contain — worth reporting (an older
        # checkout, or a file deleted without a ledger cleanup) but it does not
        # stop code from running.
        return bool(self.missing)


def discover_repo_migrations(migrations_dir: Path) -> list[str]:
    """Basenames of forward migrations, in the runner's own order.

    Calls the RUNNER's own discovery rather than reimplementing it. The two
    must agree about what "the migrations" are, and the strongest way to
    guarantee that is to have one definition. Review round 3: three mutations
    of the runner (append down/, skip a prefix, rewrite to os.walk with the old
    expression left in a docstring) all slipped past a test that compared this
    function against a copy of the glob written in the test.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "worker" / "src"))
    from worker.migrate import discover_migration_paths

    return [os.path.basename(p) for p in discover_migration_paths(str(migrations_dir))]


def diff_migrations(repo: list[str], applied: set[str]) -> Drift:
    """Pure comparison, so it is testable without a database."""
    return Drift(
        missing=[m for m in repo if m not in applied],
        extra=sorted(applied - set(repo)),
    )


def fetch_applied(database_url: str) -> set[str]:
    """Read the ledger.

    Raises Unreachable only if the CONNECT fails. Every later failure — no
    ledger, no SELECT privilege, a cancelled query — propagates as itself and
    is never forgiven.
    """
    import psycopg  # imported late so --help works without the dependency

    try:
        conn = psycopg.connect(database_url, connect_timeout=15)
    except Exception as exc:
        raise Unreachable(str(exc)) from exc

    with conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public._migrations')")
        row = cur.fetchone()
        if row is None or row[0] is None:
            raise LedgerMissing(
                "public._migrations does not exist. The applied set is "
                "unknowable from inside this database — tables present do "
                "not tell you which migrations ran. Refusing to guess."
            )
        cur.execute("SELECT filename FROM public._migrations")
        return {r[0] for r in cur.fetchall()}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument(
        "--migrations-dir",
        type=Path,
        default=DEFAULT_MIGRATIONS_DIR,
        help="override the migrations directory (default: apps/worker/migrations)",
    )
    ap.add_argument(
        "--expect",
        type=int,
        default=None,
        help="also assert the ledger holds exactly N rows",
    )
    ap.add_argument(
        "--allow-unreachable",
        action="store_true",
        help=(
            "downgrade an UNREACHABLE database (connection failure) from exit 2 "
            "to exit 0, printing a warning. Does NOT forgive a database that "
            "answered: a missing ledger, an unreadable ledger, or a bad "
            "conninfo all still fail."
        ),
    )
    args = ap.parse_args(argv)

    repo = discover_repo_migrations(args.migrations_dir)
    if not repo:
        print(f"FAIL: no migrations found in {args.migrations_dir}", file=sys.stderr)
        return EXIT_UNKNOWN
    print(f"repo: {len(repo)} migrations, {repo[0]} .. {repo[-1]}")

    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        msg = "DATABASE_URL is not set, so drift CANNOT be checked."
        if args.allow_unreachable:
            print(f"WARNING: {msg} --allow-unreachable given; reporting success "
                  f"WITHOUT having checked anything.", file=sys.stderr)
            return EXIT_OK
        print(f"FAIL: {msg} Pass --allow-unreachable only if you accept an "
              f"unchecked deploy.", file=sys.stderr)
        return EXIT_UNKNOWN

    try:
        applied = fetch_applied(database_url)
    except LedgerMissing as exc:
        # NOT forgiven by --allow-unreachable. The database answered; it simply
        # cannot say what has been applied. Blessing that would be guessing.
        print(f"FAIL: {exc}", file=sys.stderr)
        return EXIT_UNKNOWN
    except Unreachable as exc:
        msg = f"could not reach the database: {exc}"
        if args.allow_unreachable:
            print(f"WARNING: {msg} --allow-unreachable given; reporting success "
                  f"WITHOUT having checked anything.", file=sys.stderr)
            return EXIT_OK
        print(f"FAIL: {msg}", file=sys.stderr)
        return EXIT_UNKNOWN
    except Exception as exc:  # noqa: BLE001
        # Reachable, but the ledger could not be read (no SELECT, no USAGE on
        # public, malformed conninfo...). NOT forgivable: the database answered
        # and we still do not know what is applied.
        print(
            f"FAIL: reached the database but could not read the ledger: {exc}",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN

    print(f"database: {len(applied)} migrations recorded")

    drift = diff_migrations(repo, applied)
    for m in drift.extra:
        print(f"  note: applied but not in this checkout: {m}")

    if drift.has_drift:
        print(
            f"\nDRIFT: the database is missing {len(drift.missing)} migration(s) "
            f"this code requires:",
            file=sys.stderr,
        )
        for m in drift.missing:
            print(f"  - {m}", file=sys.stderr)
        print(
            "\nDeploying this code against this database will fail at runtime, "
            "not at deploy time. Apply the migrations first.",
            file=sys.stderr,
        )
        return EXIT_DRIFT

    if args.expect is not None and len(applied) != args.expect:
        # Exit 1 means "the database is behind". Fewer rows than expected is
        # that. MORE rows is a different surprise and gets exit 2, so whatever
        # reads the exit code is not told the opposite of what happened.
        behind = len(applied) < args.expect
        print(
            f"\nFAIL: ledger holds {len(applied)} rows, expected {args.expect} "
            f"({'fewer' if behind else 'MORE'} than expected).",
            file=sys.stderr,
        )
        return EXIT_DRIFT if behind else EXIT_UNKNOWN

    print("OK: every migration this code requires is applied.")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
