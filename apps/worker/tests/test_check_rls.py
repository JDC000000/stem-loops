"""Unit tests for scripts/check_rls.py (the SL-B26 RLS CI gate).

Covers the line-comment masker fix (apostrophes in `--` comments must not open
phantom string regions that swallow later backend-only markers) and the TSD
2.1a rules (c) stemloops_app_all / (d) cowork_ro_read.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_rls.py"
_spec = importlib.util.spec_from_file_location("check_rls", _SCRIPT)
check_rls = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_rls)


def _markers(sql: str) -> set[str]:
    masked = check_rls._mask_non_comment_lexical(sql)
    found: set[str] = set()
    for m in check_rls.BACKEND_ONLY_MARKER_RE.finditer(masked):
        found.update(n.strip() for n in m.group(1).split(","))
    return found


# -- Bug 1: masker ------------------------------------------------------------


def test_apostrophe_in_line_comment_does_not_swallow_later_marker():
    sql = "-- this shouldn't open a string\n" "-- rls-backend-only: plans\n" "SELECT 'x';\n"
    assert _markers(sql) == {"plans"}


def test_apostrophe_in_comment_between_marker_and_ddl():
    sql = (
        "-- rls-backend-only: a\n"
        "-- the gate doesn't care\n"
        "-- rls-backend-only: b\n"
        "CREATE TABLE a (id int DEFAULT 'x');\n"
    )
    assert _markers(sql) == {"a", "b"}


def test_marker_inside_string_still_ignored():
    sql = "INSERT INTO t VALUES ('\n-- rls-backend-only: evil\n');\n"
    assert _markers(sql) == set()


def test_marker_inside_string_with_dashes_and_apostrophe_comment():
    # `--` inside a string must not truncate the string (and leave a dangling
    # quote), and a later real marker must still be seen.
    sql = "-- don't mind me\n" "SELECT 'a -- b', 'x';\n" "-- rls-backend-only: real\n"
    assert _markers(sql) == {"real"}


def test_marker_inside_dollar_body_and_block_comment_ignored():
    sql = (
        "DO $$ BEGIN\n-- rls-backend-only: evil1\nEND $$;\n"
        "/* it's\n-- rls-backend-only: evil2\n*/\n"
        "-- rls-backend-only: ok\n"
    )
    assert _markers(sql) == {"ok"}


def test_escape_string_and_quoted_identifier():
    sql = "SELECT E'it\\'s\\n-- rls-backend-only: evil', \"it's\";\n" "-- rls-backend-only: ok\n"
    assert _markers(sql) == {"ok"}


def test_masker_preserves_length_and_newlines():
    sql = "-- don't\nSELECT 'a\nb', $$x\ny$$; /* c\nd */\n"
    assert len(check_rls._mask_non_comment_lexical(sql)) == len(sql)
    assert check_rls._mask_non_comment_lexical(sql).count("\n") == sql.count("\n")


# -- Bug 2: rules (c)/(d) -----------------------------------------------------

_GOOD = """\
-- rls-backend-only: widgets
CREATE TABLE IF NOT EXISTS public.widgets (id int PRIMARY KEY);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY stemloops_app_all ON public.widgets FOR ALL TO stemloops_app
  USING (true) WITH CHECK (true);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['widgets'] LOOP
    EXECUTE format('CREATE POLICY cowork_ro_read ON public.%I FOR SELECT TO cowork_ro USING (true)', t);
  END LOOP;
