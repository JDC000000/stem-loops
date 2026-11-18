"""Idempotent SQL migration runner.

Applies every `apps/worker/migrations/*.sql` exactly once, tracked in a
`_migrations` table. Safe to run repeatedly. Migrations dir is resolved relative
to this file so it works from any working directory.

Statement splitting (L17, session-5 postmortem): the previous implementation
passed each file's entire contents to a single ``conn.execute(f.read())`` call.
With multi-statement SQL that includes ``DO $$ ... $$`` blocks (e.g. migration
023), later statements were observed to be silently dropped — the
``CREATE OR REPLACE VIEW public.v_credit_balance`` that extends the view with
``+ SUM(credit_adjustments.credits_delta)`` never reached the server in CI.
PR #62 pytest surfaced this as a view regression.

Fix: split the SQL text into individual statements and execute each on its own.
The splitter respects single-quoted strings, double-quoted identifiers,
``--`` line comments, ``/* ... */`` block comments (nested), and dollar-quoted
strings ``$tag$ ... $tag$`` — the last one is load-bearing for PL/pgSQL DO
blocks, which embed semicolons inside the body.

The whole file still runs inside a single implicit transaction per migration
(psycopg's connection-level implicit begin): a mid-file failure rolls the
migration back as before.
"""

from __future__ import annotations

import glob
import os
import re
from collections.abc import Iterator

import psycopg

# apps/worker/src/worker/migrate.py -> apps/worker/migrations
MIGRATIONS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "migrations"))

# Matches a dollar-quote opener/closer: $$ or $tag$ where tag is a Postgres
# identifier (letter/underscore followed by alnum/underscore). Deliberately
# does NOT match $1, $2, ... (parameter placeholders): the trailing $ is
# required and the tag may not start with a digit.
_DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def discover_migration_paths(migrations_dir: str | None = None) -> list[str]:
    """The migrations this runner will apply, in the order it applies them.

    Top-level ``*.sql`` only — ``down/`` is a subdirectory and is deliberately
    not matched. Lexical order; there is no ``010``.

    Extracted so there is exactly ONE definition of "the migrations".
    ``scripts/check_migration_drift.py`` compares applied-vs-required and MUST
    agree with the runner about that set; previously each had its own glob and
    a test tried to keep them honest. A test that two copies agree is weaker
    than not having two copies.
    """
    return sorted(glob.glob(os.path.join(migrations_dir or MIGRATIONS_DIR, "*.sql")))


def split_sql_statements(sql: str) -> Iterator[str]:
    """Yield individual SQL statements from ``sql``.

    Splits on ``;`` at the top level only. Preserves ``;`` inside:
      * single-quoted strings (with ``''`` escape)
      * double-quoted identifiers (with ``""`` escape)
      * ``--`` line comments (to end of line)
      * ``/* ... */`` block comments (nested)
      * dollar-quoted strings ``$tag$ ... $tag$`` (required for PL/pgSQL)

    Empty statements (whitespace only) are skipped. Trailing text without a
    final ``;`` is yielded.
    """
    n = len(sql)
    i = 0
    start = 0
    in_sstring = False
    in_dident = False
    in_lcomment = False
    block_depth = 0
    dollar_tag: str | None = None  # inside $tag$...$tag$ when not None

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_lcomment:
            if c == "\n":
                in_lcomment = False
            i += 1
            continue

        if block_depth > 0:
            if c == "*" and nxt == "/":
                block_depth -= 1
                i += 2
                continue
            if c == "/" and nxt == "*":
                block_depth += 1
                i += 2
                continue
            i += 1
            continue

        if dollar_tag is not None:
            end_tag = f"${dollar_tag}$"
            if sql.startswith(end_tag, i):
                i += len(end_tag)
                dollar_tag = None
                continue
            i += 1
            continue

        if in_sstring:
            if c == "'" and nxt == "'":
                i += 2  # '' is an escaped single quote
                continue
            if c == "'":
                in_sstring = False
            i += 1
            continue

        if in_dident:
            if c == '"' and nxt == '"':
                i += 2
                continue
            if c == '"':
                in_dident = False
            i += 1
            continue

        # Top level
        if c == "-" and nxt == "-":
            in_lcomment = True
            i += 2
            continue
        if c == "/" and nxt == "*":
            block_depth = 1
            i += 2
            continue
        if c == "'":
            in_sstring = True
            i += 1
            continue
        if c == '"':
            in_dident = True
            i += 1
            continue
        if c == "$":
            m = _DOLLAR_TAG.match(sql, i)
            if m:
                dollar_tag = m.group(1) or ""
                i = m.end()
                continue
        if c == ";":
            stmt = sql[start:i].strip()
            if stmt:
                yield stmt
            start = i + 1
            i += 1
            continue

        i += 1

    tail = sql[start:].strip()
    if tail:
        yield tail


