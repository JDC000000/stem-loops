#!/usr/bin/env python3
"""
SL-B26 #1 CI gate: assert every table in apps/worker/migrations/*.sql ships
with RLS + a policy, and that user-data tables carry a per-user policy
(auth.uid() reference) unless explicitly declared backend-only.

Scope: migrations/*.sql only (the runner's glob). Down migrations are not
checked because the runner never applies them.

Rules enforced:
  1. Every CREATE TABLE X must have a matching ENABLE ROW LEVEL SECURITY X.
  2. Every CREATE TABLE X must have at least one CREATE POLICY ... ON X.
  3. Every CREATE TABLE X must EITHER (a) be named in a
     `-- rls-backend-only: <table>, ...` marker comment in some migration
     file, OR (b) have at least one policy whose text references
     `auth.uid()` or `request.jwt.claim` (so user-data tables cannot be
     silently guarded only by a service_role-bypass policy).
  4. (rule c, TSD 2.1a) Every table created in migration >= STRICT_FROM_MIGRATION
     must have a `stemloops_app_all` policy, `FOR ALL TO stemloops_app` (the
     worker write path). Applies to backend-only tables too: they are written
     ONLY through this role.
  5. (rule d, TSD 2.1a) Every table created in migration >= STRICT_FROM_MIGRATION
     must have a `cowork_ro_read` policy (direct CREATE POLICY, an A3-style DO
     block with FOREACH ARRAY[...], or an A3 `FROM pg_tables` loop).

Rules 4+5 are scoped by migration number (not a feature flag) so V2-era tables
that predate the stemloops_app / cowork_ro catch-up (migration 011) do not fail
the gate. Once 011 is on the base branch, set STRICT_FROM_MIGRATION to 1.

Backend-only marker format (comment line, any migration file):
  -- rls-backend-only: jobs, job_events, loops

Usage: python scripts/check_rls.py [MIGRATIONS_DIR]

Exit 0 if every rule passes, 1 otherwise. Prints a per-table verdict.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# -- Regex atoms --------------------------------------------------------------
# The migrations tree is small and we author it, so permissive regexes are
# fine. False positives on string literals are the author's problem to make
# the regex happy; a real parser is overkill.

# CREATE TABLE with optional UNLOGGED/TEMP/TEMPORARY, IF NOT EXISTS matched
# as a unit (no backtrack onto "IF"), optional schema prefix, and quoted OR
# bare identifier. Fixes the review-1 finding where `CREATE TABLE IF NOT
# EXISTS "quoted"` captured literal `IF` as the table name.
CREATE_TABLE_RE = re.compile(
    r"CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+"
    r"(?:IF\s+NOT\s+EXISTS\s+)?"
    r"(?:(?:[A-Za-z_][A-Za-z0-9_]*)\.)?"
    r'(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))',
    re.IGNORECASE,
)

# Defensive blacklist: if a regex ever captures one of these as a table name,
# reject it rather than record a phantom table.
SQL_KEYWORD_BLACKLIST = {
    "IF", "NOT", "EXISTS", "UNLOGGED", "TEMP", "TEMPORARY", "ONLY",
}

ENABLE_RLS_RE = re.compile(
    r"ALTER\s+TABLE\s+(?:ONLY\s+)?"
    r"(?:(?:[A-Za-z_][A-Za-z0-9_]*)\.)?"
    r'(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))'
    r"\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY",
    re.IGNORECASE,
)

# CREATE POLICY <name> ON <table> <body up to ; or end-of-text>
# Body is captured so we can scan it for auth.uid() references (rule 3).
CREATE_POLICY_RE = re.compile(
    r'CREATE\s+POLICY\s+(?P<pname>"[^"]+"|\S+)\s+ON\s+'
    r"(?:(?:[A-Za-z_][A-Za-z0-9_]*)\.)?"
    r'(?:"(?P<tq>[^"]+)"|(?P<tb>[A-Za-z_][A-Za-z0-9_]*))'
    r"(?P<body>[\s\S]*?)(?:;|\Z)",
    re.IGNORECASE,
)

# Rules (c)/(d). Strict scope: only tables first created in a migration whose
# numeric prefix is >= this value are checked. 013 = first migration authored
# against the stemloops_app / cowork_ro template; 011 (catch-up for V2 tables)
# is not on the base branch yet. Lower to 1 once 011 lands.
STRICT_FROM_MIGRATION = 13

_MIGRATION_NUM_RE = re.compile(r"^(\d+)_")

# `FOR ALL` + `TO stemloops_app` (exact role: \b stops at `stemloops_app_all`).
_FOR_ALL_RE = re.compile(r"\bFOR\s+ALL\b", re.IGNORECASE)
_TO_APP_ROLE_RE = re.compile(r"\bTO\b[^;]*?\bstemloops_app\b", re.IGNORECASE)

# Inside a DO block (policy often built via format('...')): one statement,
# bounded by `;`, that creates stemloops_app_all FOR ALL TO stemloops_app.
DO_APP_ALL_RE = re.compile(
    r'CREATE\s+POLICY\s+"?stemloops_app_all"?\s+ON\b[^;]*?\bFOR\s+ALL\b'
    r"[^;]*?\bTO\b[^;]*?\bstemloops_app\b",
    re.IGNORECASE,
)
DO_COWORK_RE = re.compile(
    r'CREATE\s+POLICY\s+"?cowork_ro_read"?\s+ON\b', re.IGNORECASE
)
# A3 catch-all loop: `FOR t IN SELECT tablename FROM pg_tables ...`.
PG_TABLES_LOOP_RE = re.compile(r"\bFROM\s+pg_tables\b", re.IGNORECASE)

# DO $$ ... $$ blocks, non-greedy. Parsing each block independently (rather
# than lumping all blocks in a file together) closes the review-1 finding
# where two mismatched FOREACH arrays could cheat the gate.
DO_BLOCK_RE = re.compile(r"DO\s+\$\$([\s\S]*?)\$\$", re.IGNORECASE)

FOREACH_ARRAY_RE = re.compile(
    r"FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)\]",
    re.IGNORECASE,
)

# Comment marker that exempts a table from the rule-3 per-user requirement.
#
# Line-anchored (re.MULTILINE + `^\s*--`) so the marker is recognised ONLY on
# a comment line — not inside string literals, dollar-quoted bodies, COMMENT ON
# payloads, or block comments. Each of those could otherwise silently exempt a
# user-data table (review-2 Lens B finding).
#
# Capture is `[^\n]+` (not `[A-Za-z0-9_,\s]+`) so `\s` can't match `\n` and
# swallow the next line into the marker — see review-2 Lens B+C finding; the
# docstring's own happy-path example used to silently drop the marker.
BACKEND_ONLY_MARKER_RE = re.compile(
    r"^\s*--\s*rls-backend-only\s*:\s*([^\n]+)",
    re.IGNORECASE | re.MULTILINE,
)

# What counts as "per-user" scoping in a policy body.
AUTHUID_REF_RE = re.compile(
    r"auth\.uid\s*\(\s*\)|request\.jwt",
    re.IGNORECASE,
)


# -- Helpers ------------------------------------------------------------------

def strip_sql_comments(text: str) -> str:
    """Remove `--` line comments and `/* ... */` block comments.

    The naive regex version at this file's HEAD was fooled by comment markers
    inside string literals: `SELECT '/*'; CREATE TABLE evil(); SELECT '*/';`
    swallowed the CREATE TABLE as if it was a block comment. That gave an
    attacker a one-line gate bypass (round-1 Lens finding).

    Fix: reuse the single-pass lexer in `_mask_non_comment_lexical` by
    returning a version that blanks comments and leaves strings/dollar-quoted
    bodies/quoted identifiers alone. Length-preserving so downstream regex
    positions are stable.
    """
    return _mask_lexical(text, blank_comments=True, blank_strings=False)


# Dollar-quoted body opener/closer: `$$` or `$tag$`. Non-tag chars are not
# allowed inside the tag (Postgres identifier rules).
_DOLLAR_TAG_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def _mask_lexical(text: str, *, blank_comments: bool, blank_strings: bool) -> str:
    """Single left-to-right lexer pass that first-token-wins over `--` comments,
    `/* */` block comments, string literals ('..', E'..', U&'..'), quoted
    identifiers ("..") and dollar-quoted bodies ($$..$$ or $tag$..$tag$).

    The two callers pick which regions to blank:

      strip_sql_comments(text)
        → blank_comments=True, blank_strings=False — removes comments without
          mis-interpreting comment markers hidden inside string literals (the
          `SELECT '/*'` → "0 tables found" bypass from round-1 Lens finding).

      _mask_non_comment_lexical(text)
        → blank_comments=False, blank_strings=True — masks strings and
          dollar-bodies so `-- rls-backend-only:` sequences hidden inside
          them cannot match BACKEND_ONLY_MARKER_RE, while leaving `--`
          line comments intact (legitimate markers live on them).

    Length is preserved (newlines kept, everything else replaced with spaces)
    so regex line/column accounting isn't affected for callers. Dollar-quote
    tags themselves are left in place; only the body is blanked.
    """
    n = len(text)
    out = list(text)

    def blank(a: int, b: int) -> None:
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    def is_ident_char(ch: str) -> bool:
        return ch.isalnum() or ch in "_$"

    i = 0
    while i < n:
        c = text[i]
        if c == "-" and text.startswith("--", i):
            nl = text.find("\n", i)
            j = n if nl < 0 else nl
            if blank_comments:
                blank(i, j)
            i = j
        elif c == "/" and text.startswith("/*", i):
            close = text.find("*/", i + 2)
            j = n if close < 0 else close + 2
            # block comments are also "comment" territory — blank them when
            # either comment-blanking or string-blanking is on (the latter
            # preserves the existing `_mask_non_comment_lexical` behaviour).
            if blank_comments or blank_strings:
                blank(i, j)
            i = j
        elif c == "'":
            # E'...' strings also honour backslash escapes.
            esc = i > 0 and text[i - 1] in "eE" and (
                i == 1 or not is_ident_char(text[i - 2])
            )
            j = i + 1
            while j < n:
                if esc and text[j] == "\\":
                    j += 2
                elif text[j] == "'":
                    if text.startswith("''", j):
                        j += 2
                    else:
                        j += 1
                        break
                else:
                    j += 1
            j = min(j, n)
            if blank_strings:
                blank(i, j)  # unterminated -> masks to EOF (fail closed)
            i = j
        elif c == '"':
            j = i + 1
            while j < n:
                if text.startswith('""', j):
                    j += 2
                elif text[j] == '"':
                    j += 1
                    break
                else:
                    j += 1
            j = min(j, n)
            if blank_strings:
                blank(i, j)
            i = j
        elif c == "$" and not (i > 0 and is_ident_char(text[i - 1])):
            m = _DOLLAR_TAG_RE.match(text, i)
            if not m:
                i += 1
                continue
            tag = m.group(0)
            close = text.find(tag, m.end())
            if close < 0:
                if blank_strings:
                    blank(m.end(), n)  # unterminated: mask everything after opener
                i = n
            else:
                if blank_strings:
                    blank(m.end(), close)
                i = close + len(tag)
        else:
            i += 1

    return "".join(out)


def _mask_non_comment_lexical(text: str) -> str:
    """Mask strings, quoted identifiers, dollar-bodies and block comments to
    whitespace while leaving `-- ...` line comments intact (legitimate markers
    live on those)."""
    return _mask_lexical(text, blank_comments=False, blank_strings=True)


def _tables_in_foreach(do_block: str) -> set[str]:
    """Expand table names from ONE DO block's FOREACH ARRAY[...]."""
    tables: set[str] = set()
    for match in FOREACH_ARRAY_RE.finditer(do_block):
        for item in match.group(1).split(","):
            name = item.strip().strip("'\"")
            if (
                re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
                and name.upper() not in SQL_KEYWORD_BLACKLIST
            ):
                tables.add(name)
    return tables


