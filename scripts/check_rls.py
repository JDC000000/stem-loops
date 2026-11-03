#!/usr/bin/env python3
"""
SL-B26 #1 CI gate: assert every table defined in apps/worker/migrations/*.sql
has (a) ENABLE ROW LEVEL SECURITY and (b) at least one CREATE POLICY ... ON
that table, somewhere in the migrations tree.

Scope: migrations/*.sql (the runner glob). Down migrations are not checked
because the runner never applies them.

Usage: python scripts/check_rls.py [MIGRATIONS_DIR]
Exit 0 if all tables covered, 1 otherwise. Prints a per-table verdict.

Deliberately simple: regex over SQL text, not a real parser. False positives
on string literals or commented-out DDL are the author's problem to make the
regex happy — a parser is overkill for a migrations folder we control.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE,
)
ENABLE_RLS_RE = re.compile(
    r"ALTER\s+TABLE\s+(?:%I|\"?)([A-Za-z_][A-Za-z0-9_]*)\"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY",
    re.IGNORECASE,
)
# Match either literal `ALTER TABLE jobs ENABLE RLS` OR the format(...) pattern
# used in 009's DO blocks, by scanning the plain text FOREACH array for members.
FOREACH_ARRAY_RE = re.compile(
    r"FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)\]",
    re.IGNORECASE,
)
CREATE_POLICY_RE = re.compile(
    r"CREATE\s+POLICY\s+[^\s]+\s+ON\s+(?:%I|\"?)([A-Za-z_][A-Za-z0-9_]*)\"?",
    re.IGNORECASE,
)


def strip_sql_comments(text: str) -> str:
    """Remove -- line comments and /* ... */ block comments."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"--[^\n]*", "", text)
    return text


def tables_in_foreach(sql: str) -> set[str]:
    """Expand table names from DO block FOREACH ... IN ARRAY ARRAY[...] patterns."""
    tables: set[str] = set()
    for match in FOREACH_ARRAY_RE.finditer(sql):
        for item in match.group(1).split(","):
            name = item.strip().strip("'\"")
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                tables.add(name)
    return tables


def main(migrations_dir: Path) -> int:
    sql_files = sorted(migrations_dir.glob("*.sql"))
    if not sql_files:
        print(f"RLS gate: no .sql files found under {migrations_dir}", file=sys.stderr)
        return 1

    created_tables: set[str] = set()
    rls_enabled: set[str] = set()
    policies_on: set[str] = set()

    for f in sql_files:
        text = strip_sql_comments(f.read_text())
        for m in CREATE_TABLE_RE.finditer(text):
            created_tables.add(m.group(1))
        for m in ENABLE_RLS_RE.finditer(text):
            rls_enabled.add(m.group(1))
        for m in CREATE_POLICY_RE.finditer(text):
            policies_on.add(m.group(1))
        # DO block FOREACH expansion: assume the loop body applies to every
        # table named in the ARRAY (009's pattern). Pessimistic in both
        # directions — we add to BOTH rls_enabled AND policies_on only if the
        # file contains both patterns, so a mismatched block doesn't cheat.
        if "ENABLE ROW LEVEL SECURITY" in text.upper():
            rls_enabled.update(tables_in_foreach(text))
        if "CREATE POLICY" in text.upper():
            policies_on.update(tables_in_foreach(text))

    missing_rls = sorted(created_tables - rls_enabled)
    missing_policy = sorted(created_tables - policies_on)

    print(f"RLS gate: {len(created_tables)} tables found in {migrations_dir}")
    for t in sorted(created_tables):
        rls_mark = "RLS" if t in rls_enabled else "---"
        pol_mark = "POL" if t in policies_on else "---"
        print(f"  [{rls_mark}][{pol_mark}] {t}")

    if missing_rls or missing_policy:
        print()
        if missing_rls:
            print(f"FAIL: tables without ENABLE ROW LEVEL SECURITY: {missing_rls}")
        if missing_policy:
            print(f"FAIL: tables without any CREATE POLICY: {missing_policy}")
        print(
            "\nFix: every new table must ship with its RLS + at least one policy "
            "(referencing auth.uid() for user-owned data, or TO service_role "
            "for backend-only tables). Grandfathered 001-008 tables are covered "
            "by 009_rls_catchup.sql."
        )
        return 1

    print("\nOK: all tables have RLS enabled and at least one policy.")
    return 0


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "apps/worker/migrations"
    sys.exit(main(Path(arg)))
