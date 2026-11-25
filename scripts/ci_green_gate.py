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
  --ref          github.ref of this run (passed via `env:`, never `${{ }}` in run:).

The runner's own GITHUB_SHA, GITHUB_REF and GITHUB_RUN_ID environment variables
(GitHub documents that GITHUB_* defaults cannot be overwritten; deploy.yml also
sets no GITHUB_* key in any `env:`, pinned by a test) must be present and equal --sha, --ref
and --run-id, so the gate always judges the commit this run checks out and
deploys. Missing values fail.

Exit 0 only when ALL hold:
  0. The run's ref is refs/heads/v3/main (a dispatch from any other branch or
     tag fails here; the real control is the `production` Environment, which
     only v3/main may deploy to) and --sha/--ref/--run-id equal the runner's
     GITHUB_SHA/GITHUB_REF/GITHUB_RUN_ID.
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

Separate, NON-blocking mode (deploy.yml job `ruleset-drift`, which no deploy job
needs): `ci_green_gate.py --drift RULES_NDJSON` compares the required contexts of
ruleset 26478884 in `gh api --paginate repos/{repo}/rules/branches/v3/main
--jq '.[]'` with REQUIRED_CONTEXTS and prints `::warning::` lines on any
difference or read problem. It always exits 0, so it can never block a deploy
(a revert redeploy must not wait on a ruleset read).

Why: twice (S20 #376, 19 min early; S21 #420, 9 s after merge) the worker was
deployed by workflow_dispatch while v3/main CI on that SHA was still running.

Stdlib only; run as `python3 -I -u scripts/ci_green_gate.py ...`.
"""

from __future__ import annotations

import argparse
import json
import os
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

RULESET_ID = 26478884
DEPLOY_REF = "refs/heads/v3/main"

GITHUB_ACTIONS_APP_ID = 15368
DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml"

ON_BRANCH_STATUSES = frozenset({"identical", "ahead"})
OTHER_OK_CONCLUSIONS = frozenset({"success", "skipped"})

SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def check_run_identity(
    sha: str, ref: object, run_id: object, env: dict
) -> list[str]:
    """Problems with the run's ref and with --sha/--ref/--run-id vs the runner's own env."""
    problems = []
    if ref != DEPLOY_REF:
        problems.append(
            f"run ref {ref!r} is not {DEPLOY_REF}; deploys are dispatched only from v3/main"
        )
    for var, want in (("GITHUB_SHA", sha), ("GITHUB_REF", ref), ("GITHUB_RUN_ID", str(run_id))):
        got = env.get(var)
        if not got:
            problems.append(f"{var} is not set; cannot confirm the gated run is this run")
        elif got != want:
            problems.append(f"{var} is {got!r} but the gate was given {want!r}")
    return problems


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
    sha: str,
    runs_text: str,
    compare_text: str,
    deploy_runs_text: str,
    run_id: object,
    ref: object,
    env: dict,
) -> list[str]:
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        return [f"deployed SHA {sha!r} is not a 40-char lowercase hex SHA"]
    if not isinstance(run_id, int) or isinstance(run_id, bool) or run_id <= 0:
        return [f"run id {run_id!r} is not a positive integer"]
    problems = check_run_identity(sha, ref, run_id, env)
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


def ruleset_drift(rules_text: str) -> list[str]:
    """Warnings (never errors) comparing ruleset RULESET_ID's required contexts with ours."""
    try:
        rules = load_ndjson(rules_text)
    except ValueError as exc:
        return [f"branch rules response is not JSON: {exc}"]
    contexts = None
    for rule in rules:
        if (
            isinstance(rule, dict)
            and rule.get("type") == "required_status_checks"
            and rule.get("ruleset_id") == RULESET_ID
        ):
            params = rule.get("parameters")
            checks = params.get("required_status_checks") if isinstance(params, dict) else None
            if not isinstance(checks, list):
                return [f"ruleset {RULESET_ID} required_status_checks is not a list"]
            contexts = [c.get("context") for c in checks if isinstance(c, dict)]
    if contexts is None:
        return [f"ruleset {RULESET_ID} has no required_status_checks rule on v3/main"]
    warnings = []
    missing = sorted(set(contexts) - set(REQUIRED_CONTEXTS), key=str)
    extra = sorted(set(REQUIRED_CONTEXTS) - set(contexts), key=str)
    if missing:
        warnings.append(
            f"ruleset {RULESET_ID} requires {missing} but REQUIRED_CONTEXTS does not "
            "(the gate under-checks them; update scripts/ci_green_gate.py)"
        )
    if extra:
        warnings.append(
            f"REQUIRED_CONTEXTS has {extra} but ruleset {RULESET_ID} no longer requires them "
            "(the gate may block deploys; update scripts/ci_green_gate.py)"
        )
    return warnings


def drift_main(argv: list[str]) -> int:
    """Non-blocking ruleset drift report. ALWAYS returns 0."""
    try:
        if len(argv) != 1:
            raise OSError(f"usage: --drift RULES_NDJSON (got {argv!r})")
        with open(argv[0], encoding="utf-8") as fh:
            text = fh.read()
        warnings = ruleset_drift(text)
    except Exception as exc:  # noqa: BLE001 -- non-blocking by design
        warnings = [f"drift check could not run: {exc}"]
    for w in warnings:
        print(f"::warning title=ruleset drift::{w}")
    if not warnings:
        print(f"ruleset-drift: OK: ruleset {RULESET_ID} requires exactly REQUIRED_CONTEXTS")
    return 0


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if env is None:
        env = dict(os.environ)
    if argv[:1] == ["--drift"]:
        return drift_main(argv[1:])
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sha", required=True)
    ap.add_argument("--runs", required=True, help="check-runs NDJSON file")
    ap.add_argument("--compare", required=True, help="compare JSON file")
    ap.add_argument("--deploy-runs", required=True, help="deploy.yml workflow runs NDJSON file")
    ap.add_argument("--run-id", required=True, help="GITHUB_RUN_ID of this run")
    ap.add_argument("--ref", required=True, help="github.ref of this run")
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
    problems = evaluate(
        args.sha, runs_text, compare_text, deploy_runs_text, run_id, args.ref, env
    )
    if problems:
        print(f"ci-green-gate: FAIL: refusing to deploy {args.sha}")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(
        f"ci-green-gate: OK: {args.ref} at {args.sha} is on v3/main, all {len(REQUIRED_CONTEXTS)} "
        "required checks concluded success, and no other GitHub Actions check-run "
        "on it is pending or red"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
