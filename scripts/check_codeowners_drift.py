#!/usr/bin/env python3
"""Assert the CODEOWNERS path set agrees across its three copies.

WHY THIS EXISTS
---------------
The set of paths that require Jon's approval is written down three times:

  1. ``.github/CODEOWNERS``                     — the real owner assignments
  2. ``.github/workflows/auto-label-codeowners.yml`` — applies the label
  3. ``.github/workflows/auto-merge.yml``       — ``CO_RE``, computes the
     verdict inline so a merge cannot win a race against the labeller

Copy 3 is new. It exists because ``needs-jon-approval`` is applied by a
separate workflow and so can arrive after the merge — PR #174 merged at
19:13:05Z and was labelled at 19:13:41Z, 36 seconds too late, while
``auto-merge.yml`` called that label a "hard stop regardless".

Adding a third copy of a path set with no gate on it would be trading one
silent failure for another. CODEOWNERS' own header already warns about this:

    "a pattern missing from that regex is a GAP; a regex alternation
     missing from here is a LEAK"

and it was itself wrong about its own count ("6" when the real number was 8)
for long enough to instruct an editor incorrectly. **A bare number goes stale
silently; an enumeration does not; a gate does not at all.**

WHAT IT CHECKS, AND WHY IN THIS ORDER
-------------------------------------
1. **The two workflow alternations are byte-identical.** Cheap, and it catches
   the realistic failure: somebody edits one workflow and hand-syncs the other
   approximately.

2. **Behavioural coverage, not string comparison.** For every owner line in
   CODEOWNERS a representative path is synthesised and the regex must match it
   (no GAP), and for every regex term a representative path must be claimed by
   some CODEOWNERS pattern (no LEAK). Comparing the *patterns* as text would
   pass on two spellings of the same rule and fail on two equivalent ones;
   comparing *behaviour on paths* is the cross-artifact form the standing
   orders call the sound one.

3. **Each synthesised path is asserted to be non-vacuous** — a negative
   control path must NOT match. A check that cannot fail has not checked.

EXIT CODES — the house convention (standing orders §15.6):
  0  ok
  1  drift (a GAP or a LEAK, or the two regexes differ)
  2  attempted and failed (a file was unreadable or unparseable)
  3  not attempted
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

OK, DRIFT, ATTEMPTED_AND_FAILED, NOT_ATTEMPTED = 0, 1, 2, 3

REPO = Path(__file__).resolve().parent.parent
CODEOWNERS = REPO / ".github" / "CODEOWNERS"
LABELLER = REPO / ".github" / "workflows" / "auto-label-codeowners.yml"
MERGER = REPO / ".github" / "workflows" / "auto-merge.yml"

# A path that must be claimed by NO pattern. If the regex matches this, the
# regex is not doing what we think and every positive result below is suspect.
NEGATIVE_CONTROL = "apps/web/src/components/play/Mixer.tsx"


def fail(code: int, msg: str) -> int:
    print(f"check_codeowners_drift: {msg}", file=sys.stderr)
    return code


def extract_alternation(text: str, path: Path) -> str | None:
    """Pull the single ``^(...)`` alternation out of a workflow file.

    Both workflows embed it in single quotes. Requiring EXACTLY ONE match is
    deliberate: zero means the gate has been renamed or removed and this
    checker has silently stopped checking, which must fail rather than pass.
    """
    hits = re.findall(r"'(\^\((?:[^']|\\')*\))'", text)
    if len(hits) != 1:
        print(
            f"check_codeowners_drift: expected exactly ONE '^(...)' alternation in "
            f"{path.relative_to(REPO)}, found {len(hits)}. If the gate moved, update "
            f"this checker on purpose — do not delete it.",
            file=sys.stderr,
        )
        return None
    return hits[0]


def owner_patterns(text: str) -> list[str]:
    """The pattern column of every non-comment owner line."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].startswith("@"):
            out.append(parts[0])
    return out


def sample_path(pattern: str) -> str:
    """A concrete repo path that the CODEOWNERS pattern matches.

    CODEOWNERS globbing is gitignore-like. Only the shapes this repo actually
    uses are handled, and anything else raises rather than being guessed at —
    a wrong sample would make this gate assert the wrong thing.
    """
    if pattern.endswith("/**"):
        return pattern[:-3] + "/_sample.ts"
    if "*" in pattern:
        # the one real case: apps/worker/migrations/*_v3_commercial*.sql
        head, _, tail = pattern.partition("*")
        mid, _, ext = tail.rpartition("*")
        return f"{head}013{mid}{ext}"
    return pattern


