"""Regression tests for the migration runner's statement splitter.

Context (L17, session-5 postmortem): the previous ``migrate.run`` passed a
file's entire contents to a single ``conn.execute(f.read())``. Multi-statement
files that mixed DO blocks with trailing DDL silently dropped the trailing
statements in CI — specifically the ``CREATE OR REPLACE VIEW
public.v_credit_balance`` at the bottom of migration 023, which extends the
view to include ``+ SUM(credit_adjustments.credits_delta)``.

These tests pin that the splitter yields each top-level statement, including
the one past a ``DO $$...$$;`` block, and that running ``migrate.run`` against
a real Postgres lands the 023 view extension on-disk.
"""

from __future__ import annotations

import os

import psycopg
import pytest

from worker.migrate import run, split_sql_statements

DB = os.environ.get("DATABASE_URL")
pytestmark_db = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")


# -------- Unit tests for split_sql_statements (no DB) -----------------------


def test_split_simple_two_statements() -> None:
    sql = "SELECT 1; SELECT 2;"
    assert list(split_sql_statements(sql)) == ["SELECT 1", "SELECT 2"]


def test_split_trailing_statement_without_semicolon() -> None:
    sql = "SELECT 1;\nSELECT 2"
    assert list(split_sql_statements(sql)) == ["SELECT 1", "SELECT 2"]


def test_split_ignores_semicolon_in_single_quoted_string() -> None:
    sql = "INSERT INTO t VALUES ('a;b'); SELECT 1;"
    assert list(split_sql_statements(sql)) == [
        "INSERT INTO t VALUES ('a;b')",
        "SELECT 1",
    ]


def test_split_handles_doubled_single_quote_escape() -> None:
    # SQL-standard '' inside a string is a literal single quote, not a close.
    sql = "INSERT INTO t VALUES ('O''Brien;'); SELECT 1;"
    assert list(split_sql_statements(sql)) == [
        "INSERT INTO t VALUES ('O''Brien;')",
        "SELECT 1",
    ]


def test_split_ignores_semicolon_in_double_quoted_identifier() -> None:
    sql = 'CREATE TABLE "weird;name" (id int); SELECT 1;'
    assert list(split_sql_statements(sql)) == [
        'CREATE TABLE "weird;name" (id int)',
        "SELECT 1",
    ]


def test_split_ignores_semicolon_in_line_comment() -> None:
    sql = "SELECT 1; -- this; has; semicolons\nSELECT 2;"
    stmts = list(split_sql_statements(sql))
    assert stmts == ["SELECT 1", "-- this; has; semicolons\nSELECT 2"]


def test_split_ignores_semicolon_in_block_comment() -> None:
    sql = "SELECT 1 /* a; b; c */; SELECT 2;"
    assert list(split_sql_statements(sql)) == [
        "SELECT 1 /* a; b; c */",
        "SELECT 2",
    ]


def test_split_handles_nested_block_comment() -> None:
    sql = "SELECT 1 /* outer /* inner; */ still-outer; */; SELECT 2;"
    stmts = list(split_sql_statements(sql))
    assert len(stmts) == 2
    assert stmts[1] == "SELECT 2"


def test_split_ignores_semicolon_in_dollar_quoted_body() -> None:
    sql = (
        "DO $$ BEGIN\n"
        "  IF true THEN\n"
        "    PERFORM 1;\n"
        "    PERFORM 2;\n"
        "  END IF;\n"
        "END $$;\n"
        "CREATE OR REPLACE VIEW v AS SELECT 1 AS x;"
    )
    stmts = list(split_sql_statements(sql))
    assert len(stmts) == 2
    assert stmts[0].startswith("DO $$")
    assert stmts[0].endswith("END $$")
    assert stmts[1] == "CREATE OR REPLACE VIEW v AS SELECT 1 AS x"


def test_split_handles_tagged_dollar_quote() -> None:
    sql = "SELECT $tag$ a;b $tag$; SELECT 1;"
    assert list(split_sql_statements(sql)) == [
        "SELECT $tag$ a;b $tag$",
        "SELECT 1",
    ]


def test_split_does_not_treat_parameter_placeholders_as_dollar_quotes() -> None:
    # $1, $2 are parameter placeholders, not dollar-quote openers.
    sql = "SELECT $1; SELECT $2;"
    assert list(split_sql_statements(sql)) == ["SELECT $1", "SELECT $2"]


def test_split_skips_empty_statements() -> None:
    sql = ";;;SELECT 1;;;"
    assert list(split_sql_statements(sql)) == ["SELECT 1"]


def test_split_migration_023_shape() -> None:
    """Shape-pin: migration 023 has a DO block followed by a CREATE OR REPLACE
    VIEW. The splitter must yield the view as its own statement."""
    sql = """
-- 023 shape

CREATE TABLE IF NOT EXISTS public.credit_adjustments (id uuid PRIMARY KEY);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cowork_ro_read') THEN
      CREATE POLICY cowork_ro_read ON public.credit_adjustments FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_credit_balance
  WITH (security_invoker = true)
AS
  SELECT u.id AS user_id,
    COALESCE((SELECT SUM(credits_granted)::bigint FROM public.credit_purchases WHERE user_id = u.id), 0)
    + COALESCE((SELECT SUM(credits_delta)::bigint FROM public.credit_adjustments WHERE user_id = u.id), 0)
    - (SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = u.id)
    AS credits_remaining
  FROM public.users u;
"""
    stmts = list(split_sql_statements(sql))
    assert len(stmts) == 3, f"expected 3 statements, got {len(stmts)}: {stmts}"
    # Leading comment trivia may be attached to the first statement — that's
    # fine (Postgres ignores comments in execute). What matters is that the
    # CREATE TABLE, DO block, and CREATE OR REPLACE VIEW each land as their
    # OWN statement rather than being swallowed together.
    assert "CREATE TABLE IF NOT EXISTS public.credit_adjustments" in stmts[0]
    assert "DO $$" not in stmts[0]
    assert stmts[1].lstrip().startswith("DO $$")
    assert stmts[2].lstrip().startswith("CREATE OR REPLACE VIEW public.v_credit_balance")
    assert "credit_adjustments" in stmts[2]


# -------- Integration test: run migrate against the CI Postgres -------------


@pytestmark_db
def test_migrate_lands_migration_023_view_extension() -> None:
    """After migrate.run(), pg_get_viewdef('public.v_credit_balance') must
    contain BOTH the GREATEST clamp (migration 022) AND the credit_adjustments
    term (migration 023). The old migrate.py silently dropped the 023 view
    rewrite in CI; this test is the canary."""
    assert DB and any(
        h in DB for h in ("127.0.0.1", "localhost")
    ), "safety: this test runs only against a local throwaway DB"

    # Idempotent — if already applied in this CI container, this is a no-op.
    run()

    with psycopg.connect(DB) as conn:
        row = conn.execute(
            "SELECT pg_get_viewdef('public.v_credit_balance'::regclass, true)"
        ).fetchone()
        assert row is not None, "v_credit_balance view missing after migrate"
        viewdef = row[0]

    assert "credit_adjustments" in viewdef, (
        "migration 023 view rewrite did NOT land — the + SUM(credit_adjustments) "
        "term is missing from v_credit_balance. Statement splitter regressed."
    )
    assert "GREATEST" in viewdef, (
        "migration 022 clamp did NOT land — GREATEST(0, ...) missing from "
        "v_credit_balance. Statement splitter regressed."
    )
