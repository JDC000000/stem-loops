#!/usr/bin/env python3
"""Execute the real auto-merge gate against fixtures (AGENTIC-L5-PLAN §11 R5).

WHY THIS EXISTS
---------------
R5 retired the ``fast-path`` arm of ``.github/workflows/auto-merge.yml`` and
made ``CLAUDE.md``, ``.claude/**``, ``**/SKILL.md`` and ``scripts/**``
CODEOWNERS paths. Its exit criterion is behavioural: *a PR touching
``.claude/agents/x.md`` gets ``needs-jon-approval`` and is never auto-merged.*
A comment saying so can rot. This gate does not read the comments; it runs
the code.

It replaces ``scripts/check_fast_path_allowlist.py``, which tested the
allowlist of a workflow that no longer exists. Keeping that checker green
against a deleted file would have been a dead check claiming coverage.

WHAT IT RUNS, NOT JUST READS
----------------------------
1. **The labeller.** The ``run:`` script of ``auto-label-codeowners.yml`` is
   extracted verbatim and executed under bash with a stub ``gh`` on PATH. The
   stub serves a fixture file list and logs every ``gh pr edit``. The test
   asserts the real script asked for ``--add-label needs-jon-approval``.

2. **The merge gate, both halves.**
   * the ``enable-auto-merge`` job ``if:`` expression, translated mechanically
     to Python and evaluated on every label combination, and
   * the ``resolve`` step's ``run:`` script, executed under bash with the stub
     ``gh`` serving the PR, its files, check-runs, commit date and label
     events, in BOTH event modes (``pull_request_target`` and the post-CI
     ``workflow_run`` re-attempt).
   A PR "can merge" only if the job ``if`` is true AND ``resolve`` emits
   ``proceed=true``. For each owned path, every subset of
   {rollback-safe, adversarial-reviewed, fast-path} is tried, fresh, with CI
   green: none may merge.

3. **Non-vacuity, asserted before any refusal is trusted.** A docs-only PR
   with ``rollback-safe`` + fresh ``adversarial-reviewed`` and green CI MUST
   be allowed through, in both modes. A gate that refuses everything would
   pass every negative case above; this positive control makes it fail.

4. **Static pins.** No workflow may apply a ``fast-path`` label;
   ``auto-label-fast-path.yml`` must not exist; every third-party ``uses:`` in
   the merge-path workflows must be a full 40-hex commit SHA.

EXIT CODES -- the house convention (scripts/_gate_exit.py):
  0  ok
  1  drift (a case was classified wrongly, a pin is missing, fast-path is back)
  2  attempted and failed (a file was unparseable, a script crashed)
  3  not attempted (bash or jq is not installed, so nothing could be run)
"""

from __future__ import annotations

import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _gate_exit import EXIT_BROKEN, EXIT_DRIFT, EXIT_NOT_CHECKED, EXIT_OK

REPO = Path(__file__).resolve().parent.parent
WF = REPO / ".github" / "workflows"
MERGER = WF / "auto-merge.yml"
LABELLER = WF / "auto-label-codeowners.yml"
RETIRED = WF / "auto-label-fast-path.yml"
MERGE_PATH_WORKFLOWS = (MERGER, LABELLER)

FAKE_REPO = "example/stem-loops"
PR_NUM = "4242"
HEAD_SHA = "a" * 40
COMMIT_AT = "2026-11-22T10:00:00Z"
FRESH_AT = "2026-11-22T10:05:00Z"
STALE_AT = "2026-11-22T09:00:00Z"

