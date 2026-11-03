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
    sql = (
        "-- this shouldn't open a string\n"
        "-- rls-backend-only: plans\n"
        "SELECT 'x';\n"
    )
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
    sql = (
        "-- don't mind me\n"
        "SELECT 'a -- b', 'x';\n"
        "-- rls-backend-only: real\n"
    )
    assert _markers(sql) == {"real"}


def test_marker_inside_dollar_body_and_block_comment_ignored():
    sql = (
        "DO $$ BEGIN\n-- rls-backend-only: evil1\nEND $$;\n"
        "/* it's\n-- rls-backend-only: evil2\n*/\n"
        "-- rls-backend-only: ok\n"
    )
    assert _markers(sql) == {"ok"}


def test_escape_string_and_quoted_identifier():
    sql = (
        "SELECT E'it\\'s\\n-- rls-backend-only: evil', \"it's\";\n"
        "-- rls-backend-only: ok\n"
    )
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
    rc, out = _run(tmp_path, {"013_w.sql": catchup, "014_w.sql": sql.replace("widgets", "later")}, capsys)
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