# The ledger table. Created here, not by a migration, so `scripts/check_rls.py` reads this
# file as well as `migrations/*.sql` (QA track B, B-01).
LEDGER_CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS public._migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz DEFAULT now()
    )
"""

# QA track B, B-01. On Supabase, `anon` and `authenticated` get ALL on every new table in
# `public` by default, and the publishable (anon) key is in the browser bundle. Without RLS
# and this REVOKE, anyone could DELETE a ledger row over PostgREST and the next routine
# `make migrate` would re-run that migration (proved locally: deleting 014's row reverted
# the plans to the pre-034 pricing). So the runner hardens the ledger on EVERY run, before
# it reads it, and migration 041 does the same for a database migrated by hand.
#
# Guarded and idempotent:
#   * ENABLE RLS only when it is off. ALTER TABLE needs ownership; on production RLS is
#     already on, so a runner that does not own the table never attempts it.
#   * REVOKE only for a role that exists (bare Postgres has neither) AND still holds a
#     privilege, so a hardened ledger needs no rights at all to pass through here.
#   * After a REVOKE the privilege is re-checked; if the role can still reach the table
#     (e.g. the runner is not the owner and lacks the grant option, which Postgres reports
#     only as a WARNING that psycopg swallows) it RAISES. A silently open ledger is the bug
#     this block exists for, so it fails the deploy loudly instead.
#   * No policy is created, altered or dropped. The ledger is read and written only by the
#     migration role, which owns the table (owners bypass RLS without FORCE) or has
#     BYPASSRLS. Production's existing `stemloops_app_all` policy is left exactly as it is.
LEDGER_HARDEN_SQL = """
DO $ledger$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public._migrations'::regclass) THEN
    ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND (SELECT bool_or(has_table_privilege('anon', 'public._migrations', p))
            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
    REVOKE ALL ON TABLE public._migrations FROM anon;
    IF (SELECT bool_or(has_table_privilege('anon', 'public._migrations', p))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
      RAISE EXCEPTION 'public._migrations is still accessible to anon after REVOKE (run this as the table owner)';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (SELECT bool_or(has_table_privilege('authenticated', 'public._migrations', p))
            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
    REVOKE ALL ON TABLE public._migrations FROM authenticated;
    IF (SELECT bool_or(has_table_privilege('authenticated', 'public._migrations', p))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
      RAISE EXCEPTION 'public._migrations is still accessible to authenticated after REVOKE (run this as the table owner)';
    END IF;
  END IF;
END
$ledger$
"""


def ensure_ledger(conn: psycopg.Connection) -> None:
    """Create the ledger if needed and close it to the browser roles. Commits."""
    conn.execute(LEDGER_CREATE_SQL)
    conn.execute(LEDGER_HARDEN_SQL)
    conn.commit()


def run() -> None:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        ensure_ledger(conn)
        for path in discover_migration_paths():
            fname = os.path.basename(path)
            already = conn.execute(
                "SELECT 1 FROM public._migrations WHERE filename=%s", (fname,)
            ).fetchone()
            if already:
                print(f"  skip  {fname} (already applied)")
                continue
            with open(path) as f:
                source = f.read()
            for stmt in split_sql_statements(source):
                conn.execute(stmt)
            conn.execute("INSERT INTO public._migrations(filename) VALUES(%s)", (fname,))
            conn.commit()
            print(f"  apply {fname}")
    print("Migrations complete.")


if __name__ == "__main__":
    run()