# Paths R5 says must go to Jon. The first two are the plan's named cases.
OWNED_CASES = (
    ".claude/agents/x.md",
    "CLAUDE.md",
    "apps/web/CLAUDE.md",
    ".claude/settings.json",
    "skills/foo/SKILL.md",
    "CLAUDE.local.md",
    "apps/worker/.mcp.json",
    "scripts/safe_merge.sh",
)
# RENAMES of an owned file to an unowned path (review R1, should-fix 3). The
# owned path disappears from the tree, so the PR touches it. REST reports the
# old name only in `previous_filename`. Each is (new name, previous name).
RENAME_CASES = (
    ("docs/settings.json", ".claude/settings.json"),
    ("docs/notes.md", "CLAUDE.md"),
    ("tools/safe_merge.sh", "scripts/safe_merge.sh"),
)
# A path nobody owns: used for the positive control and for fast-path cases.
UNOWNED = "docs/guide.md"
# An unowned->unowned rename: positive control for the rename handling.
UNOWNED_RENAME = ("docs/guide-v2.md", "docs/guide.md")

# Static scans over EVERY workflow file (review R1, should-fix 1).
# The only non-comment line allowed to mention fast-path anywhere: the
# hygiene removal list in drop-stale-review, which removes and grants nothing.
FAST_PATH_ALLOWED_LINES = ("const toRemove = ['adversarial-reviewed', 'fast-path'];",)
# Anything that merges a PR or arms GitHub auto-merge.
MERGE_CALL_RE = re.compile(
    r"pulls/[^\s\"']*/merge\b|gh\s+pr\s+merge\b|mergePullRequest|"
    r"enablePullRequestAutoMerge|pulls\.merge\s*\(|--auto\b"
)
# The one sanctioned merge site, as (file name, job id).
MERGE_SITE = ("auto-merge.yml", "enable-auto-merge")
APPROVAL_LABELS = ("rollback-safe", "adversarial-reviewed", "fast-path")

# The stub `gh`. It serves fixtures from $GATE_FIX and logs `pr edit` calls.
GH_STUB = r"""#!__PY__
import json, os, re, subprocess, sys
fix = os.environ["GATE_FIX"]
args = sys.argv[1:]
with open(os.path.join(fix, "calls.log"), "a") as f:
    f.write(json.dumps(args) + "\n")
if args[:2] == ["pr", "diff"]:
    sys.stdout.write(open(os.path.join(fix, "files.txt")).read())
    sys.exit(0)
if args[:2] == ["pr", "edit"]:
    sys.exit(0)
if not args or args[0] != "api":
    sys.stderr.write("gh stub: unsupported call %r\n" % (args,)); sys.exit(97)
jq = None; endpoint = None; i = 1
while i < len(args):
    a = args[i]
    if a == "--jq": jq = args[i + 1]; i += 2; continue
    if a in ("-X",): i += 2; continue
    if a.startswith("-"): i += 1; continue
    if endpoint is None: endpoint = a
    i += 1
path = endpoint.split("?")[0]
routes = [
    (r"repos/[^/]+/[^/]+/pulls/\d+/files$", "files.json"),
    (r"repos/[^/]+/[^/]+/commits/[0-9a-f]+/pulls$", "commit_pulls.json"),
    (r"repos/[^/]+/[^/]+/pulls/\d+$", "pr.json"),
    (r"repos/[^/]+/[^/]+/commits/[0-9a-f]+/check-runs$", "checks.json"),
    (r"repos/[^/]+/[^/]+/commits/[0-9a-f]+$", "commit.json"),
    (r"repos/[^/]+/[^/]+/issues/\d+/events$", "events.json"),
]
for rx, name in routes:
    if re.fullmatch(rx, path):
        fp = os.path.join(fix, name)
        if jq is None:
            sys.stdout.write(open(fp).read()); sys.exit(0)
        sys.exit(subprocess.call(["jq", "-r", jq, fp]))
sys.stderr.write("gh stub: no route for %r\n" % (endpoint,)); sys.exit(98)
"""


class Broken(Exception):
    """The gate could not be run (exit 2), as opposed to a wrong answer."""


