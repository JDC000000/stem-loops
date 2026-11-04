#!/usr/bin/env bash
# safe_merge.sh — enforce AGENTS.md §11 M-1 before admin-merging a PR.
#
# M-1: `gh pr merge --admin` must not bypass a FAILING or PENDING check,
# and must not merge a commit with zero check-runs registered yet. Admin
# bypass is for the CODEOWNERS self-approval deadlock only.
#
# Usage:  scripts/safe_merge.sh <PR_NUMBER> [--squash|--merge|--rebase]
# Default method: --squash. Always passes --delete-branch and
# --match-head-commit to close the race where a push between the check
# and the merge would otherwise admit unchecked code to main.
#
# Exits 0 after a successful merge; non-zero otherwise.

set -euo pipefail

PR="${1:-}"
METHOD="${2:---squash}"
REPO="${GITHUB_REPO:-JDC000000/stem-loops}"

usage() {
  echo "usage: $(basename "$0") <PR_NUMBER> [--squash|--merge|--rebase]" >&2
  echo "       always adds --delete-branch and --match-head-commit." >&2
}

if [[ -z "$PR" || ! "$PR" =~ ^[0-9]+$ ]]; then
  usage; exit 2
fi

case "$METHOD" in
  --squash|--merge|--rebase) ;;
  *) echo "safe_merge: invalid method '$METHOD'" >&2; usage; exit 2 ;;
esac

echo "safe_merge: checking PR #$PR on $REPO ..." >&2

HEAD=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')
if [[ -z "$HEAD" ]]; then
  echo "safe_merge: could not resolve head SHA for PR #$PR" >&2
  exit 1
fi

# Fetch all check-runs once; parse for failing + pending + total count.
CHECKS_JSON=$(gh api "repos/$REPO/commits/$HEAD/check-runs?per_page=100")
TOTAL=$(jq -r '.check_runs | length' <<<"$CHECKS_JSON")

if [[ "$TOTAL" -eq 0 ]]; then
  echo "safe_merge: REFUSED — commit $HEAD has ZERO check-runs registered." >&2
  echo "safe_merge: CI has not started yet (or no workflows match). Wait for CI." >&2
  exit 1
fi

FAILED=$(jq -r '
  [.check_runs[]
    | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
    | .name] | join(", ")' <<<"$CHECKS_JSON")
PENDING=$(jq -r '
  [.check_runs[] | select(.status != "completed") | .name] | join(", ")' <<<"$CHECKS_JSON")

if [[ -n "$FAILED" ]]; then
  echo "safe_merge: REFUSED — PR #$PR has FAILING/CANCELLED/TIMED-OUT checks: $FAILED" >&2
  echo "safe_merge: fix CI first; --admin is for CODEOWNERS bypass only (AGENTS.md §11 M-1)." >&2
  exit 1
fi

if [[ -n "$PENDING" ]]; then
  echo "safe_merge: REFUSED — PR #$PR has PENDING checks: $PENDING" >&2
  echo "safe_merge: wait for CI to complete before merging." >&2
  exit 1
fi

echo "safe_merge: all $TOTAL check-runs on head $HEAD are green — merging..." >&2
# --match-head-commit closes the TOCTOU race where a push between the
# check and the merge would otherwise admit un-checked code to main.
exec gh pr merge "$PR" --admin "$METHOD" --delete-branch --match-head-commit "$HEAD"
