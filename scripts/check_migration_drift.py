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

Discovery is NOT reimplemented here. This script calls the runner's own
`worker.migrate.discover_migration_paths()`, so the two cannot disagree about
what "the migrations" are. An earlier version kept a second glob plus a test
that tried to keep the copies honest; three mutations of the runner slipped
past it. One definition beats a test that two definitions agree.

WHY IT DOES NOT EXIT 0 WHEN IT CANNOT CHECK
-------------------------------------------
`claude/seam-inventory.md` lists "secret present vs. job meaningful" as an
unguarded seam, citing a sibling script that exits 0 when its credentials are
absent — passing while checking nothing. A drift gate that silently skips is
worse than no gate, because it produces a green tick that a reader trusts.

So: no DATABASE_URL, an unreachable database, or a missing `_migrations` table
all exit 2. `--allow-no-database` downgrades exactly ONE of those to 0 — a
DATABASE_URL that is entirely UNSET — and says so loudly. Nothing else is
forgiven, ever. A DATABASE_URL that is SET BUT EMPTY exits 2: in GitHub
Actions an unset secret expands to the empty string, so that is a credential
somebody wired which did not arrive.

That narrowness is the whole design, arrived at by having the previous two
versions taken apart. A flag that decides what to forgive by reading an error
message cannot be correct, because the message is localized and the set of
possible messages is not knowable. A flag that forgives one locale-proof,
locally-checkable fact — "nobody told me where the database is" — can be. A missing `_migrations` table is a hard failure rather than "assume
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
  python scripts/check_migration_drift.py --allow-no-database   # CI without a DB

STATUS. ON THIS BRANCH NOTHING RUNS THIS SCRIPT. Review round 5 caught the
previous paragraph here asserting that a CI job executes it; no such job exists
on this ref (`git grep check_migration_drift -- .github/` is empty). The only
invocation lives on the sibling branch `feat/supabase-prelude-migration-matrix`
in the `supabase-prelude-migrations` job, which is NOT an ancestor or descendant
of this one. Merge this branch alone and you get a gate nothing calls — the
seam-class-6 shape this script was written to prevent, reproduced in the script
itself. The two must land together, or the step must move here.

Even once wired, that job CANNOT report drift: it checks a ledger it populated
itself from the same checkout. It proves the gate executes against a real
ledger; it does not protect production.

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
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# scripts/check_migration_drift.py -> apps/worker/migrations
DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "apps" / "worker" / "migrations"

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_UNKNOWN = 2


class Unreachable(Exception):
    """The database could not be CONNECTED to. NOT forgiven since round 6.

    Keyed on the PHASE, not on an exception class. Two earlier versions got
    this wrong in the same direction:

      v1  `except Exception` — a reachable database with an unreadable ledger
          was called "unreachable" and --allow-no-database returned 0.
      v2  `except psycopg.OperationalError` — narrower in name only. That class
          has ~92 subclasses in psycopg 3, including QUERY-time ones: a
          `lock_timeout` or `statement_timeout` cancelling the ledger SELECT
          still landed here, and the flag still returned 0.

    Both let through the exact case the flag must never forgive: the database
    answered and we still do not know what is applied.

      v3  phase alone — "raised by connect() means unreachable". Round 5
          refuted it by measurement: `connect()` also raises when the SERVER
          answered and refused us (`FATAL:  role "x" does not exist`, a wrong
          password, a wrong database name) and when the CLIENT rejected the
          DSN's values before touching the network (`invalid sslmode value`).
          A CI job with a typo'd password was therefore "unreachable" and went
          green. psycopg carries no `sqlstate` on any of these — measured, all
          None — so the phase is necessary but not sufficient.

      v4  message matching — `FATAL:` for a server rejection, a regex for a
          client-side value rejection, everything else forgiven. Round 6
          measured `FATAL:` as a LOCALIZED string and found five more English
          cases the regex missed, among them `fe_sendauth: no password
          supplied` — the "secret present vs. job meaningful" seam this very
          script cites — and every SSL certificate failure, which the planned
          read-only Supabase credential will certainly be able to produce.

    The lesson, and it is the fourth time this file has learned a version of
    it: **the forgiving branch must not depend on classifying the failure.**
    Every version above tried to be cleverer about which failures are benign,
    and each one shipped a false green. So the flag now forgives one fact that
    needs no classification at all — DATABASE_URL being absent — and this class
    is a LABEL for the operator, not a decision. See
    `_classify_connect_failure`.
    """