def _table_name_from_match(m: re.Match) -> str | None:
    """Return the first non-None capture of a quoted|bare identifier."""
    if "tq" in m.re.groupindex:
        name = m.group("tq") or m.group("tb")
    else:
        name = m.group(1) or m.group(2)
    if not name:
        return None
    if name.upper() in SQL_KEYWORD_BLACKLIST:
        return None
    return name


# -- Main ---------------------------------------------------------------------

def _migration_num(path: Path) -> int:
    """Numeric prefix of NNN_name.sql; unnumbered files count as strict."""
    m = _MIGRATION_NUM_RE.match(path.name)
    return int(m.group(1)) if m else 10**9


def _is_app_all_policy(name: str, body: str) -> bool:
    return (
        name.strip('"') == "stemloops_app_all"
        and bool(_FOR_ALL_RE.search(body))
        and bool(_TO_APP_ROLE_RE.search(body))
    )


def main(migrations_dir: Path,
         strict_from: int = STRICT_FROM_MIGRATION) -> int:
    sql_files = sorted(migrations_dir.glob("*.sql"))
    if not sql_files:
        print(f"RLS gate: no .sql files found under {migrations_dir}",
              file=sys.stderr)
        return 1

    created_tables: set[str] = set()
    rls_enabled: set[str] = set()
    policies_on: set[str] = set()
    policies_with_authuid: set[str] = set()
    backend_only: set[str] = set()
    # Rules (c)/(d) bookkeeping.
    created_pos: dict[str, int] = {}   # table -> index of first creating file
    created_num: dict[str, int] = {}   # table -> migration number of that file
    app_all: set[str] = set()          # stemloops_app_all FOR ALL TO stemloops_app
    cowork_read: set[str] = set()      # cowork_ro_read exists
    # Catch-all (`FROM pg_tables`) loops cover every table created in that file
    # or any earlier one: remember the file index of each such loop.
    app_all_wild: list[int] = []
    cowork_wild: list[int] = []

    for pos, f in enumerate(sql_files):
        raw = f.read_text()
        num = _migration_num(f)

        # Markers live in LINE comments — but a `-- rls-backend-only: X`
        # sequence can also appear inside a string literal, dollar-quoted body
        # or /* */ block comment, where it means NOTHING. Pre-mask those so
        # the regex only matches real comment lines. The masker keeps genuine
        # `--` comment lines intact (and no longer lets an apostrophe inside
        # one open a phantom string).
        marker_text = _mask_non_comment_lexical(raw)
        for m in BACKEND_ONLY_MARKER_RE.finditer(marker_text):
            for name in m.group(1).split(","):
                name = name.strip()
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    backend_only.add(name)

        text = strip_sql_comments(raw)

        # 1. CREATE TABLE
        for m in CREATE_TABLE_RE.finditer(text):
            name = _table_name_from_match(m)
            if name:
                created_tables.add(name)
                if name not in created_pos:
                    created_pos[name] = pos
                    created_num[name] = num

        # 2. Plain ALTER TABLE ... ENABLE RLS
        for m in ENABLE_RLS_RE.finditer(text):
            name = _table_name_from_match(m)
            if name:
                rls_enabled.add(name)

        # 3. Plain CREATE POLICY ... ON <table> <body>
        for m in CREATE_POLICY_RE.finditer(text):
            name = _table_name_from_match(m)
            if not name:
                continue
            body = m.group("body") or ""
            policies_on.add(name)
            if AUTHUID_REF_RE.search(body):
                policies_with_authuid.add(name)
            pname = m.group("pname").strip('"')
            if _is_app_all_policy(pname, body):
                app_all.add(name)
            if pname == "cowork_ro_read":
                cowork_read.add(name)

        # 4. DO blocks: parse each one INDEPENDENTLY so mismatched arrays
        #    in two blocks can't cheat the gate (fixes review-1 finding).
        for do_match in DO_BLOCK_RE.finditer(text):
            block = do_match.group(1)
            block_tables = _tables_in_foreach(block)
            has_app_all = bool(DO_APP_ALL_RE.search(block))
            has_cowork = bool(DO_COWORK_RE.search(block))
            if PG_TABLES_LOOP_RE.search(block):
                if has_app_all:
                    app_all_wild.append(pos)
                if has_cowork:
                    cowork_wild.append(pos)
            if not block_tables:
                continue
            if "ENABLE ROW LEVEL SECURITY" in block.upper():
                rls_enabled.update(block_tables)
            if re.search(r"CREATE\s+POLICY", block, re.IGNORECASE):
                policies_on.update(block_tables)
                # A DO block that builds a policy via format(...) may also
                # embed an auth.uid() reference in the format string.
                if AUTHUID_REF_RE.search(block):
                    policies_with_authuid.update(block_tables)
            if has_app_all:
                app_all.update(block_tables)
            if has_cowork:
                cowork_read.update(block_tables)

    def covered(t: str, direct: set[str], wild: list[int]) -> bool:
        return t in direct or any(w >= created_pos[t] for w in wild)

    strict_tables = {
        t for t in created_tables if created_num[t] >= strict_from
    }
    app_ok = {t for t in strict_tables if covered(t, app_all, app_all_wild)}
    cowork_ok = {t for t in strict_tables
                 if covered(t, cowork_read, cowork_wild)}

    missing_rls = sorted(created_tables - rls_enabled)
    missing_policy = sorted(created_tables - policies_on)
    missing_user_scope = sorted(
        (created_tables - backend_only) - policies_with_authuid
    )
    missing_app_all = sorted(strict_tables - app_ok)
    missing_cowork = sorted(strict_tables - cowork_ok)

    print(f"RLS gate: {len(created_tables)} tables found in {migrations_dir} "
          f"(rules c+d enforced for migrations >= {strict_from:03d}: "
          f"{len(strict_tables)} tables)")
    for t in sorted(created_tables):
        rls_mark = "RLS" if t in rls_enabled else "---"
        pol_mark = "POL" if t in policies_on else "---"
        scope_mark = (
            "BACKEND"
            if t in backend_only
            else ("USER" if t in policies_with_authuid else "----")
        )
        if t in strict_tables:
            app_mark = "APP" if t in app_ok else "---"
            ro_mark = "RO" if t in cowork_ok else "--"
        else:
            app_mark, ro_mark = "n/a", "n/a"
        print(f"  [{rls_mark}][{pol_mark}][{scope_mark}][{app_mark}][{ro_mark}] {t}")

    if backend_only:
        print(f"\nDeclared backend-only (service-role bypass only): "
              f"{sorted(backend_only)}")

    # Orphan marker check: a `-- rls-backend-only: userz` with a typo silently
    # exempts nothing today, but it rots — someone adds a real `users` table
    # tomorrow and the typo now looks like the intended exemption. Warn (don't
    # fail) so typos surface without blocking merges on a cosmetic. (review-2 NIT)
    orphan_markers = sorted(backend_only - created_tables)
    if orphan_markers:
        print(f"\nWARN: `-- rls-backend-only:` names tables that don't exist "
              f"in any migration: {orphan_markers}. Typo, or a stale marker "
              f"left behind after a table was renamed/dropped?")

    failed = False
    if missing_rls:
        print(f"\nFAIL (rule 1): tables without ENABLE ROW LEVEL SECURITY: "
              f"{missing_rls}")
        failed = True
    if missing_policy:
        print(f"\nFAIL (rule 2): tables without any CREATE POLICY: "
              f"{missing_policy}")
        failed = True
    if missing_user_scope:
        print(f"\nFAIL (rule 3): tables without a per-user policy and not "
              f"declared backend-only: {missing_user_scope}")
        print("  Either add an auth.uid()-referencing policy (for user-owned "
              "data), or add a `-- rls-backend-only: <table>, ...` marker "
              "comment in the migration file (for operational/service-only "
              "tables).")
        failed = True
    if missing_app_all:
        print(f"\nFAIL (rule c): tables without a `stemloops_app_all` policy "
              f"(FOR ALL TO stemloops_app): {missing_app_all}")
        print("  Add: CREATE POLICY stemloops_app_all ON <table> FOR ALL TO "
              "stemloops_app USING (true) WITH CHECK (true);")
        failed = True
    if missing_cowork:
        print(f"\nFAIL (rule d): tables without a `cowork_ro_read` policy: "
              f"{missing_cowork}")
        print("  Add the table to the A3 DO block (FOREACH ARRAY[...]) that "
              "creates cowork_ro_read, or a direct CREATE POLICY cowork_ro_read.")
        failed = True

    if failed:
        print("\nFix: every new table ships with RLS + >=1 policy. "
              "User-owned data must reference auth.uid(); operational tables "
              "must be declared backend-only via marker comment. Tables from "
              f"migration {strict_from:03d} on also need stemloops_app_all "
              "and cowork_ro_read policies.")
        return 1

    print("\nOK: all tables have RLS enabled, >=1 policy, per-user "
          "scoping or backend-only declaration, and (migration "
          f">={strict_from:03d}) stemloops_app_all + cowork_ro_read.")
    return 0


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "apps/worker/migrations"
    sys.exit(main(Path(arg)))
