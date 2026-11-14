#!/usr/bin/env python3
"""Assert the fast-path classifier admits only paths that cannot hide a gate.

WHY THIS EXISTS
---------------
``.github/workflows/auto-label-fast-path.yml`` decides, from two regexes, which
PRs skip adversarial review entirely: a ``fast-path`` label alone arms
``auto-merge.yml`` (see its lines 146-152). Those two regexes are therefore
load-bearing security config that lives in a shell string inside a YAML file,
where nothing type-checks them and nothing tests them.

It has already failed once, in the most expensive way available. PR #216 added
ONE new file, ``apps/web/test/chord-key-cross-artifact.test.mjs`` -- a
cross-artifact gate. It matched the allowlist term ``apps/[^/]+/tests?/``, was
auto-labelled, and merged to ``v3/main`` as ``22f92ee`` in 3m17s with no human
and no adversarial review. The gate it added was too narrow, and it turned a
STRICTLY BETTER tree (PR #214, which refactored the key into a single source of
truth its own reviewer had asked for) red.

The lesson is not "that gate was bad". It is that **a weakened or wrong gate is
invisible by construction** -- the suite goes green either way -- so a test file
is the single highest-leverage place to put a mistake, and the one category that
must never skip review.

This checker exists so that the allowlist cannot quietly re-admit that category.
The workflow comment explaining the policy can rot; this cannot.

WHAT IT CHECKS
--------------
1. **Both regexes are still extractable and still compile.** Zero matches means
   the gate has been renamed or restructured and this checker has silently
   stopped checking, which must FAIL rather than pass.

2. **Behaviour on concrete paths, not string comparison.** Each path in the
   table below is classified by the real deny/allow logic, deny evaluated first
   exactly as the workflow does, and compared against what it MUST be.

3. **Non-vacuity, asserted before any pass is trusted.** The table contains
   both admitted and refused paths, so a regex that admitted everything and a
   regex that admitted nothing both fail. A check that cannot fail has not
   checked.

4. **``rollback-safe`` is not applied by the workflow.** It is a judgement by a
   human or a reviewing agent. A bot applying it is a free half of the STANDARD
   merge gate, because ``auto-merge.yml:213`` relies on rollback-safe NOT being
   dropped on push.

EXIT CODES -- the house convention (standing orders 15.6):
  0  ok
  1  drift (a path is classified wrongly, or rollback-safe came back)
  2  attempted and failed (a file was unreadable or unparseable)
  3  not attempted
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

OK, DRIFT, ATTEMPTED_AND_FAILED, NOT_ATTEMPTED = 0, 1, 2, 3

REPO = Path(__file__).resolve().parent.parent
WF = REPO / ".github" / "workflows" / "auto-label-fast-path.yml"

# (path, must_be_admitted, why this case is in the table)
CASES: list[tuple[str, bool, str]] = [
    # ---- REFUSED: gates. The whole reason this file exists. ----------------
    ("apps/web/test/chord-key-cross-artifact.test.mjs", False,
     "PR #216's ACTUAL file. It fast-pathed, merged unreviewed as 22f92ee, and "
     "broke #214. If this line ever flips to admitted, that happens again."),
    ("apps/web/test/play-mixer.test.mjs", False, "web test"),
    ("apps/web/test/helpers/dom.mjs", False, "web test helper -- a helper can hide a gate too"),
    ("apps/worker/tests/test_cleanup.py", False, "worker test: the retention blast-radius gate lives here"),
    ("apps/worker/tests/test_link_duration_cap.py", False, "worker test: the spend gate"),
    ("apps/web/src/components/__tests__/Thing.test.tsx", False, "colocated web test"),
    # ---- REFUSED: safety machinery, by the pre-existing deny list ----------
    ("scripts/safe_merge.sh", False, "deny list: merge machinery"),
    ("scripts/check_codeowners_drift.py", False, "deny list: a checker"),
    ("scripts/check_fast_path_allowlist.py", False, "deny list: THIS checker must not fast-path itself"),
    (".githooks/pre-commit", False, "deny list: hooks enforce R-1"),
    # ---- REFUSED: scripts/ is a CLASS of safety machinery, not two filenames --
    # The deny list names scripts/safe_merge.sh and scripts/check_*.py; every other
    # script used to ride the allowlist's `scripts/` term straight through. These
    # rows pin the CLASS, so a script nobody has written yet is refused too.
    ("scripts/smoke_staging.mjs", False,
     "the staging smoke gate: a gate in scripts/ is still a gate"),
    ("scripts/smoke_staging_sweep.mjs", False,
     "deletes leaked staging users: destructive, not inert"),
    ("scripts/some_new_helper.sh", False,
     "scripts/ is not inert; admit by name, not by directory"),
    ("scripts/lib/anything.py", False, "a nested script is still a script"),
    # ---- REFUSED: money and context ---------------------------------------
    ("apps/web/src/lib/billing/credits.ts", False, "deny list: billing"),
    ("apps/web/src/app/api/entitlements/route.ts", False, "deny list: entitlements"),
    ("apps/worker/src/worker/billing/ledger.py", False, "deny list: billing"),
    ("apps/worker/migrations/034_v3_commercial_x.sql", False, "deny list: commercial migration"),
    ("AGENTS.md", False, "deny list, and it matches the allowlist's own .md term -- easy to miss"),
    ("docs/AGENTS.md", False, "AGENTS.md at depth: CODEOWNERS owns it at any depth"),
    # ---- REFUSED: ordinary product code (withdrawn in session 12) ----------
    ("apps/web/src/components/play/Mixer.tsx", False, "product code: L2.3 widening was withdrawn"),
    ("apps/worker/src/worker/pipeline.py", False, "product code: L2.3 widening was withdrawn"),
    ("apps/worker/migrations/035_whatever.sql", False, "a migration is never fast-path"),
    (".github/workflows/auto-merge.yml", False, "merge governance is never fast-path"),
    # ---- ADMITTED: genuinely inert. Proves the regex is not refuse-all. ----
    ("docs/architecture.md", True, "documentation"),
    ("README.md", True, "root markdown"),
    ("claude/session-13-prompt.md", True, "markdown anywhere"),
    ("packages/types/src/generated.ts", True, "generated types, reproduced by codegen and drift-checked in CI"),
    ("fixtures/chords/sample.json", True, "shared test DATA, not executable"),
]


def fail(code: int, msg: str) -> int:
    print(f"check_fast_path_allowlist: {msg}", file=sys.stderr)
    return code


def extract(text: str, name: str) -> str | None:
    """Pull a single-quoted regex assigned to `name` out of the workflow."""
    hits = re.findall(rf"^\s*{name}='([^']*)'", text, re.MULTILINE)
    if len(hits) != 1:
        print(
            f"check_fast_path_allowlist: expected exactly ONE `{name}=` assignment in "
            f"{WF.relative_to(REPO)}, found {len(hits)}. If the classifier was restructured, "
            f"update this checker ON PURPOSE -- do not delete it.",
            file=sys.stderr,
        )
        return None
    return hits[0]


def main() -> int:
    if not WF.is_file():
        return fail(NOT_ATTEMPTED, f"{WF.relative_to(REPO)} is missing")
    try:
        text = WF.read_text(encoding="utf-8")
    except OSError as exc:
        return fail(ATTEMPTED_AND_FAILED, f"could not read the workflow: {exc}")

    deny_s = extract(text, "deny_re")
    allow_s = extract(text, "allow_re")
    if deny_s is None or allow_s is None:
        return ATTEMPTED_AND_FAILED
    try:
        deny = re.compile(deny_s)
        allow = re.compile(allow_s)
    except re.error as exc:
        return fail(ATTEMPTED_AND_FAILED, f"a classifier regex does not compile: {exc}")

    def admitted(path: str) -> bool:
        """The workflow's own order: DENY is evaluated first and always wins."""
        if deny.search(path):
            return False
        return bool(allow.search(path))

    problems: list[str] = []
    for path, want, why in CASES:
        got = admitted(path)
        if got != want:
            verb = "ADMITTED but must be REFUSED" if got else "REFUSED but must be ADMITTED"
            problems.append(f"{verb}: {path!r}\n        why this case exists: {why}")

    # Non-vacuity. A table that is all-one-way proves nothing about the regex.
    n_adm = sum(1 for _, w, _ in CASES if w)
    n_ref = len(CASES) - n_adm
    if n_adm == 0 or n_ref == 0:
        return fail(
            ATTEMPTED_AND_FAILED,
            "the case table is one-sided, so a pass would be meaningless. "
            "It must contain BOTH admitted and refused paths.",
        )

    # rollback-safe must not be applied by this workflow at all.
    if "--add-label rollback-safe" in text or "--add-label fast-path --add-label rollback-safe" in text:
        problems.append(
            "ADD-LABEL rollback-safe came back into auto-label-fast-path.yml.\n"
            "        rollback-safe means a REVIEWER judged the change revertable. A bot applying\n"
            "        it is a permanent free half of the STANDARD merge gate, because\n"
            "        auto-merge.yml:213 relies on rollback-safe NOT being dropped on push."
        )

    if problems:
        print("check_fast_path_allowlist: DRIFT", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        print(
            "\n  The fast path skips adversarial review entirely (auto-merge.yml:146-152).\n"
            "  If one of these is a deliberate policy change, change this table in the same\n"
            "  PR and say why in the body -- do not delete the case.",
            file=sys.stderr,
        )
        return DRIFT

    print(
        f"check_fast_path_allowlist: ok -- {len(CASES)} paths classified "
        f"({n_ref} refused, {n_adm} admitted), both regexes compile, "
        f"rollback-safe is not applied by the workflow."
    )
    return OK


if __name__ == "__main__":
    sys.exit(main())