class BadConfiguration(Exception):
    """DATABASE_URL is not a usable connection string. Never forgiven.

    No database was ever contacted, so "could not reach the database" would be
    a lie. Two kinds land here:

      * the string does not PARSE (`garbage`, `=oops`, a bad `%zz` escape, an
        unknown option name) — caught by `conninfo_to_dict` before connecting;
      * the string parses but the CLIENT rejects a VALUE (`port=notaport`,
        `sslmode=bogus`) — libpq raises this from `connect()` without touching
        the network, so it is caught by message, not by phase.

    This class is now a LABEL, not a decision. Round 6 deleted
    message-based forgiveness entirely, so nothing here changes an exit code --
    a host that does not resolve, a refused port, a rejected DSN and a server
    that refuses us all exit 2. Rounds 4 and 5 both wrote a confident sentence
    here about "where the line sits" and both sentences were wrong; there is no
    line any more, which is the point.
    """


class ServerRejected(Exception):
    """The database answered and refused the connection. Never forgiven.

    A wrong password, a database or role that does not exist, a pg_hba rule
    that excludes this host. The server is plainly reachable — it replied — so
    forgiving this under a flag named `--allow-no-database` would be a false
    green of the worst kind: CI with the wrong credentials, passing.

    Detected by `FATAL:` in the message, libpq's rendering of a server
    ErrorResponse. That match is brittle -- the severity is LOCALIZED -- and
    since round 6 it no longer matters: this class changes no exit code, only
    the sentence the operator reads. A missed match costs a slightly misleading
    message, never a pass.
    """


