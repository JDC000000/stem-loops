#!/usr/bin/env python3
"""Fleet Playbook Move 4 CI gate: validate TSD §N.M references in PR bodies.

Reads a PR body from stdin, extracts every `TSD §N[.N[.N...]][letter]?`
reference, then walks `04-tsd-and-workplan/**/*.md` looking for a Markdown
heading whose text contains that section number. Matching is deliberately
flexible — any of these count as a match for `1.2a`:

    ## 1.2a Processor Separation
    ### §1.2a
    #### 1.2a — Processor Separation

If any reference doesn't resolve, the script prints one line per failure and
exits 1. Zero references → exit 0 (not every PR touches V3 scope).

Standalone, stdlib-only, UTF-8 throughout. The `§` (U+00A7) character is
treated as an optional prefix: both `TSD §1.2a` and `TSD 1.2a` resolve.

CI (`.github/workflows/ci.yml`) pipes `gh pr view ... --json body -q .body`
into this script's stdin.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Match `TSD §N.M...` (optional `§`, optional trailing letter suffix) and
# capture just the section number (digits/dots + optional letter). Examples:
#   TSD §1.2a   → "1.2a"
#   TSD 1.2a    → "1.2a"
#   TSD §1.2.3  → "1.2.3"
#   TSD §1.2.3.4a → "1.2.3.4a"
# A trailing dot (`§1.2.`) does NOT get captured — the `\d` after the last
# dot is required to terminate a sub-section.
_REF_RE = re.compile(r"TSD\s*§?\s*(\d+(?:\.\d+)*[a-zA-Z]?)")

# A heading line is a Markdown ATX heading (`#` through `######`). The
# section number may appear anywhere in the heading text (optionally preceded
# by `§`), with any following character being a non-digit boundary so that
# `1.2` doesn't also match a heading for `1.20`.
_TSD_DIR_DEFAULT = Path(__file__).resolve().parent.parent / "04-tsd-and-workplan"


def extract_refs(body: str) -> list[str]:
    """Return every TSD section number mentioned in `body`, in first-seen order
    (duplicates removed, case preserved from the first occurrence)."""

    seen: dict[str, None] = {}
    for m in _REF_RE.finditer(body):
        ref = m.group(1)
        if ref not in seen:
            seen[ref] = None
    return list(seen)


def _heading_matcher(section: str) -> re.Pattern[str]:
    """Build a regex that matches a Markdown heading line containing `section`.

    The number may be preceded by `§` and must be followed by a non-digit /
    non-alnum boundary so `1.2` doesn't accidentally resolve inside `1.20`.
    """

    escaped = re.escape(section)
    # Boundary after section: end-of-line, whitespace, or a punctuation char.
    # Reject [0-9A-Za-z] so `1.2a` doesn't match `1.2ab` and `1.2` doesn't
    # match `1.20`.
    return re.compile(
        r"^\s*#{1,6}\s+(?:§\s*)?" + escaped + r"(?![0-9A-Za-z])",
        re.MULTILINE,
    )


def find_heading(section: str, tsd_dir: Path) -> bool:
    """Return True iff some `04-tsd-and-workplan/**/*.md` file has a heading
    whose text contains `section` (per the matching rules above)."""

    matcher = _heading_matcher(section)
    for md in sorted(tsd_dir.rglob("*.md")):
        try:
            text = md.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if matcher.search(text):
            return True
    return False


def check(body: str, tsd_dir: Path) -> list[str]:
    """Return a list of failure messages (empty = success)."""

    failures: list[str] = []
    for ref in extract_refs(body):
        if not find_heading(ref, tsd_dir):
            failures.append(
                f"PR references TSD §{ref} but no heading found in 04-tsd-and-workplan/"
            )
    return failures


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns the intended process exit code."""

    # Allow `--tsd-dir <path>` for tests; default to the repo-relative dir.
    args = argv if argv is not None else sys.argv[1:]
    tsd_dir = _TSD_DIR_DEFAULT
    if args and args[0] == "--tsd-dir" and len(args) >= 2:
        tsd_dir = Path(args[1])

    # Read PR body from stdin as UTF-8. An empty body is legal (zero refs).
    body = sys.stdin.read()

    if not tsd_dir.is_dir():
        # A missing TSD dir with zero refs is still fine; with refs it's a
        # configuration bug worth surfacing.
        if extract_refs(body):
            print(
                f"TSD directory not found: {tsd_dir}",
                file=sys.stderr,
            )
            return 1
        return 0

    failures = check(body, tsd_dir)
    for msg in failures:
        print(msg)
    return 1 if failures else 0


if __name__ == "__main__":
    # Force UTF-8 on stdin/stdout regardless of the parent locale — CI
    # runners sometimes default to ASCII and `§` would otherwise blow up.
    if hasattr(sys.stdin, "reconfigure"):
        try:
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass
    sys.exit(main())
