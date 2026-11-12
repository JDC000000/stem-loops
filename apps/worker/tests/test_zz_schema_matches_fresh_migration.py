"""Guard: after the whole suite has run, the schema must equal a freshly migrated one.

WHY THIS EXISTS
---------------
Tests that mutate committed DDL and then "put it back" by hand have broken the
shared database three times: test_chord_edits_schema.py's down-migration round
trip re-applied a hand-kept list of migrations, and the list was wrong for 026,
then 029, then 027 (two policies came back on every reused database). Each was
found only when some other test happened to trip over that one symptom.
Nothing compared the schema as a whole. This does.

WHAT IT CHECKS
--------------
Builds a scratch database, applies every migration to it with the real runner,
and compares ``pg_dump --schema-only`` of it with ``pg_dump --schema-only`` of
the database under test. Any difference in what ``pg_dump -s`` of ONE database
prints fails the test and is shown as a unified diff: tables and columns,
constraints, indexes, views, functions and triggers, RLS enablement and
policies, extensions, and the GRANT / REVOKE / ALTER DEFAULT PRIVILEGES
statements on objects INSIDE the database (tables, sequences, functions,
schemas).

WHAT IT CANNOT SEE (do not read a green tick as covering these)
----------------------------------------------------------------
Roles are cluster-global, and ``pg_dump -s`` of one database cannot emit them
(they come from ``pg_dumpall --globals-only``). The scratch database lives in
the SAME cluster and so shares the very same roles; comparing the two could not
see a difference even in principle. Each of these was drifted by hand and the
guard stayed green:

  1. role attributes       (ALTER ROLE ... BYPASSRLS / CREATEDB / SUPERUSER ...)
  2. role connection limit (ALTER ROLE ... CONNECTION LIMIT)
  3. role memberships      (GRANT <role> TO <role>; a GRANT, but not on an object)
  4. role GUCs             (ALTER ROLE ... SET ...)
  5. role-in-database GUCs (ALTER ROLE ... IN DATABASE ... SET ...)
  6. database GUCs         (ALTER DATABASE ... SET ...)
  7. database ACL          (GRANT / REVOKE CONNECT ON DATABASE ...)
  8. seeded row data, edited (UPDATE of a migration-seeded plans / credit_packs row)
  9. seeded row data, deleted

So "any GRANT difference fails" is true only of grants on objects inside the
database. Role-level and database-level state, and every row, are unchecked
here. Catching them needs a before/after snapshot of the cluster globals taken
at session start (a session-scoped fixture in conftest.py) or a second cluster
to compare against; neither exists yet. Rows are also ignored by design (other
tests own their data cleanup).

ORDER (read this before moving or renaming the file)
----------------------------------------------------
It is meant to run LAST, after every other DB test has had its chance to
mutate the schema. There is no ordering plugin; pytest collects files
alphabetically, hence the ``zz``. Run alone it still proves the database is
equal to a fresh one, but then it says nothing about the other tests. A file
named later than this one would escape the guard.

SCOPE
-----
Verified against PostgreSQL 16 only (CI runs postgres:16; production is 17.6, so
anything version-sensitive here is unproven against production). pg_dump must be at least the server's
version; the ``\\restrict`` / ``\\unrestrict`` lines newer pg_dump releases emit
carry a random token per dump and are stripped before comparing.
"""

from __future__ import annotations

import difflib
import os
import re
import shutil
import subprocess
import uuid

import psycopg
import psycopg.sql
import pytest
from psycopg.conninfo import make_conninfo

import worker.migrate as migrate
from tests.test_chord_edits_schema import _not_local, _skip_or_fail

DB = os.environ.get("DATABASE_URL")


@pytest.fixture(autouse=True)
def _require_local_database() -> None:
    """Skip locally, FAIL under CI=true, unless DATABASE_URL is set and provably local.

    This test CREATEs and DROPs a database, so a non-local URL is a safety refusal, and a
    refusal that returns green in CI is a guard that did not run. (Shares its helpers with
    test_chord_edits_schema.py until PR #224's ``tests/db_guard.py`` lands.)
    """
    if not DB:
        _skip_or_fail("DATABASE_URL not set")
    problem = _not_local(DB)
    if problem:
        _skip_or_fail(
            f"DATABASE_URL is not provably local ({problem}); this test creates and "
            "drops a scratch database"
        )


# Random per-dump token (pg_dump >= 16.10 / 17.6); not part of the schema.
_RESTRICT = re.compile(r"^\\(un)?restrict .*$", re.MULTILINE)


def _dump(dsn: str) -> list[str]:
    pg_dump = shutil.which("pg_dump")
    if pg_dump is None:
        # In CI a missing tool must be red, not a quiet skip: a guard that skips
        # is a green tick that checked nothing.
        _skip_or_fail("pg_dump not on PATH; the schema-equality guard cannot run")
        raise AssertionError("unreachable")
    out = subprocess.run(
        [pg_dump, "--schema-only", f"--dbname={dsn}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return _RESTRICT.sub("", out).splitlines()


def test_schema_equals_freshly_migrated_database(monkeypatch):
    assert DB is not None
    scratch = f"schema_guard_{uuid.uuid4().hex[:12]}"
    scratch_dsn = make_conninfo(DB, dbname=scratch)
    # CREATE DATABASE cannot run in a transaction; use the database under test
    # as the place to issue it from.
    with psycopg.connect(DB, autocommit=True) as admin:
        admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8'").format(
                psycopg.sql.Identifier(scratch)
            )
        )
        try:
            monkeypatch.setenv("DATABASE_URL", scratch_dsn)
            migrate.run()
            expected = _dump(scratch_dsn)
        finally:
            admin.execute(
                psycopg.sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                    psycopg.sql.Identifier(scratch)
                )
            )
    actual = _dump(DB)
    assert len(expected) > 100, "fresh schema dump is implausibly small; the guard is vacuous"
    diff = list(
        difflib.unified_diff(
            expected, actual, "freshly migrated", "database under test", lineterm="", n=1
        )
    )
    assert not diff, (
        "the database under test no longer matches a freshly migrated one - a test "
        "(or a migration applied by hand) changed the schema and did not restore it:\n"
        + "\n".join(diff)
    )