class LedgerMissing(Exception):
    """`public._migrations` is absent, so the applied set is unknowable.

    Deliberately NOT one of the errors --allow-no-database forgives. Staging
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


# Matches libpq's own phrasing for a value it would not accept, e.g.
# 'invalid integer value "notaport" for connection option "port"' and
# 'invalid sslmode value: "bogus"'. Deliberately NOT matched: 'Connection
# refused' and 'failed to resolve host', which are genuine unreachability.
_CLIENT_REJECTED_VALUE = re.compile(r"invalid \w+ value|for connection option", re.IGNORECASE)

# libpq's rendering of a server ErrorResponse during startup.
_SERVER_ANSWERED = "FATAL:"


def _classify_connect_failure(exc: Exception) -> Exception:
    """Label a connect() failure for the OPERATOR. Decides no exit code.

    Round 5 built this to decide forgiveness and round 6 demolished that:

      * `FATAL:` is the server's LOCALIZED severity. PostgreSQL 16 ships
        `ВАЖНО` (ru), `ФАТАЛЬНО` (uk), `치명적오류` (ko), `致命错误` (zh_CN),
        `KATASTROFALNY` (pl), `FATALE` (it). A wrong password against a server
        with one of those `lc_messages` matched nothing. The client cannot
        force English either: auth and database-existence FATALs are raised
        before startup `options=` are processed.
      * libpq translates the CLIENT half too — `de.po` renders
        `invalid integer value "%s" for connection option "%s"` as
        `ungültiger Zahlenwert …` — so the regex fails under a translated
        libpq as well.
      * psycopg offers no locale-proof field: both `sqlstate` and
        `diag.severity_nonlocalized` are None on connect failures (measured).
      * Even in English it was incomplete. Round 6 measured five more classes
        it missed: `invalid port number: "99999"` (the regex wants
        an `invalid <word> value` regex), `fe_sendauth: no password supplied`, SSL
        certificate failures, `target_session_attrs` mismatches and
        `channel_binding` failures. Every one was forgiven.

    So no exit code depends on this any more. It still earns its place: told
    "the server refused you" rather than "unreachable", an operator stops
    checking the firewall and goes and looks at the password. When the label
    is wrong the operator reads a slightly misleading sentence, which is the
    whole cost now.
    """
    msg = str(exc)
    if _SERVER_ANSWERED in msg:
        return ServerRejected(msg)
    if _CLIENT_REJECTED_VALUE.search(msg):
        return BadConfiguration(msg)
    return Unreachable(msg)


def discover_repo_migrations(migrations_dir: Path) -> list[str]:
    """Basenames of forward migrations, in the runner's own order.

    Calls the RUNNER's own discovery rather than reimplementing it. The two
    must agree about what "the migrations" are, and the strongest way to
    guarantee that is to have one definition. Review round 3: three mutations
    of the runner (append down/, skip a prefix, rewrite to os.walk with the old
    expression left in a docstring) all slipped past a test that compared this
    function against a copy of the glob written in the test.
    """
    src = str(Path(__file__).resolve().parents[1] / "apps" / "worker" / "src")
    if src not in sys.path:  # called per-test; insert() grew sys.path to 36
        sys.path.insert(0, src)
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

    Raises Unreachable ONLY for a connect failure that is neither a server
    rejection nor a client-side DSN rejection — see `_classify_connect_failure`.
    Every post-connect failure — no ledger, no SELECT privilege, a cancelled
    query — propagates as itself and is never forgiven.
    """
    # Imported here rather than at module scope so `--help` works without the
    # dependency. NOTE (round 5): that is now true of `--help` only.
    # `discover_repo_migrations` imports `worker.migrate`, which imports psycopg
    # at module scope, so any real run needs it regardless.
    import psycopg

    # Parse the DSN BEFORE connecting. psycopg raises conninfo errors from
    # connect(), which made a typo'd DATABASE_URL look like an unreachable
    # database and go green under --allow-no-database. A malformed DSN is a
    # configuration error, never an unreachable database. Review round 4, D-B:
    # the help text already promised this; the code did not do it.
    from psycopg.conninfo import conninfo_to_dict

    try:
        conninfo_to_dict(database_url)
    except Exception as exc:
        # Round 7, defect 9: libpq quotes the OFFENDING STRING back at you, and
        # for a typo'd scheme the offending string is the whole DSN -- password
        # included. GitHub masks registered secrets; nothing else does.
        raise BadConfiguration(str(exc).replace(database_url, "<DATABASE_URL>")) from exc

    try:
        conn = psycopg.connect(database_url, connect_timeout=15)
    except Exception as exc:
        raise _classify_connect_failure(exc) from exc

    with conn, conn.cursor() as cur:
        # Round 7, defect 8: with another session holding ACCESS EXCLUSIVE on
        # the ledger this blocked indefinitely -- measured. At deploy time,
        # against a database mid-migration, that is a CI job timeout rather
        # than exit 2, and a timeout tells the operator nothing.
        #
        # Only set what the caller has NOT set: a 0 means "unlimited", i.e.
        # nobody chose. The lock test deliberately passes lock_timeout=300ms in
        # its DSN and must keep it.
        for setting, default in (("lock_timeout", "15s"), ("statement_timeout", "30s")):
            cur.execute(f"SELECT current_setting('{setting}')")
            current = cur.fetchone()
            if current and current[0] in ("0", "0ms"):
                cur.execute(f"SET {setting} = '{default}'")

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
        "--allow-no-database",
        action="store_true",
        help=(
            "forgive exactly ONE thing: DATABASE_URL being entirely UNSET. "
            "(Renamed from --allow-unreachable in round 7: that name promised "
            "the one thing this flag refuses to do. It had no callers.) "
            "Exit 0 with a loud warning, having checked nothing. EVERY other "
            "failure still exits 2, including a database you named and could "
            "not reach. Setting DATABASE_URL is a claim that a database is "
            "there; failing to reach it is a failure, not an absence. A "
            "DATABASE_URL that is set but EMPTY is also not forgiven -- an "
            "unset GitHub secret expands to the empty string, which is a "
            "misconfiguration, not an absent database. (Round 6: "
            "this flag used to forgive by matching libpq's message text, which "
            "is localized and was incomplete in English anyway.)"
        ),
    )
    args = ap.parse_args(argv)

    repo = discover_repo_migrations(args.migrations_dir)
    if not repo:
        print(f"FAIL: no migrations found in {args.migrations_dir}", file=sys.stderr)
        return EXIT_UNKNOWN
    print(f"repo: {len(repo)} migrations, {repo[0]} .. {repo[-1]}")

    # ABSENT and EMPTY are different facts, and conflating them reopened the
    # very seam this gate cites. `env: DATABASE_URL: ${{ secrets.MISSING }}`
    # sets the variable to the EMPTY STRING -- somebody wired a secret and the
    # secret was not there. A job that simply never mentions DATABASE_URL
    # leaves the variable unset. The first is a misconfiguration and must never
    # be forgiven; only the second is the "this job has no database" case the
    # flag exists for. This distinction needs no message parsing and no locale.
    raw = os.environ.get("DATABASE_URL")

    if raw is not None and not raw.strip():
        print(
            "FAIL: DATABASE_URL is SET but empty. Something wired it and the "
            "value did not arrive -- in GitHub Actions an unset secret expands "
            "to the empty string. That is a misconfiguration, not an absent "
            "database, so --allow-no-database does NOT forgive it. If this job "
            "genuinely has no database, stop setting DATABASE_URL at all.",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN

    database_url = (raw or "").strip()
    if not database_url:
        msg = "DATABASE_URL is not set, so drift CANNOT be checked."
        if args.allow_no_database:
            print(
                f"WARNING: {msg} --allow-no-database given; reporting success "
                f"WITHOUT having checked anything.",
                file=sys.stderr,
            )
            return EXIT_OK
        print(
            f"FAIL: {msg} Pass --allow-no-database only if you accept an " f"unchecked deploy.",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN

    try:
        applied = fetch_applied(database_url)
    except ServerRejected as exc:
        # NOT forgiven. The server replied, so it is demonstrably reachable;
        # it refused us. Forgiving this would pass CI on a wrong password.
        print(
            f"FAIL: the database answered and refused the connection: {exc}. "
            f"It is reachable, so --allow-no-database does not forgive this.",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN
    except BadConfiguration as exc:
        # NOT forgiven. Nothing was contacted; the string itself is wrong.
        print(
            f"FAIL: DATABASE_URL is not a valid connection string: {exc}. "
            f"This is a configuration error, not an unreachable database, so "
            f"--allow-no-database does not forgive it.",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN
    except LedgerMissing as exc:
        # NOT forgiven by --allow-no-database. The database answered; it simply
        # cannot say what has been applied. Blessing that would be guessing.
        print(f"FAIL: {exc}", file=sys.stderr)
        return EXIT_UNKNOWN
    except Unreachable as exc:
        # NOT forgiven, even with --allow-no-database. Round 6: see the flag's
        # help text. Setting DATABASE_URL is a claim that a database is there;
        # failing to reach the one you named is a real failure, and a transient
        # network fault forgiven here means drift goes unchecked in silence.
        print(
            f"FAIL: could not reach the database: {exc}. A DATABASE_URL was "
            f"set, so this is a failure, not an absence. --allow-no-database "
            f"forgives only an absent DATABASE_URL.",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN
    except Exception as exc:  # noqa: BLE001
        # Reachable, but the ledger could not be read (no SELECT, no USAGE on
        # public, a cancelled query...). NOT forgivable: the database answered
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


def _cli(argv: list[str] | None = None) -> int:
    """Entry point. Round 5, defect 4: an uncaught exception left Python to
    exit 1, and 1 is this gate's code for "the database is BEHIND". A crash
    was reported to every caller as drift. Unexpected failures are exit 2 --
    "cannot determine" -- which is what a crash actually means.

    Not folded into main(): the tests call main() directly and a bare
    traceback there is more useful than a swallowed 2.

    Takes `argv` for the same reason main() does. Writing the test for this
    guard is what showed it mattered: the first version took no arguments, so
    the only way to exercise it was under pytest, where argparse then read
    PYTEST's argv and exited 2 for the wrong reason -- a pass that proved
    nothing. An entry point that cannot be called with explicit arguments
    cannot be tested.
    """
    try:
        return main(argv)
    except KeyboardInterrupt:
        return EXIT_UNKNOWN
    except Exception:  # noqa: BLE001 - crash handler: blind is the point here
        # Round 7, defect 7: this handler was not total. With stdout AND stderr
        # on a closed pipe, the reporting below raised BrokenPipeError OUT of
        # the handler, and Python exits 1 -- this gate's code for DRIFT. A
        # crash guard whose own reporting can crash past it is not a guard.
        try:
            import traceback

            traceback.print_exc()
            print(
                "\nFAIL: the drift gate itself crashed, so drift is UNDETERMINED "
                "(exit 2). This is not a report that the database is behind.",
                file=sys.stderr,
            )
        except BaseException:  # noqa: BLE001,S110 - reporting must not change the exit code
            pass
        return EXIT_UNKNOWN


if __name__ == "__main__":
    raise SystemExit(_cli())
