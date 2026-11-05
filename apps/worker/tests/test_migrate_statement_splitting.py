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


def test_split_migration_025_shape() -> None:
    """Shape-pin: migration 025 (chord_edits, PR-Y1.7) has CREATE TABLE,
    multiple policies, a DO block for cowork_ro, and a trailing COMMENT ON
    TABLE. All must survive the splitter as their own statements."""
    migration = Path(__file__).resolve().parents[1] / "migrations" / "025_v3_chord_edits.sql"
    stmts = list(split_sql_statements(migration.read_text()))
    # Expected shape: CREATE TABLE, 2 indexes, ALTER .. ENABLE RLS, 2 DROP
    # POLICY + 2 CREATE POLICY (user), 3 DROP POLICY + 2 CREATE POLICY
    # (stemloops_app), GRANT, REVOKE, DO $$..$$ (cowork_ro), COMMENT.
    assert any(
        "CREATE TABLE IF NOT EXISTS public.chord_edits" in s for s in stmts
    ), "CREATE TABLE statement lost"
    assert any(
        "ALTER TABLE public.chord_edits ENABLE ROW LEVEL SECURITY" in s for s in stmts
    ), "ENABLE RLS statement lost"
    do_blocks = [s for s in stmts if "DO $$" in s and "END $$" in s]
    assert len(do_blocks) == 1, f"expected 1 DO block, got {len(do_blocks)}"
    # The COMMENT ON TABLE comes AFTER the DO block — this is the exact shape
    # that session-5 postmortem said the pre-fix splitter would silently drop.
    assert any(
        s.lstrip().startswith("COMMENT ON TABLE public.chord_edits") for s in stmts
    ), "trailing COMMENT ON TABLE swallowed"
    # The Harte regex CHECK needs its literal regex preserved — the $ anchor
    # could theoretically confuse a naive dollar-quote scanner.
    create_table = next(s for s in stmts if "CREATE TABLE IF NOT EXISTS public.chord_edits" in s)
    assert "chord_edits_valid_harte" in create_table
    assert "N|X|[A-G]" in create_table


# -------- Integration test: apply 023 via the splitter, verify viewdef ------


@pytestmark_db
def test_splitter_lands_migration_023_view_rewrite() -> None:
    """Direct integration canary: apply migration 023 (then 024 to restore the
    partial-refund index shape) one statement at a time via
    split_sql_statements, then verify the CREATE OR REPLACE VIEW landed in
    the live catalog.

    023's view (as of PR #62): ``GREATEST(0, purchases + adjustments -
    consumption)`` — the GREATEST clamp folded into the same migration.
    After 023 applies cleanly, pg_get_viewdef MUST contain both
    ``credit_adjustments`` AND ``GREATEST``.

    Why we also re-apply 024: migration 023 unconditionally
    ``CREATE UNIQUE INDEX IF NOT EXISTS credit_adjustments_one_refund_per_charge_idx``,
    and migration 024 ``DROP INDEX IF EXISTS`` that and swaps in the
    non-unique partial ``credit_adjustments_refund_charge_idx``. Re-running
    only 023 against a post-024 DB would resurrect the dropped UNIQUE
    (the IF NOT EXISTS guard is satisfied), which then breaks every
    subsequent test that inserts >1 refund row per charge (notably
    ``test_pro_rata_clawback.py``). Re-applying 024 after 023 restores the
    final index shape, so this test leaves the DB in post-024 state.

    All of 023's and 024's DDL is idempotent, so this test is safe to re-run
    on a DB that has already had both applied — which is the normal CI
    state.

    Why we apply 023 directly rather than calling ``migrate.run()``:
    ``migrate.run()`` would skip 023 (already in ``_migrations``), and the
    ``test_credit_balance_view_clamp.py`` fixture that runs alphabetically
    before this test re-applies migration 022, reverting the view. Applying
    023 directly in this test makes it ordering-independent."""
    assert DB and any(
        h in DB for h in ("127.0.0.1", "localhost")
    ), "safety: this test applies DDL; local throwaway DB only"

    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    sql_023 = (migrations_dir / "023_v3_credit_adjustments.sql").read_text()
    sql_024 = (migrations_dir / "024_v3_credit_adjustments_partial_refund_index.sql").read_text()

    # Apply 023 then 024 one statement at a time via the splitter — the exact
    # execution path migrate.run() uses in production. 024 reverses the
    # UNIQUE one-refund-per-charge index that 023 would re-create, so tests
    # that insert multiple refund rows per charge continue to work.
    with psycopg.connect(DB) as conn:
        for stmt in split_sql_statements(sql_023):
            conn.execute(stmt)
        for stmt in split_sql_statements(sql_024):
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
    assert "GREATEST" in viewdef, (
        "migration 023's CREATE OR REPLACE VIEW did NOT land — the GREATEST "
        "clamp is missing from v_credit_balance. 023 folds the M6 clamp into "
        "the same migration as the credit_adjustments term; absence of "
        "GREATEST means the splitter dropped the view rewrite and the view "
        f"is stuck at a pre-023 state. Got:\n{viewdef}"
    )
