#!/usr/bin/env python3
"""Deploy guard: fail closed unless main CI is green on the SHA being deployed.

Used by the first job of .github/workflows/deploy.yml (`ci-green-gate`), which
every deploy job `needs:`. The workflow fetches REST responses with the job's
GITHUB_TOKEN (actions: read, checks: read, contents: read) and passes the files:

  --runs         NDJSON, one check-run object per line, from
                 `gh api --paginate "repos/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100" --jq '.check_runs[]'`
  --compare      JSON `{"status": ..., "merge_base": ...}` from
                 `gh api "repos/{repo}/compare/{sha}...v3/main" --jq '{status: .status, merge_base: .merge_base_commit.sha}'`
  --deploy-runs  NDJSON `{"id", "check_suite_id", "path"}` per line: every
                 deploy.yml workflow run on the SHA
                 (`actions/workflows/deploy.yml/runs?head_sha={sha}`) plus this
                 run itself (`actions/runs/{GITHUB_RUN_ID}`).
  --run-id       GITHUB_RUN_ID of this gate's own run.

Exit 0 only when ALL hold:
  1. The SHA is on v3/main: the compare of SHA...v3/main is "identical" or
     "ahead" (v3/main contains SHA) AND its merge base is SHA itself.
  2. Floor: every context in REQUIRED_CONTEXTS (the 10 required status checks
     of ruleset 26478884) has at least one check-run on exactly this SHA from
     GitHub Actions (app id 15368), and EVERY such run is status=completed with
     conclusion=success (skipped does not count for these).
  3. Every OTHER GitHub Actions check-run on the SHA is status=completed with
     conclusion success or skipped. The only runs excluded are those of the
     deploy workflow itself, identified by check suite: a check-run whose
     check_suite.id is the check_suite_id of a deploy.yml workflow run. The
     deploy-runs list must contain this run (--run-id) and only deploy.yml
     paths, or the gate fails.

Anything unparsable fails.

Why: twice (S20 #376, 19 min early; S21 #420, 9 s after merge) the worker was
deployed by workflow_dispatch while v3/main CI on that SHA was still running.

Stdlib only; run as `python3 -I -u scripts/ci_green_gate.py ...`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# Ruleset 26478884 (v3/main) required_status_checks, all integration_id 15368.
# Keep in sync with `gh api repos/JDC000000/stem-loops/rulesets/26478884`.
REQUIRED_CONTEXTS: tuple[str, ...] = (
    "Lint",
    "Tests",
    "Types drift check",
    "Fixture pipeline (stub)",
    "RLS gate (SL-B26 #1)",
    "Web build",
    "Browser journeys (real Chromium)",
    "Worker tests (PG 17 = production parity)",
    "Migrations on a Supabase-like Postgres (PG 16)",
    "Migrations on a Supabase-like Postgres (PG 17)",
)

GITHUB_ACTIONS_APP_ID = 15368
DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml"

ON_BRANCH_STATUSES = frozenset({"identical", "ahead"})
OTHER_OK_CONCLUSIONS = frozenset({"success", "skipped"})

SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def check_on_branch(sha: str, compare: object) -> list[str]:
    """Problems with the SHA...v3/main compare result (empty list = on v3/main)."""
    if not isinstance(compare, dict):
        return ["compare response is not a JSON object"]
    problems = []
    status = compare.get("status")
    if status not in ON_BRANCH_STATUSES:
        problems.append(
            f"SHA {sha} is not on v3/main (compare status {status!r}; "
            f"need one of {sorted(ON_BRANCH_STATUSES)})"
        )
    merge_base = compare.get("merge_base")
    if merge_base != sha:
        problems.append(
            f"merge base of {sha} and v3/main is {merge_base!r}, not the SHA itself"
        )
    return problems


def deploy_suite_ids(deploy_runs: list, run_id: int) -> tuple[set[int], list[str]]:
    """Check-suite ids of deploy.yml runs; problems if malformed or self is absent."""
    suites: set[int] = set()
    problems = []
    seen_self = False
    for wr in deploy_runs:
        if not isinstance(wr, dict):
            problems.append("deploy-run entry is not a JSON object")
            continue
        if wr.get("path") != DEPLOY_WORKFLOW_PATH:
            problems.append(
                f"deploy-run {wr.get('id')!r} has path {wr.get('path')!r}, "
                f"not {DEPLOY_WORKFLOW_PATH}"
            )
            continue
        suite = wr.get("check_suite_id")
        if not isinstance(suite, int) or isinstance(suite, bool):
            problems.append(f"deploy-run {wr.get('id')!r} has no integer check_suite_id")
            continue
        suites.add(suite)
        if wr.get("id") == run_id:
            seen_self = True
    if not seen_self:
        problems.append(
            f"this gate's own run {run_id!r} is not among the deploy.yml runs; "
            "cannot identify the deploy workflow's check suites"
        )
    return suites, problems


def check_runs_green(sha: str, runs: list, exclude_suites: set[int]) -> list[str]:
    """Problems with the check-runs on SHA (empty list = main CI green)."""
    required: dict[str, list[dict]] = {}
    problems = []
    for run in runs:
        if not isinstance(run, dict):
            problems.append("check-run entry is not a JSON object")
            continue
        app = run.get("app")
        app_id = app.get("id") if isinstance(app, dict) else None
        if app_id != GITHUB_ACTIONS_APP_ID:
            # Not GitHub Actions: neither satisfies nor blocks (a same-named run
            # from another app cannot stand in for CI).
            continue
        suite = run.get("check_suite")
        suite_id = suite.get("id") if isinstance(suite, dict) else None
        if suite_id is not None and suite_id in exclude_suites:
            continue  # the deploy workflow's own jobs (this run or earlier dispatches)
        name = run.get("name")
        if run.get("head_sha") != sha:
            problems.append(
                f"{name!r}: check-run head_sha {run.get('head_sha')!r} != {sha}"
            )
            continue
        status = run.get("status")
        conclusion = run.get("conclusion")
        if name in REQUIRED_CONTEXTS:
            required.setdefault(name, []).append(run)
            if status != "completed" or conclusion != "success":
                problems.append(
                    f"{name!r} (required): status={status!r} conclusion={conclusion!r} "
                    f"(run id {run.get('id')!r}); need completed/success"
                )
        elif status != "completed" or conclusion not in OTHER_OK_CONCLUSIONS:
            problems.append(
                f"{name!r}: status={status!r} conclusion={conclusion!r} "
                f"(run id {run.get('id')!r}); need completed/success or skipped"
            )

    for ctx in REQUIRED_CONTEXTS:
        if not required.get(ctx):
            problems.append(f"{ctx!r} (required): no GitHub Actions check-run on {sha}")
    return problems


def load_ndjson(text: str) -> list:
    """Parse NDJSON (one value per line); a JSON array or {"check_runs": [...]} also works."""
    stripped = text.strip()
    if not stripped:
        return []
    if stripped[0] == "[":
        data = json.loads(stripped)
        if not isinstance(data, list):
            raise ValueError("JSON is not a list")
        return data
    if stripped[0] == "{" and "\n" not in stripped:
        one = json.loads(stripped)
        if isinstance(one, dict) and "check_runs" in one:
            if not isinstance(one["check_runs"], list):
                raise ValueError("check_runs is not a list")
            return one["check_runs"]
        return [one]
    return [json.loads(line) for line in stripped.splitlines() if line.strip()]


# Back-compat name used by earlier tests/tools.
load_runs = load_ndjson


def evaluate(
    sha: str, runs_text: str, compare_text: str, deploy_runs_text: str, run_id: object
) -> list[str]:
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        return [f"deployed SHA {sha!r} is not a 40-char lowercase hex SHA"]
    if not isinstance(run_id, int) or isinstance(run_id, bool) or run_id <= 0:
        return [f"run id {run_id!r} is not a positive integer"]
    problems = []
    try:
        compare = json.loads(compare_text)
    except ValueError as exc:
        problems.append(f"compare response is not JSON: {exc}")
    else:
        problems.extend(check_on_branch(sha, compare))
    exclude: set[int] = set()
    try:
        deploy_runs = load_ndjson(deploy_runs_text)
    except ValueError as exc:
        problems.append(f"deploy-runs response is not JSON: {exc}")
    else:
        exclude, p = deploy_suite_ids(deploy_runs, run_id)
        problems.extend(p)
    try:
        runs = load_ndjson(runs_text)
    except ValueError as exc:
        problems.append(f"check-runs response is not JSON: {exc}")
    else:
        problems.extend(check_runs_green(sha, runs, exclude))
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sha", required=True)
    ap.add_argument("--runs", required=True, help="check-runs NDJSON file")
    ap.add_argument("--compare", required=True, help="compare JSON file")
    ap.add_argument("--deploy-runs", required=True, help="deploy.yml workflow runs NDJSON file")
    ap.add_argument("--run-id", required=True, help="GITHUB_RUN_ID of this run")
    args = ap.parse_args(argv)
    try:
        run_id: object = int(args.run_id, 10)
    except ValueError:
        run_id = args.run_id
    try:
        with open(args.runs, encoding="utf-8") as fh:
            runs_text = fh.read()
        with open(args.compare, encoding="utf-8") as fh:
            compare_text = fh.read()
        with open(args.deploy_runs, encoding="utf-8") as fh:
            deploy_runs_text = fh.read()
    except OSError as exc:
        print(f"ci-green-gate: FAIL: cannot read input: {exc}")
        return 1
    problems = evaluate(args.sha, runs_text, compare_text, deploy_runs_text, run_id)
    if problems:
        print(f"ci-green-gate: FAIL: refusing to deploy {args.sha}")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(
        f"ci-green-gate: OK: {args.sha} is on v3/main, all {len(REQUIRED_CONTEXTS)} "
        "required checks concluded success, and no other GitHub Actions check-run "
        "on it is pending or red"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
