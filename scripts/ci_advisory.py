#!/usr/bin/env python3
"""Advisory CI helpers for the three `advisory-*` jobs in .github/workflows/ci.yml (Jon L7, LEDGER-24A row 11).

ADVISORY ONLY. Every subcommand writes Markdown for the job summary and exits 0, whatever it finds. It exits 2 only when it is
called wrongly (a usage error), so a broken workflow edit shows up, but nothing a PR contains can turn these jobs red:
`scripts/session-merge.sh` and the deploy gate treat any red check-run as "CI not green", and an advisory job must never block.

    classify  --files F0 --gate OR4 [--title-json J]
        F0   NUL-separated changed paths (`git diff --name-only -z BASE...HEAD`)
        OR4  scripts/or4-merge.sh taken from the BASE branch (`git show origin/<base>:scripts/or4-merge.sh`), so a PR cannot
             edit the regex that classifies it. MONEY_RE / PROTECTED_RE / money_meta come from it (OR4_LIB=1), never a copy.
        J    {"title": "..."} (from $GITHUB_EVENT_PATH, never interpolated into a shell line)
    shared    --mine F --others J [--pr N] [--open-unreadable] [--unreadable N,N]
        F    newline-separated changed paths of this PR; J {"<pr>": ["path", ...], ...} for the other open PRs.
        An empty F or --open-unreadable reports "could not check", never "no overlap"; --unreadable lists PRs not compared.
    mutants   --files F0 --gate OR4 --worker apps/worker [--max N] [--ids-out PATH]
        Selects the worker-suite entries of apps/worker/tests/mutation/manifest.py (MUTANTS + SURVIVORS) whose file is a changed
        MONEY path, at most N (default 12), writes their ids comma-separated to PATH, and reports changed money paths that have
        no manifest entry (a coverage gap, not a failure). Running them is the workflow's job (run_mutants.py --ids).
        NOTE: unlike the regexes, the manifest and the tests it runs come from the PR head (they are what is being tested), so a PR
        can change what this job reports about it. Read-only token, no secrets: it can mislead the report, not write anything.
    An empty changed-file list (classify, mutants) is reported as "could not read", never as "standard" or "nothing to mutate".

Tests: python3 -m unittest scripts/test_ci_advisory.py (offline; stdlib only).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

MAX_LIST = 60  # paths printed per section; the rest is summarised as a count


def _bash_lib(gate: str, func: str, stdin: bytes) -> list[str]:
    """Run a function from the BASE gate in library mode; returns its newline-separated output. Raises on error."""
    p = subprocess.run(
        ["bash", "-c", '[ -f "$1" ] || exit 3; OR4_LIB=1 . "$1" || exit 3; declare -F "$2" >/dev/null || exit 3; "$2"', "_", gate, func],
        input=stdin, capture_output=True, timeout=60,
    )
    # money_paths / protected_match end in `grep … | tr`: grep exits 1 when nothing matches, which is not an error.
    # A missing or unsourceable gate, or a missing function, is exit 3: an error, never "no match" (fail closed).
    if p.returncode not in (0, 1):
        raise RuntimeError(f"{func} exited {p.returncode}: {p.stderr.decode(errors='replace')[:300]}")
    return [x for x in p.stdout.decode("utf-8", errors="surrogateescape").split("\n") if x]


def _money_title(gate: str, title_json: str | None) -> str:
    if not title_json:
        return "0"
    pr = Path(title_json).read_text(encoding="utf-8", errors="replace")
    p = subprocess.run(["bash", "-c", '[ -f "$1" ] || exit 3; OR4_LIB=1 . "$1" || exit 3; money_meta "$2"', "_", gate, pr],
                       capture_output=True, text=True, timeout=60)
    out = p.stdout.strip()
    if p.returncode != 0 or out not in ("0", "1"):
        return "1"  # the gate fails closed on a title it cannot parse; so does this report
    return out


def _fmt(paths: list[str]) -> list[str]:
    lines = [f"- `{x.replace('`', 'ˋ')}`" for x in paths[:MAX_LIST]]
    if len(paths) > MAX_LIST:
        lines.append(f"- … and {len(paths) - MAX_LIST} more")
    return lines


def classify(files0: bytes, gate: str, title_json: str | None) -> tuple[str, list[str]]:
    paths = [x for x in files0.decode("utf-8", errors="surrogateescape").split("\0") if x]
    if not paths:  # a PR always changes something: an empty list means the diff could not be read (R1 sonnet B2)
        return "unknown", ["### PR class (advisory): **unknown**", "",
                           "The changed-file list is empty, so it could not be read (`git diff` failed?). No class is reported: "
                           "classify by reading the files."]
    money = _bash_lib(gate, "money_paths", files0)
    prot = _bash_lib(gate, "protected_match", files0)
    mt = _money_title(gate, title_json)
    if money or mt == "1":
        cls = "money"
    elif prot:
        cls = "protected"
    else:
        cls = "standard"
    md = [f"### PR class (advisory): **{cls}**", "",
          f"{len(paths)} changed path(s) · {len(money)} money · {len(prot)} protected · `[billing]` title: {'yes' if mt == '1' else 'no'}",
          "", "Classified with MONEY_RE / PROTECTED_RE from the **base** branch's `scripts/or4-merge.sh`. A floor, not the "
          "classification: the orchestrator still reads the files (AGENTS.md M-SA condition 6)."]
    if cls == "money":
        md += ["", "Money class: two reviews on models other than the author's, each with line 1 `VERDICT: PASS <93-100> HEAD <sha>` "
               "and line 2 `SCORES: M-9 <n> M-11 <n>` (n ≥ 93); `JON_ROW` + `JON_PR`; 0 behind."]
    if money:
        md += ["", "**Money paths**", *_fmt(money)]
    if prot:
        md += ["", "**Protected paths**", *_fmt(prot)]
    return cls, md


def shared(mine: list[str], others: dict[str, list[str]], pr: str | None, open_unreadable: bool = False,
           unreadable: list[str] | None = None) -> list[str]:
    if not mine:  # R1 sonnet B1: an empty own list means it could not be read; never say "no overlap"
        return ["### Shared files (advisory): could not check", "",
                "This PR's changed-file list could not be read, so no comparison was made."]
    if open_unreadable:
        return ["### Shared files (advisory): could not check", "",
                "The list of open PRs could not be read, so no comparison was made."]
    unreadable = [u for u in (unreadable or []) if u.isdigit()]
    note = ([f"", f"Not checked (file list unreadable): " + ", ".join(f"#{u}" for u in unreadable)] if unreadable else [])
    mine_s = set(mine)
    rows = []
    for n in sorted(others, key=lambda k: int(k) if k.isdigit() else 0):
        if not n.isdigit() or n == pr:
            continue
        common = sorted(mine_s & set(others[n] or []))
        if common:
            rows.append((n, common))
    if not rows:
        return ["### Shared files (advisory)", "", f"No other open PR changes a file this PR changes ({len(others)} open PR(s) read)."] + note
    md = ["### Shared files (advisory)", "",
          f"{len(rows)} other open PR(s) change a file this PR changes. Expect a re-review after whichever merges first "
          "(update-branch changes the context). `session-merge.sh` prints the same warning before claiming.", ""]
    for n, common in rows:
        md.append(f"- **#{n}**: " + ", ".join(f"`{c.replace('`', 'ˋ')}`" for c in common[:20]) + (f" … +{len(common) - 20}" if len(common) > 20 else ""))
    return md + note


def _load_manifest(worker: str):
    path = Path(worker) / "tests" / "mutation" / "manifest.py"
    spec = importlib.util.spec_from_file_location("_mutation_manifest", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_mutation_manifest"] = mod  # dataclasses needs the module registered
    spec.loader.exec_module(mod)
    return mod


def select_mutants(files0: bytes, gate: str, worker: str, cap: int) -> tuple[list[str], list[str]]:
    if not [x for x in files0.split(b"\0") if x]:
        return [], ["### Diff-scoped mutants (advisory): could not check", "", "The changed-file list is empty, so it could not be read."]
    money = set(_bash_lib(gate, "money_paths", files0))
    man = _load_manifest(worker)
    wprefix = str(Path(worker).as_posix()).rstrip("/") + "/"
    entries = [(m, False) for m in man.MUTANTS] + [(s, True) for s in man.SURVIVORS]
    chosen, covered = [], set()
    for m, _surv in entries:
        if getattr(m, "suite", "worker") != "worker":
            continue
        p = wprefix + m.file
        if p in money:
            covered.add(p)
            chosen.append(m.id)
    web_entries = {"apps/web/" + m.file for m, _ in entries if getattr(m, "suite", "worker") == "web"}
    py_like = sorted(x for x in money if x.endswith((".py", ".sh", ".ts", ".tsx")))
    gaps = [x for x in py_like if x not in covered and x not in web_entries]
    web_hit = sorted(x for x in money if x in web_entries)
    cap = max(0, cap)  # #515: a negative cap selects nothing (a bare chosen[:-1] would drop only the last entry)
    ids = chosen[:cap]
    md = ["### Diff-scoped mutants (advisory)", "",
          f"{len(money)} changed money path(s) · {len(chosen)} worker manifest mutant(s) on them · running {len(ids)}"
          + (f" (capped at {cap})" if len(chosen) > cap else "")]
    if web_hit:
        md += ["", "Web-suite manifest mutants exist for these changed files but are **not run by this job** (worker suite only):", *_fmt(web_hit)]
    if gaps:
        md += ["", "**Changed money code with no manifest mutant** (coverage gap: add an entry to "
               "`apps/worker/tests/mutation/manifest.py` with a killer test):", *_fmt(gaps)]
    if not money:
        md += ["", "No money path changed: nothing to mutate."]
    return ids, md


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("classify"); c.add_argument("--files", required=True); c.add_argument("--gate", required=True); c.add_argument("--title-json")
    s = sub.add_parser("shared"); s.add_argument("--mine", required=True); s.add_argument("--others", required=True); s.add_argument("--pr")
    s.add_argument("--open-unreadable", action="store_true"); s.add_argument("--unreadable", default="", help="comma-separated PR numbers")
    m = sub.add_parser("mutants"); m.add_argument("--files", required=True); m.add_argument("--gate", required=True)
    m.add_argument("--worker", required=True); m.add_argument("--max", type=int, default=12); m.add_argument("--ids-out")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "classify":
            _cls, md = classify(Path(a.files).read_bytes(), a.gate, a.title_json)
        elif a.cmd == "shared":
            mine = [x for x in Path(a.mine).read_text(encoding="utf-8", errors="replace").splitlines() if x]
            others = json.loads(Path(a.others).read_text(encoding="utf-8"))
            if not isinstance(others, dict):
                raise ValueError("--others must be a JSON object")
            md = shared(mine, {str(k): list(v or []) for k, v in others.items()}, a.pr, a.open_unreadable,
                        [x for x in a.unreadable.split(",") if x])
        else:
            ids, md = select_mutants(Path(a.files).read_bytes(), a.gate, a.worker, a.max)
            if a.ids_out:
                Path(a.ids_out).write_text(",".join(ids), encoding="utf-8")
    except Exception as e:  # advisory: report, never fail the build
        md = [f"### {a.cmd} (advisory): could not run", "", f"`{type(e).__name__}: {str(e)[:300]}`"]
        if getattr(a, "ids_out", None):
            Path(a.ids_out).write_text("", encoding="utf-8")
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    sys.exit(main())