END $$;
"""


def _run(tmp_path, files: dict[str, str], capsys, strict_from=13):
    for name, body in files.items():
        (tmp_path / name).write_text(body)
    rc = check_rls.main(tmp_path, strict_from=strict_from)
    return rc, capsys.readouterr().out


def test_good_migration_passes(tmp_path, capsys):
    rc, out = _run(tmp_path, {"013_w.sql": _GOOD}, capsys)
    assert rc == 0, out


def test_comment_with_apostrophe_before_marker_passes_gate(tmp_path, capsys):
    sql = _GOOD.replace(
        "-- rls-backend-only: widgets\n",
        "-- shouldn't matter\n-- rls-backend-only: widgets\n",
    )
    rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
    assert rc == 0, out


def test_missing_stemloops_app_all_fails(tmp_path, capsys):
    sql = _GOOD.replace("stemloops_app_all", "some_other_policy")
    rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
    assert rc == 1 and "rule c" in out and "widgets" in out


def test_stemloops_app_all_wrong_role_or_command_fails(tmp_path, capsys):
    for bad in ("FOR SELECT TO stemloops_app", "FOR ALL TO service_role"):
        sql = _GOOD.replace("FOR ALL TO stemloops_app", bad)
        rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
        assert rc == 1 and "rule c" in out, bad


def test_missing_cowork_ro_read_fails(tmp_path, capsys):
    sql = _GOOD.split("DO $$")[0]
    rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
    assert rc == 1 and "rule d" in out and "rule c" not in out


def test_direct_cowork_policy_satisfies_rule_d(tmp_path, capsys):
    sql = _GOOD.split("DO $$")[0] + (
        "CREATE POLICY cowork_ro_read ON public.widgets FOR SELECT TO cowork_ro USING (true);\n"
    )
    rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
    assert rc == 0, out


def test_do_block_for_other_table_does_not_cover(tmp_path, capsys):
    sql = _GOOD.replace("ARRAY['widgets']", "ARRAY['gadgets']")
    rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
    assert rc == 1 and "rule d" in out


def test_pg_tables_loop_covers_all_tables_so_far(tmp_path, capsys):
    catchup = """\
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('CREATE POLICY cowork_ro_read ON public.%I FOR SELECT TO cowork_ro USING (true)', t);
    EXECUTE format('CREATE POLICY stemloops_app_all ON public.%I FOR ALL TO stemloops_app USING (true)', t);
  END LOOP;