def run_block(text: str, anchor: str, path: Path) -> str:
    """The `run: |` block of the step whose line contains `anchor`, dedented.

    Exactly one anchor must exist: zero means the step was renamed and this
    gate would silently stop testing it, which must fail, not pass.
    """
    lines = text.splitlines()
    hits = [i for i, ln in enumerate(lines) if ln.strip() == anchor]
    if len(hits) != 1:
        raise Broken(
            f"expected exactly one {anchor!r} in {path.name}, found {len(hits)}"
        )
    i = hits[0]
    while i < len(lines) and not re.match(r"^\s+run: \|\s*$", lines[i]):
        i += 1
        if i - hits[0] > 40:
            raise Broken(f"no `run: |` within 40 lines of {anchor!r} in {path.name}")
    run_indent = len(lines[i]) - len(lines[i].lstrip())
    body = []
    for ln in lines[i + 1 :]:
        if ln.strip() and (len(ln) - len(ln.lstrip())) <= run_indent:
            break
        body.append(ln)
    ind = min(len(ln) - len(ln.lstrip()) for ln in body if ln.strip())
    script = "\n".join(ln[ind:] for ln in body) + "\n"
    if "${{" in script:
        raise Broken(
            f"the {anchor!r} script in {path.name} interpolates ${{{{ }}}}; "
            "this gate can only run env-driven scripts"
        )
    return script


def job_if(text: str) -> str:
    """The `if: >` expression of the enable-auto-merge job."""
    m = re.search(r"\n  enable-auto-merge:\n(.*?)\n    steps:\n", text, re.DOTALL)
    if not m:
        raise Broken("enable-auto-merge job not found in auto-merge.yml")
    m2 = re.search(r"\n    if: >\n(.*)", m.group(1), re.DOTALL)
    if not m2:
        raise Broken("enable-auto-merge has no `if: >` block")
    return "\n".join(
        ln for ln in m2.group(1).splitlines() if not ln.strip().startswith("#")
    )


def eval_if(expr: str, ctx: dict, labels: set[str]) -> bool:
    """Evaluate the GitHub expression mechanically. Anything unrecognised is an
    error, not a guess: a `github.*` name absent from ctx raises KeyError."""
    py = re.sub(
        r"contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'([^']+)'\)",
        r"('\1' in labels)",
        expr,
    )
    py = re.sub(r"\bgithub\.[A-Za-z_.]+", lambda m: f"ctx[{m.group(0)!r}]", py)
    py = py.replace("&&", " and ").replace("||", " or ")
    py = re.sub(r"!(?!=)", " not ", py)
    if re.search(r"contains\(|\$\{\{", py):
        raise Broken(f"untranslatable expression left in job if: {py!r}")
    return bool(
        eval("(" + py + ")", {"__builtins__": {}}, {"ctx": ctx, "labels": labels})
    )


def ctx_for(mode: str, labels: set[str]) -> dict:
    if mode == "pull_request_target":
        return {
            "github.event_name": "pull_request_target",
            "github.event.action": "labeled",
            "github.event.workflow_run.event": None,
            "github.event.workflow_run.conclusion": None,
            "github.event.workflow_run.head_repository.full_name": None,
            "github.repository": FAKE_REPO,
        }
    return {
        "github.event_name": "workflow_run",
        "github.event.action": "completed",
        "github.event.workflow_run.event": "pull_request",
        "github.event.workflow_run.conclusion": "success",
        "github.event.workflow_run.head_repository.full_name": FAKE_REPO,
        "github.repository": FAKE_REPO,
    }


