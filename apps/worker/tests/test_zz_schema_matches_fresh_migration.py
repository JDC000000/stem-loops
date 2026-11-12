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
the database under test. Schema only: rows are ignored (other tests own their
data cleanup). Any CREATE POLICY / CHECK / GRANT / function / index difference
fails the test and is printed as a unified diff.

ORDER (read this before moving or renaming the file)
----------------------------------------------------
It is meant to run LAST, after every other DB test has had its chance to
mutate the schema. There is no ordering plugin; pytest collects files
alphabetically, hence the ``zz``. Run alone it still proves the database is
equal to a fresh one, but then it says nothing about the other tests. A file
named later than this one would escape the guard.

SCOPE
-----
Verified against PostgreSQL 16 only. pg_dump must be at least the server's
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

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="creates and drops a scratch database; local only")

# Random per-dump token (pg_dump >= 16.10 / 17.6); not part of the schema.
_RESTRICT = re.compile(r"^\\(un)?restrict .*$", re.MULTILINE)


def _dump(dsn: str) -> list[str]:
    pg_dump = shutil.which("pg_dump")
    if pg_dump is None:
        msg = "pg_dump not on PATH; the schema-equality guard cannot run"
        # In CI a missing tool must be red, not a quiet skip: a guard that skips
        # is a green tick that checked nothing.
        if os.environ.get("CI"):
            pytest.fail(msg)
        pytest.skip(msg)
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
