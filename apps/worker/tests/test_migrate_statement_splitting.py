"""Regression tests for the migration runner's statement splitter.

Context (L17, session-5 postmortem): the previous ``migrate.run`` passed a
file's entire contents to a single ``conn.execute(f.read())``. With files
that interleave a ``DO $$...$$;`` block and trailing DDL — notably migration
023 — later statements were observed to be silently dropped (the
``CREATE OR REPLACE VIEW public.v_credit_balance`` at the bottom of 023 is
the specific statement that gets dropped in the ``conn.execute(up)`` path
PR #62's ``test_down_migration_round_trip`` uses).

These tests pin:
  1. The splitter yields each top-level statement, including the one past a
     ``DO $$...$$;`` block.
  2. Applying migration 023's statements one-by-one via the splitter DOES
     land the CREATE OR REPLACE VIEW in the live catalog.

NOTE on test ordering: this test applies 023 DIRECTLY in isolation rather
than via ``migrate.run`` — ``migrate.run`` would skip 023 because it is
already recorded in ``_migrations``, and other tests' fixtures
(``test_credit_balance_view_clamp.py``) re-apply migration 022 between
``migrate.run`` and this test, reverting the view. Applying 023 directly
in the test makes it ordering-independent.
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from worker.migrate import split_sql_statements

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


# -------- Integration test: apply 023 via the splitter, verify viewdef ------


@pytestmark_db
def test_splitter_lands_migration_023_view_rewrite() -> None:
    """Direct integration canary: apply migration 023 one statement at a time
    via split_sql_statements, then verify the CREATE OR REPLACE VIEW landed
    in the live catalog.

    023's view: ``purchases + adjustments - consumption`` (no clamp — the
    clamp is tracked as M6, separate from this migration). After 023 applies
    cleanly, pg_get_viewdef MUST contain ``credit_adjustments`` and MUST NOT
    contain ``GREATEST`` (the latter would mean the view is stuck at
    migration 022's state, which is what we're guarding against).

    All of 023's DDL is idempotent (``CREATE TABLE IF NOT EXISTS``,
    ``DROP POLICY IF EXISTS`` + ``CREATE POLICY``, ``CREATE OR REPLACE
    VIEW``, etc.), so this test is safe to re-run on a DB that has already
    had 023 applied — which is the normal CI state.

    Why we apply 023 directly rather than calling ``migrate.run()``:
    ``migrate.run()`` would skip 023 (already in ``_migrations``), and the
    ``test_credit_balance_view_clamp.py`` fixture that runs alphabetically
    before this test re-applies migration 022, reverting the view. Applying
    023 directly in this test makes it ordering-independent."""
    assert DB and any(
        h in DB for h in ("127.0.0.1", "localhost")
    ), "safety: this test applies DDL; local throwaway DB only"

    migration_path = (
        Path(__file__).resolve().parents[1] / "migrations" / "023_v3_credit_adjustments.sql"
    )
    sql = migration_path.read_text()

    # Apply 023 one statement at a time via the splitter — the exact
    # execution path migrate.run() uses in production.
    with psycopg.connect(DB) as conn:
        for stmt in split_sql_statements(sql):
            conn.execute(stmt)
        conn.commit()

        row = conn.execute(
            "SELECT pg_get_viewdef('public.v_credit_balance'::regclass, true)"
        ).fetchone()
        assert row is not None, "v_credit_balance view missing after apply"
        viewdef = row[0]

    assert "credit_adjustments" in viewdef, (
        "migration 023's CREATE OR REPLACE VIEW did NOT land — the "
        "credit_adjustments term is missing from v_credit_balance. "
        f"Statement splitter regressed. Got:\n{viewdef}"
    )
    assert "GREATEST" not in viewdef, (
        "v_credit_balance still has GREATEST clamp after applying 023 — "
        "023 is supposed to REPLACE the view and remove the clamp (M6 is a "
        "separate migration). If GREATEST is still here, 023's CREATE OR "
        f"REPLACE VIEW did not take effect. Got:\n{viewdef}"
    )