def write_fixture(d: Path, files: list, labels: dict[str, str]) -> None:
    """files: each a path, or a (new, previous) tuple for a rename.
    labels: name -> labeled-at timestamp."""
    rows = []
    for f in files:
        if isinstance(f, tuple):
            rows.append(
                {"filename": f[0], "status": "renamed", "previous_filename": f[1]}
            )
        else:
            rows.append({"filename": f, "status": "modified"})
    # files.txt mimics `gh pr diff --name-only`, which lists NEW names only.
    (d / "files.txt").write_text("".join(r["filename"] + "\n" for r in rows))
    (d / "files.json").write_text(json.dumps(rows))
    pr = {
        "number": int(PR_NUM),
        "state": "open",
        "head": {"sha": HEAD_SHA, "ref": "feature/x", "repo": {"full_name": FAKE_REPO}},
        "labels": [{"name": n} for n in labels],
    }
    (d / "pr.json").write_text(json.dumps(pr))
    (d / "commit_pulls.json").write_text(json.dumps([pr]))
    (d / "checks.json").write_text(
        json.dumps(
            {
                "total_count": 2,
                "check_runs": [
                    {"name": "Lint", "status": "completed", "conclusion": "success"},
                    {"name": "Tests", "status": "completed", "conclusion": "success"},
                ],
            }
        )
    )
    (d / "commit.json").write_text(
        json.dumps({"commit": {"committer": {"date": COMMIT_AT}}})
    )
    (d / "events.json").write_text(
        json.dumps(
            [
                {"event": "labeled", "label": {"name": n}, "created_at": at}
                for n, at in labels.items()
            ]
        )
    )
    (d / "calls.log").write_text("")


