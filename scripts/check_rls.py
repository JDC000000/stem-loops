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
    r"CREATE\s+POLICY\s+\S+\s+ON\s+"
    r"(?:(?:[A-Za-z_][A-Za-z0-9_]*)\.)?"
    r'(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))'
    r"([\s\S]*?)(?:;|\Z)",
    re.IGNORECASE,
)

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
    """Remove -- line comments and /* ... */ block comments."""
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"--[^\n]*", "", text)
    return text


# Dollar-quoted body opener/closer: `$$` or `$tag$`. Non-tag chars are not
# allowed inside the tag (Postgres identifier rules).
_DOLLAR_TAG_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
# Single-quoted SQL string literal. `''` is an escaped single quote inside.
_SQL_STRING_RE = re.compile(r"'(?:[^']|'')*'")
# /* ... */ block comment, non-greedy.
_SQL_BLOCK_COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/")


def _mask_non_comment_lexical(text: str) -> str:
    """Replace SQL string literals, dollar-quoted bodies, and /* */ block
    comments with equal-length whitespace so a `-- rls-backend-only:` sequence
    buried inside them cannot match BACKEND_ONLY_MARKER_RE. LINE comments
    (`-- ...`) are left intact because legitimate markers live on them.

    Length is preserved (newlines kept, everything else replaced with spaces)
    so regex line/column accounting isn't affected for callers.

    This closes the residual round-3 Lens B vectors: multi-line string with
    embedded marker, dollar-quoted DO body with embedded marker, and
    multi-line block comment with embedded marker.
    """

    def _space_pad(s: str) -> str:
        # Preserve newlines (so re.MULTILINE anchors still line up) and replace
        # every non-newline with a space of equal length.
        return "".join("\n" if ch == "\n" else " " for ch in s)

    # 1. Dollar-quoted bodies FIRST. They can contain anything — including
    #    single quotes — so masking them first prevents the string-literal
    #    pass below from getting confused by a stray `'` inside a body.
    out_parts: list[str] = []
    i = 0
    while i < len(text):
        m = _DOLLAR_TAG_RE.search(text, i)
        if not m:
            out_parts.append(text[i:])
            break
        open_tag = m.group(0)  # literal "$$" or "$foo$"
        out_parts.append(text[i : m.start()])
        # Look for matching close tag (same literal).
        close_idx = text.find(open_tag, m.end())
        if close_idx < 0:
            # Unterminated dollar-quote — mask everything after the opener.
            out_parts.append(open_tag + _space_pad(text[m.end() :]))
            i = len(text)
            break
        body = text[m.end() : close_idx]
        out_parts.append(open_tag + _space_pad(body) + open_tag)
        i = close_idx + len(open_tag)
    text = "".join(out_parts)

    # 2. /* ... */ block comments.
    text = _SQL_BLOCK_COMMENT_RE.sub(lambda m: _space_pad(m.group(0)), text)

    # 3. Single-quoted SQL strings. Done LAST so an apostrophe inside a
    #    (now-masked) dollar-quote or block comment can't mis-pair with a
    #    real string's opener.
    text = _SQL_STRING_RE.sub(lambda m: _space_pad(m.group(0)), text)

    return text


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
    name = m.group(1) or m.group(2)
    if not name:
        return None
    if name.upper() in SQL_KEYWORD_BLACKLIST:
        return None
    return name


# -- Main ---------------------------------------------------------------------

def main(migrations_dir: Path) -> int:
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

    for f in sql_files:
        raw = f.read_text()

        # Markers live in LINE comments — but a `-- rls-backend-only: X`
        # sequence can also appear inside a string literal, dollar-quoted body
        # or /* */ block comment, where it means NOTHING. Pre-mask those so
        # the regex only matches real comment lines. (round-3 Lens B fix)
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
            body = m.group(3) or ""
            policies_on.add(name)
            if AUTHUID_REF_RE.search(body):
                policies_with_authuid.add(name)

        # 4. DO blocks: parse each one INDEPENDENTLY so mismatched arrays
        #    in two blocks can't cheat the gate (fixes review-1 finding).
        for do_match in DO_BLOCK_RE.finditer(text):
            block = do_match.group(1)
            block_tables = _tables_in_foreach(block)
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

    missing_rls = sorted(created_tables - rls_enabled)
    missing_policy = sorted(created_tables - policies_on)
    missing_user_scope = sorted(
        (created_tables - backend_only) - policies_with_authuid
    )

    print(f"RLS gate: {len(created_tables)} tables found in {migrations_dir}")
    for t in sorted(created_tables):
        rls_mark = "RLS" if t in rls_enabled else "---"
        pol_mark = "POL" if t in policies_on else "---"
        scope_mark = (
            "BACKEND"
            if t in backend_only
            else ("USER" if t in policies_with_authuid else "----")
        )
        print(f"  [{rls_mark}][{pol_mark}][{scope_mark}] {t}")

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

    if failed:
        print("\nFix: every new table ships with RLS + >=1 policy. "
              "User-owned data must reference auth.uid(); operational tables "
              "must be declared backend-only via marker comment.")
        return 1

    print("\nOK: all tables have RLS enabled, >=1 policy, and per-user "
          "scoping or backend-only declaration.")
    return 0


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "apps/worker/migrations"
    sys.exit(main(Path(arg)))