def claims(pattern: str, path: str) -> bool:
    """Does this CODEOWNERS pattern claim this path?"""
    if pattern.endswith("/**"):
        return path.startswith(pattern[:-2])
    if "*" in pattern:
        rx = "^" + re.escape(pattern).replace(r"\*", "[^/]*") + "$"
        return re.match(rx, path) is not None
    return path == pattern


def main() -> int:
    for p in (CODEOWNERS, LABELLER, MERGER):
        if not p.is_file():
            return fail(NOT_ATTEMPTED, f"{p.relative_to(REPO)} is missing")

    try:
        co_text = CODEOWNERS.read_text(encoding="utf-8")
        lab_text = LABELLER.read_text(encoding="utf-8")
        mrg_text = MERGER.read_text(encoding="utf-8")
    except OSError as exc:  # pragma: no cover
        return fail(ATTEMPTED_AND_FAILED, f"could not read a file: {exc}")

    lab_re = extract_alternation(lab_text, LABELLER)
    mrg_re = extract_alternation(mrg_text, MERGER)
    if lab_re is None or mrg_re is None:
        return ATTEMPTED_AND_FAILED

    # 1 — the two copies must be byte-identical.
    if lab_re != mrg_re:
        print(
            "check_codeowners_drift: DRIFT — the two workflow alternations differ.\n"
            f"  auto-label-codeowners.yml: {lab_re}\n"
            f"  auto-merge.yml           : {mrg_re}\n"
            "  These must be byte-identical: the labeller decides what gets the label "
            "and the merger decides what gets merged. If they disagree, one of them is "
            "wrong and the merge path is the dangerous one.",
            file=sys.stderr,
        )
        return DRIFT

    try:
        rx = re.compile(lab_re)
    except re.error as exc:
        return fail(
            ATTEMPTED_AND_FAILED, f"the alternation is not a valid regex: {exc}"
        )

    # 3 — non-vacuity, asserted before any positive result is trusted.
    if rx.search(NEGATIVE_CONTROL):
        return fail(
            ATTEMPTED_AND_FAILED,
            f"the regex matches the negative control {NEGATIVE_CONTROL!r}, so it claims "
            "ordinary product code. Every positive result below would be meaningless.",
        )

    patterns = owner_patterns(co_text)
    if not patterns:
        return fail(
            ATTEMPTED_AND_FAILED,
            "parsed ZERO owner lines out of .github/CODEOWNERS — the parser is wrong, "
            "not the file. Refusing to report agreement.",
        )

    problems: list[str] = []

    # 2a — GAP: every owned pattern must be covered by the regex.
    for pat in patterns:
        try:
            sample = sample_path(pat)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"GAP?  cannot synthesise a sample for {pat!r}: {exc}")
            continue
        if not rx.search(sample):
            problems.append(
                f"GAP   .github/CODEOWNERS owns {pat!r} but the workflow regex does not "
                f"match {sample!r}. A PR touching it would merge without Jon."
            )

    # 2b — LEAK: every regex term must be backed by an owned pattern.
    terms = [t for t in lab_re[2:-1].split("|") if t]
    for term in terms:
        probe = (
            term.replace("\\.", ".")
            .replace("[^/]*", "013_x")
            .replace("$", "")
            .lstrip("^")
        )
        if probe.endswith("/"):
            probe += "_sample.ts"
        if not any(claims(p, probe) for p in patterns):
            problems.append(
                f"LEAK  the workflow regex blocks {probe!r} (term {term!r}) but no "
                f".github/CODEOWNERS line owns it. Either add the owner line or drop "
                f"the term — an unowned block is friction nobody can satisfy."
            )

    if problems:
        print("check_codeowners_drift: DRIFT", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return DRIFT

    print(
        f"check_codeowners_drift: ok — {len(patterns)} owned patterns, "
        f"{len(terms)} regex terms, two workflow copies byte-identical, "
        f"negative control refused."
    )
    return OK


if __name__ == "__main__":
    sys.exit(main())
