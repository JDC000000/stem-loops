#!/usr/bin/env python3
"""Deploy guard: fail closed unless main CI is green on the SHA being deployed.

Used by the first job of .github/workflows/deploy.yml (`ci-green-gate`), which
every deploy job `needs:`. The workflow fetches two REST responses with the
job's GITHUB_TOKEN (checks: read, contents: read) and passes the files here:

  --runs     NDJSON, one check-run object per line, from
             `gh api --paginate "repos/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100" --jq '.check_runs[]'`
  --compare  JSON `{"status": ..., "merge_base": ...}` from
             `gh api "repos/{repo}/compare/{sha}...v3/main" --jq '{status: .status, merge_base: .merge_base_commit.sha}'`

Exit 0 only when BOTH hold:
  1. The SHA is on v3/main: the compare of SHA...v3/main is "identical" or
     "ahead" (v3/main contains SHA) AND its merge base is SHA itself.
  2. Every context in REQUIRED_CONTEXTS (the 10 required status checks of
     ruleset 26478884) has at least one check-run on exactly this SHA from
     GitHub Actions (app id 15368), and EVERY such run is status=completed
     with conclusion=success. Missing, queued, in_progress, skipped, neutral,
     cancelled, timed_out, action_required, stale, failure: all fail.

Anything unparsable fails. Check-runs of this deploy workflow's own jobs are
dropped before evaluation (they are never required contexts; see the test
that pins the two lists as disjoint).

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

# Job names in deploy.yml: never counted, in either direction.
DEPLOY_WORKFLOW_JOB_NAMES: frozenset[str] = frozenset(
    {
        "CI green gate (deployed SHA on v3/main)",
        "Deploy Web to Vercel",
        "Deploy Worker to Fly.io",
    }
)

ON_BRANCH_STATUSES = frozenset({"identical", "ahead"})

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


def check_runs_green(sha: str, runs: list) -> list[str]:
    """Problems with the check-runs on SHA (empty list = every required context green)."""
    by_name: dict[str, list[dict]] = {}
    problems = []
    for run in runs:
        if not isinstance(run, dict):
            problems.append("check-run entry is not a JSON object")
            continue
        name = run.get("name")
        if name in DEPLOY_WORKFLOW_JOB_NAMES:
            continue
        if name not in REQUIRED_CONTEXTS:
            continue
        app = run.get("app")
        app_id = app.get("id") if isinstance(app, dict) else None
        if app_id != GITHUB_ACTIONS_APP_ID:
            # A same-named run from another app is not CI: ignore it, so it can
            # neither satisfy nor mask the real context.
            continue
        if run.get("head_sha") != sha:
            problems.append(
                f"{name!r}: check-run head_sha {run.get('head_sha')!r} != {sha}"
            )
            continue
        by_name.setdefault(name, []).append(run)

    for ctx in REQUIRED_CONTEXTS:
        got = by_name.get(ctx)
        if not got:
            problems.append(f"{ctx!r}: no GitHub Actions check-run on {sha}")
            continue
        for run in got:
            status = run.get("status")
            conclusion = run.get("conclusion")
            if status != "completed" or conclusion != "success":
                problems.append(
                    f"{ctx!r}: status={status!r} conclusion={conclusion!r} "
                    f"(run id {run.get('id')!r}); need completed/success"
                )
    return problems


def load_runs(text: str) -> list:
    """Parse NDJSON (one object per line); a JSON array or {"check_runs": [...]} also works."""
    stripped = text.strip()
    if not stripped:
        return []
    if stripped[0] == "[":
        data = json.loads(stripped)
        if not isinstance(data, list):
            raise ValueError("runs JSON is not a list")
        return data
    if stripped[0] == "{" and "\n" not in stripped:
        one = json.loads(stripped)
        if isinstance(one, dict) and "check_runs" in one:
            if not isinstance(one["check_runs"], list):
                raise ValueError("check_runs is not a list")
            return one["check_runs"]
        return [one]
    out = []
    for line in stripped.splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def evaluate(sha: str, runs_text: str, compare_text: str) -> list[str]:
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        return [f"deployed SHA {sha!r} is not a 40-char lowercase hex SHA"]
    problems = []
    try:
        compare = json.loads(compare_text)
    except ValueError as exc:
        problems.append(f"compare response is not JSON: {exc}")
    else:
        problems.extend(check_on_branch(sha, compare))
    try:
        runs = load_runs(runs_text)
    except ValueError as exc:
        problems.append(f"check-runs response is not JSON: {exc}")
    else:
        problems.extend(check_runs_green(sha, runs))
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sha", required=True)
    ap.add_argument("--runs", required=True, help="check-runs NDJSON file")
    ap.add_argument("--compare", required=True, help="compare JSON file")
    args = ap.parse_args(argv)
    try:
        with open(args.runs, encoding="utf-8") as fh:
            runs_text = fh.read()
        with open(args.compare, encoding="utf-8") as fh:
            compare_text = fh.read()
    except OSError as exc:
        print(f"ci-green-gate: FAIL: cannot read input: {exc}")
        return 1
    problems = evaluate(args.sha, runs_text, compare_text)
    if problems:
        print(f"ci-green-gate: FAIL: refusing to deploy {args.sha}")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(
        f"ci-green-gate: OK: {args.sha} is on v3/main and all "
        f"{len(REQUIRED_CONTEXTS)} required checks concluded success"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
