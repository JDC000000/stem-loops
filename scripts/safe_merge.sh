#!/usr/bin/env bash
# safe_merge.sh — enforce AGENTS.md §11 M-1 before admin-merging a PR.
#
# M-1: `gh pr merge --admin` must not bypass a FAILING required status check.
# Admin bypass is only for the CODEOWNERS self-approval deadlock. If any
# required status check on the PR head is red, we refuse the merge.
#
# Usage:  scripts/safe_merge.sh <PR_NUMBER> [--squash|--merge|--rebase]
#
# Example:  scripts/safe_merge.sh 29 --squash
#
# Exits 0 after a successful merge; non-zero otherwise.

set -euo pipefail

PR="${1:-}"
METHOD="${2:---squash}"
REPO="${GITHUB_REPO:-JDC000000/stem-loops}"

if [[ -z "$PR" || ! "$PR" =~ ^[0-9]+$ ]]; then
  echo "usage: $(basename "$0") <PR_NUMBER> [--squash|--merge|--rebase]" >&2
  exit 2
fi

echo "safe_merge: checking PR #$PR on $REPO ..." >&2

HEAD=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')
if [[ -z "$HEAD" ]]; then
  echo "safe_merge: could not resolve head SHA for PR #$PR" >&2
  exit 1
fi

# Collect failing + still-running required check names, if any.
FAILED=$(
  gh api "repos/$REPO/commits/$HEAD/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name] | join(", ")'
)
PENDING=$(
  gh api "repos/$REPO/commits/$HEAD/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.status != "completed") | .name] | join(", ")'
)

if [[ -n "$FAILED" ]]; then
  echo "safe_merge: REFUSED — PR #$PR has FAILING checks: $FAILED" >&2
  echo "safe_merge: fix CI first; --admin is for CODEOWNERS bypass only (AGENTS.md §11 M-1)." >&2
  exit 1
fi

if [[ -n "$PENDING" ]]; then
  echo "safe_merge: REFUSED — PR #$PR has PENDING checks: $PENDING" >&2
  echo "safe_merge: wait for CI to complete before merging." >&2
  exit 1
fi

echo "safe_merge: all checks on head $HEAD are green — merging with --admin $METHOD ..." >&2
exec gh pr merge "$PR" --admin "$METHOD" --delete-branch