END $$;
"""
    sql = _GOOD.split("DO $$")[0].replace(
        "CREATE POLICY stemloops_app_all ON public.widgets FOR ALL TO stemloops_app\n"
        "  USING (true) WITH CHECK (true);\n",
        "CREATE POLICY widgets_x ON public.widgets FOR SELECT TO authenticated USING (false);\n",
    )
    rc, out = _run(tmp_path, {"013_w.sql": sql, "014_catchup.sql": catchup}, capsys)
    assert rc == 0, out
    # ...but a loop in an EARLIER migration does not cover a later table.
    rc, out = _run(
        tmp_path, {"013_w.sql": catchup, "014_w.sql": sql.replace("widgets", "later")}, capsys
    )
    assert rc == 1 and "later" in out


def test_pre_strict_tables_exempt_but_strict_from_1_enforces(tmp_path, capsys):
    legacy = (
        "-- rls-backend-only: old\n"
        "CREATE TABLE old (id int);\n"
        "ALTER TABLE old ENABLE ROW LEVEL SECURITY;\n"
        "CREATE POLICY old_x ON old FOR SELECT TO authenticated USING (false);\n"
    )
    rc, out = _run(tmp_path, {"009_old.sql": legacy}, capsys)
    assert rc == 0, out
    rc, out = _run(tmp_path, {"009_old.sql": legacy}, capsys, strict_from=1)
    assert rc == 1 and "rule c" in out and "rule d" in out


def test_real_migrations_tree_passes(capsys):
    migrations = Path(__file__).resolve().parents[1] / "migrations"
    assert check_rls.main(migrations) == 0, capsys.readouterr().out


@pytest.mark.parametrize("name", ["stemloops_app_all", '"stemloops_app_all"'])
def test_quoted_policy_name_accepted(tmp_path, capsys, name):
    sql = _GOOD.replace("CREATE POLICY stemloops_app_all", f"CREATE POLICY {name}")
    rc, out = _run(tmp_path, {"013_w.sql": sql}, capsys)
    assert rc == 0, out


# --- Round-2: strip_sql_comments bypass fix (LOW-MED finding) ---------------


def test_strip_comments_does_not_mis_interpret_block_comment_in_string(tmp_path, capsys):
    """Round-1 Lens finding: `SELECT '/*'; CREATE TABLE evil(...); SELECT '*/';`
    ate the CREATE TABLE as if it were a block-comment body (regex approach
    is single-pass; a `/*` inside a string literal still opened a comment).
    Must now see the CREATE TABLE and flag it as unprotected."""
    sql = "SELECT '/*';\n" "CREATE TABLE evil (id int);\n" "SELECT '*/';\n"
    rc, out = _run(tmp_path, {"013_e.sql": sql}, capsys)
    assert rc == 1, out
    assert "evil" in out, "evil table slipped past strip_sql_comments; gate bypass vector"


def test_strip_comments_does_not_truncate_string_with_double_dash(tmp_path, capsys):
    """A `--` inside a string literal must stay plain text; it must not
    short-circuit the rest of a line of DDL (round-1 Lens finding)."""
    sql = "INSERT INTO plans VALUES ('free -- not a comment');\n" "CREATE TABLE evil (id int);\n"
    rc, out = _run(tmp_path, {"013_e.sql": sql}, capsys)
    # The CREATE TABLE must still be recognised (it is on its own line, so
    # the behaviour is "see the table and complain about missing RLS").
    assert rc == 1, out
    assert "evil" in out


# --- audit MINOR (session-4): STRICT_FROM_MIGRATION env override -----------


def test_strict_from_env_default_matches_constant(monkeypatch):
    """Unset / empty env var → read the in-file constant (unchanged default)."""
    monkeypatch.delenv("STRICT_FROM_MIGRATION", raising=False)
    assert check_rls._strict_from_env() == check_rls.STRICT_FROM_MIGRATION
    monkeypatch.setenv("STRICT_FROM_MIGRATION", "")
    assert check_rls._strict_from_env() == check_rls.STRICT_FROM_MIGRATION


def test_strict_from_env_integer_override(monkeypatch):
    """A valid integer wins over the in-file constant."""
    monkeypatch.setenv("STRICT_FROM_MIGRATION", "13")
    assert check_rls._strict_from_env(default=1) == 13
    monkeypatch.setenv("STRICT_FROM_MIGRATION", "0")
    assert check_rls._strict_from_env(default=1) == 0


def test_strict_from_env_bad_value_aborts(monkeypatch):
    """Non-integer and negative values fail fast rather than silently defaulting
    (a silent fallback would let `STRICT_FROM_MIGRATION=true` disable the gate
    in CI unseen)."""
    monkeypatch.setenv("STRICT_FROM_MIGRATION", "true")
    with pytest.raises(SystemExit):
        check_rls._strict_from_env()
    monkeypatch.setenv("STRICT_FROM_MIGRATION", "-3")
    with pytest.raises(SystemExit):
        check_rls._strict_from_env()


def test_strict_from_env_applied_end_to_end(tmp_path, capsys, monkeypatch):
    """A migration that would FAIL rules (c)/(d) at strict_from=1 must PASS
    when STRICT_FROM_MIGRATION is set high enough to exclude it."""
    legacy = (
        "-- rls-backend-only: old\n"
        "CREATE TABLE old (id int);\n"
        "ALTER TABLE old ENABLE ROW LEVEL SECURITY;\n"
        "CREATE POLICY old_x ON old FOR SELECT TO authenticated USING (false);\n"
    )
    (tmp_path / "009_old.sql").write_text(legacy)
    # At the default (1), this legacy migration fails rules c+d.
    assert check_rls.main(tmp_path, strict_from=1) != 0
    # With the env override pushed above the migration number, same tree passes.
    monkeypatch.setenv("STRICT_FROM_MIGRATION", "13")
    rc = check_rls.main(tmp_path, strict_from=check_rls._strict_from_env())
    assert rc == 0, capsys.readouterr().out


# --- Round-2: ratchet to flip STRICT_FROM_MIGRATION when 011 lands ----------


def test_ratchet_fails_once_011_exists_in_tree(tmp_path, capsys):
    """Round-1 Lens finding: STRICT_FROM_MIGRATION=13 means rules (c)/(d) do
    not actually fire on V2-era tables until 011 (role catchup) merges to
    v3/main AND the constant is lowered to 1. There is no mechanism forcing
    that flip. This ratchet test fails once 011_*.sql exists in the real
    migrations tree while the constant is still > 1 — the fix is a 1-char
    change to the constant.
    """
    migrations = Path(__file__).resolve().parents[1] / "migrations"
    eleven_exists = any(migrations.glob("011_*.sql"))
    if eleven_exists and check_rls.STRICT_FROM_MIGRATION > 1:
        raise AssertionError(
            "011_*.sql is on the base branch now. Lower STRICT_FROM_MIGRATION "
            "to 1 in scripts/check_rls.py so rules (c)/(d) cover the full tree. "
            f"(current: STRICT_FROM_MIGRATION={check_rls.STRICT_FROM_MIGRATION})"
        )