def run_script(script: str, d: Path, env_extra: dict) -> tuple[int, str]:
    bindir = d / "bin"
    bindir.mkdir(exist_ok=True)
    stub = bindir / "gh"
    stub.write_text(GH_STUB.replace("__PY__", sys.executable))
    stub.chmod(0o755)
    out = d / "github_output"
    out.write_text("")
    env = {
        "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}",
        "GATE_FIX": str(d),
        "GITHUB_OUTPUT": str(out),
        "GH_TOKEN": "stub",
        "REPO": FAKE_REPO,
        "HOME": str(d),
        **env_extra,
    }
    sf = d / "script.sh"
    sf.write_text(script)
    p = subprocess.run(
        ["bash", "-e", str(sf)],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return (
        p.returncode,
        out.read_text() + "\n--stdout--\n" + p.stdout + "\n--stderr--\n" + p.stderr,
    )


def resolve_proceeds(
    script: str, mode: str, files: list[str], labels: dict[str, str]
) -> bool:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        write_fixture(d, files, labels)
        env = {
            "EVENT_NAME": mode,
            "EV_PR": PR_NUM,
            "EV_SHA": HEAD_SHA,
            "EV_REF": "feature/x",
            "RUN_SHA": HEAD_SHA,
        }
        rc, log = run_script(script, d, env)
        if rc != 0:
            raise Broken(f"resolve script exited {rc} in {mode} for {files}:\n{log}")
        vals = re.findall(
            r"^proceed=(\w+)$", (d / "github_output").read_text(), re.MULTILINE
        )
        if len(vals) != 1:
            raise Broken(
                f"resolve emitted {len(vals)} proceed= lines in {mode}:\n{log}"
            )
        return vals[0] == "true"


def labeller_adds_label(script: str, files: list[str]) -> bool:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        write_fixture(d, files, {})
        rc, log = run_script(script, d, {"PR_NUM": PR_NUM})
        if rc != 0:
            raise Broken(f"labeller script exited {rc} for {files}:\n{log}")
        calls = [
            json.loads(ln) for ln in (d / "calls.log").read_text().splitlines() if ln
        ]
        return any(c[:2] == ["pr", "edit"] and "needs-jon-approval" in c for c in calls)


def can_merge(
    expr: str, resolve: str, mode: str, files: list[str], labels: dict[str, str]
) -> bool:
    if not eval_if(expr, ctx_for(mode, set(labels)), set(labels)):
        return False
    return resolve_proceeds(resolve, mode, files, labels)


def main() -> int:
    for tool in ("bash", "jq"):
        if shutil.which(tool) is None:
            print(
                f"check_merge_gate: NOT CHECKED - `{tool}` is not installed",
                file=sys.stderr,
            )
            return EXIT_NOT_CHECKED
    try:
        mtext = MERGER.read_text(encoding="utf-8")
        ltext = LABELLER.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"check_merge_gate: could not read a workflow: {exc}", file=sys.stderr)
        return EXIT_BROKEN

    problems: list[str] = []
    try:
        expr = job_if(mtext)
        resolve = run_block(mtext, "id: resolve", MERGER)
        labeller = run_block(
            ltext, "- name: Check diff against CODEOWNERS paths", LABELLER
        )

        # 3 — positive control FIRST: a reviewed, unowned PR must get through.
        ok_labels = {"rollback-safe": FRESH_AT, "adversarial-reviewed": FRESH_AT}
        for mode in ("pull_request_target", "workflow_run"):
            if not can_merge(expr, resolve, mode, [UNOWNED], ok_labels):
                problems.append(
                    f"VACUOUS  positive control refused in {mode}: a docs PR with "
                    "rollback-safe + fresh adversarial-reviewed must be mergeable, "
                    "otherwise every refusal below proves nothing"
                )
        if labeller_adds_label(labeller, [UNOWNED]):
            problems.append(
                f"VACUOUS  labeller applied needs-jon-approval to {UNOWNED!r}"
            )
        # Unowned rename: positive control for the previous_filename handling.
        for mode in ("pull_request_target", "workflow_run"):
            if not can_merge(expr, resolve, mode, [UNOWNED_RENAME], ok_labels):
                problems.append(
                    f"VACUOUS  unowned rename {UNOWNED_RENAME} refused in {mode}"
                )
        if labeller_adds_label(labeller, [UNOWNED_RENAME]):
            problems.append(
                f"VACUOUS  labeller applied needs-jon-approval to {UNOWNED_RENAME}"
            )
        # The needs-jon-approval LABEL is a hard stop on its own (review R1,
        # should-fix 2): an UNOWNED diff, fully reviewed, CI green, but carrying
        # the label set by a human, must be refused. Checked against `resolve`
        # directly in workflow_run mode, because there the job `if` does not
        # look at labels; resolve's label check is the only thing that stops it.
        held = dict(ok_labels, **{"needs-jon-approval": FRESH_AT})
        if resolve_proceeds(resolve, "workflow_run", [UNOWNED], held):
            problems.append(
                "HOLD     workflow_run: resolve proceeded on a PR labelled "
                "needs-jon-approval (the label hard-stop is gone)"
            )
        if can_merge(expr, resolve, "pull_request_target", [UNOWNED], held):
            problems.append(
                "HOLD     pull_request_target: a PR labelled needs-jon-approval could merge"
            )
        # A stale review must not count (post-CI path).
        stale = {"rollback-safe": FRESH_AT, "adversarial-reviewed": STALE_AT}
        if can_merge(expr, resolve, "workflow_run", [UNOWNED], stale):
            problems.append(
                "STALE    adversarial-reviewed older than the head commit was accepted"
            )

        # fast-path retired: no subset that lacks the standard pair may merge.
        for r in range(1, len(APPROVAL_LABELS) + 1):
            for combo in itertools.combinations(APPROVAL_LABELS, r):
                if {"rollback-safe", "adversarial-reviewed"} <= set(combo):
                    continue
                labels = {n: FRESH_AT for n in combo}
                for mode in ("pull_request_target", "workflow_run"):
                    if can_merge(expr, resolve, mode, [UNOWNED], labels):
                        problems.append(
                            f"FASTPATH {mode}: unowned PR with only {sorted(combo)} "
                            "could merge without rollback-safe + adversarial-reviewed"
                        )

        # 1 + 2 — owned paths (edited, or renamed away): labelled, and never
        # mergeable under any labels.
        for owned in OWNED_CASES + RENAME_CASES:
            files = [UNOWNED, owned]
            if not labeller_adds_label(labeller, files):
                problems.append(
                    f"LABEL    auto-label-codeowners.yml did not apply "
                    f"needs-jon-approval to a PR touching {owned!r}"
                )
            for r in range(len(APPROVAL_LABELS) + 1):
                for combo in itertools.combinations(APPROVAL_LABELS, r):
                    labels = {n: FRESH_AT for n in combo}
                    for mode in ("pull_request_target", "workflow_run"):
                        if can_merge(expr, resolve, mode, files, labels):
                            problems.append(
                                f"MERGE    {mode}: PR touching {owned!r} with "
                                f"{sorted(combo)} would auto-merge"
                            )
    except Broken as exc:
        print(f"check_merge_gate: ATTEMPTED AND FAILED - {exc}", file=sys.stderr)
        return EXIT_BROKEN
    except (KeyError, SyntaxError, NameError) as exc:
        print(
            f"check_merge_gate: ATTEMPTED AND FAILED - job if not evaluable: {exc!r}",
            file=sys.stderr,
        )
        return EXIT_BROKEN

    # 5 — every workflow file, not just the modelled job (review R1, should-fix 1).
    merge_sites = []
    for wf in sorted(WF.glob("*.y*ml")):
        job = None
        in_jobs = False
        for n, ln in enumerate(wf.read_text(encoding="utf-8").splitlines(), 1):
            if re.match(r"^jobs:\s*$", ln):
                in_jobs = True
                continue
            if re.match(r"^\S", ln):
                in_jobs = False
                job = None
            elif in_jobs and (m := re.match(r"^  ([A-Za-z0-9_-]+):\s*$", ln)):
                job = m.group(1)
            s = ln.strip()
            if not s or s.startswith(("#", "//")):
                continue
            if "fast-path" in s and s not in FAST_PATH_ALLOWED_LINES:
                problems.append(
                    f"FASTPATH {wf.name}:{n} mentions fast-path outside the one "
                    f"allowed hygiene line: {s[:100]!r}"
                )
            if MERGE_CALL_RE.search(s) and "--disable-auto" not in s:
                merge_sites.append((wf.name, job, n, s))
    sanctioned = [m for m in merge_sites if (m[0], m[1]) == MERGE_SITE]
    for name, job, n, s in merge_sites:
        if (name, job) != MERGE_SITE:
            problems.append(
                f"MERGESITE {name}:{n} (job {job}) merges or arms auto-merge outside "
                f"{MERGE_SITE[0]}/{MERGE_SITE[1]}: {s[:100]!r}"
            )
    if len(sanctioned) != 1:
        problems.append(
            f"MERGESITE expected exactly ONE merge call in {MERGE_SITE[0]}/"
            f"{MERGE_SITE[1]}, found {len(sanctioned)}"
        )

    # 4 — static pins.
    if RETIRED.exists():
        problems.append(
            f"FASTPATH {RETIRED.relative_to(REPO)} exists again (retired in §11 R5)"
        )
    for wf in sorted(WF.glob("*.y*ml")):
        t = wf.read_text(encoding="utf-8")
        if re.search(r"add-label\s+['\"]?fast-path|addLabels\([^)]*fast-path", t):
            problems.append(f"FASTPATH {wf.name} applies a fast-path label")
    for wf in MERGE_PATH_WORKFLOWS:
        for n, ln in enumerate(wf.read_text(encoding="utf-8").splitlines(), 1):
            m = re.match(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)", ln)
            if not m or m.group(1).startswith("./"):
                continue
            if not re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", m.group(1)):
                problems.append(
                    f"PIN      {wf.name}:{n} `{m.group(1)}` is not pinned to a "
                    "40-hex commit SHA"
                )
            elif "#" not in ln:
                problems.append(
                    f"PIN      {wf.name}:{n} pinned SHA has no `# tag` comment"
                )

    if problems:
        print("check_merge_gate: DRIFT", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return EXIT_DRIFT

    print(
        f"check_merge_gate: ok - positive control merges in both modes; stale review "
        f"refused; label hard-stop holds; fast-path-only refused; no fast-path in any "
        f"workflow; one merge site; {len(OWNED_CASES)} owned paths + "
        f"{len(RENAME_CASES)} renames-away labelled "
        f"needs-jon-approval and unmergeable under all {2 ** len(APPROVAL_LABELS)} label "
        f"subsets x 2 event modes; merge-path actions SHA-pinned."
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
