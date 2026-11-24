#!/usr/bin/env bash
# or4-merge.sh <pr> <review-file> <reviewed-sha> — OR-4 gate v3.4 (S19A).
# v3.4 (JON 2026-11-23 16:34, "require branches up to date" OFF on ruleset 26478884; LEDGER-19A rows 63/65): behind_by==0 is no
#   longer required. If behind_by>0 the gate passes only when the PR's changed files and the files changed on v3/main since the
#   merge-base are DISJOINT and neither side has a hot file (lockfiles, package.json, migrations/, AGENTS.md, CODEOWNERS,
#   workflows, tsconfig*, next.config.*, pnpm-workspace.yaml); behind_by>20 FAILS (stale). Listings fail closed.
# v3.3 (rules v3.4 review R1): a PR labelled needs-jon-approval/[billing], or touching a protected path
#   (.github/, scripts/, **/.claude/, AGENTS.md, CLAUDE*, .mcp.json, **/SKILL.md, CODEOWNERS, any migrations/, .env*, billing|stripe|entitlement|auth|service-role|secret)
#   FAILS unless JON_ROW=<ledger row of Jon's named approval for this PR> is set in the environment.
# v3.2 (PR #349 review R1): PR must be numeric; ≥10 check-runs must exist (required set) or FAIL; commit statuses
#   in failure/error/pending FAIL; exit 1 unless the merge PUT succeeds AND merged_at is set. Merges ONLY if every check passes.
# v3 (L5-plan review R2, B2): (1) an explicit "Verdict: PASS" line is required; any FAIL/REVISE/BLOCK/CHANGES/
#   "not (a) PASS" in verdict/score lines refuses; every NN/100 or M-11/M-9/score number there must be > 90;
# (2) the review file must name the reviewed SHA (first 7 chars);
# (3) PR-content equality = `git diff --binary --full-index -M` | `git patch-id --stable` (names, modes, renames,
#   binaries) and FAILS CLOSED if either side can't be computed. DRY_RUN=1 checks without merging.
# Never use a bare PUT .../merge (E-S18-2).
set -uo pipefail
# Single definitions shared with scripts/test_or4_merge.py (it sources this file with OR4_LIB=1; no copy can drift).
# v3.3 R2: AGENTS.md/CLAUDE*/.mcp.json/SKILL.md match at ANY depth; matching is always case-insensitive (grep -i).
PROTECTED_RE='^(\.github/|scripts/)|(^|/)(AGENTS\.md|CLAUDE[^/]*|\.mcp\.json|SKILL\.md)$|(^|/)\.claude/|CODEOWNERS|migrations/|(^|/)\.env|billing|stripe|entitlement|(^|/)auth(/|\.)|authz|oauth|middleware|webhook|service[-_]?role|secret'
# marker_sha <review-file>: HEAD prefix of the last "VERDICT: PASS <91-100> HEAD <sha7-40>" line, else nothing.
marker_sha() { grep -E '^VERDICT: ' "$1" | tail -1 | grep -oE "^VERDICT: PASS (9[1-9]|100) HEAD [0-9a-f]{7,40}( |$)" | awk '{print $5}'; }
# marker_ok <review-file> <reviewed-sha>: 0 iff the marker is valid and its sha is a prefix of <reviewed-sha>.
marker_ok() { local ms; ms=$(marker_sha "$1"); [ -n "$ms" ] && [ "${2#$ms}" != "$2" ]; }
# protected_match: stdin = NUL-separated paths; prints (newline-separated) those in the protected class.
protected_match() { grep -zEi "$PROTECTED_RE" | tr '\0' '\n'; }
# protected_decision <labels> <title> <protected-paths> <pr>: prints notes; rc 1 = FAIL (protected and no valid approval).
# Approval = JON_ROW (numeric ledger row) AND JON_PR equal to <pr> (ties the approval to this PR).
protected_decision() {
  local l=$1 T=$2 prot=$3 pr=$4
  if echo "$l" | grep -qi needs-jon-approval || echo "$T" | grep -qi '\[billing\]' || [ -n "$prot" ]; then
    echo "protected: labels/title/paths -> ${prot:-label-or-title}"
    [ -n "${JON_ROW:-}" ] && echo "JON_ROW=$JON_ROW JON_PR=${JON_PR:-}"
    [[ "${JON_ROW:-}" =~ ^[0-9]+$ ]] && [[ "${JON_PR:-}" =~ ^[0-9]+$ ]] && [ "$JON_PR" = "$pr" ] && return 0
    echo "FAIL: protected PR needs JON_ROW=<ledger row with Jon's named approval> and JON_PR=$pr"
    return 1
  fi
  return 0
}
# list_changed <repo> <base> <head> <outfile>: NUL-separated changed paths, renames split into delete+add (old AND new
# names), unquoted. rc 0 only if git succeeded AND the list is non-empty (fail closed).
list_changed() { [ -n "$2" ] && git -C "$1" -c core.quotePath=false diff --no-renames --name-only -z "$2" "$3" >"$4" 2>/dev/null && [ -s "$4" ]; }
# v3.4: HOT_RE = files where a textual merge can succeed but the result is still semantically stale/unsafe.
HOT_RE='(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|package\.json|AGENTS\.md|CODEOWNERS|pnpm-workspace\.yaml|constraints[^/]*\.txt|requirements[^/]*\.txt|pyproject\.toml|\.npmrc|\.nvmrc|turbo\.json|Dockerfile[^/]*|fly\.toml|docker-compose[^/]*\.ya?ml|Makefile|\.eslintrc[^/]*)$|^packages/types/(schema/contract\.schema\.json|src/generated\.ts)$|(^|/)migrations/|^\.github/workflows/|(^|/)tsconfig[^/]*\.json$|(^|/)next\.config\.[^/]*$'
# overlap_decision <behind_by> <pr-files> <main-files>: files are NUL-separated lists (main-files = changed on v3/main since the
# PR's merge-base). rc 0 = pass. behind==0 passes; non-numeric, >20, empty/missing list when behind, overlap or any hot file FAIL.
overlap_decision() {
  local bb=$1 pf=$2 mf=$3 bad
  [[ "$bb" =~ ^[0-9]+$ ]] || { echo "FAIL: behind_by not numeric ($bb)"; return 1; }
  [ "$bb" -eq 0 ] && return 0
  [ "$bb" -le 20 ] || { echo "FAIL: behind_by=$bb > 20 (stale): update-branch first"; return 1; }
  { [ -s "$pf" ] && [ -s "$mf" ]; } || { echo "FAIL: behind_by=$bb and a changed-file listing is empty/unavailable (fail closed)"; return 1; }
  bad=$( { sort -zu "$pf" | comm -z -12 - <(sort -zu "$mf") | tr '\0' '\n'
           cat "$pf" "$mf" | grep -zEi "$HOT_RE" | tr '\0' '\n'; } | sort -u | head -5 | tr '\n' ' ')
  [ -z "$bad" ] || { echo "FAIL: behind_by=$bb overlap/hot file: update-branch first: $bad"; return 1; }
  echo "behind_by=$bb: no file overlap, no hot file -> ok"
  return 0
}
# snapshot_pin <repo> <merge-base> <api_base_sha> <api_merge_base_sha>: ALWAYS (behind or not) the API compare must describe the same
# main/merge-base as the local clone, else FAIL "main moved during gate" (also catches a forged/retargeted local origin).
snapshot_pin() {
  local lm; lm=$(git -C "$1" rev-parse origin/v3/main 2>/dev/null)
  { [ -n "$lm" ] && [ -n "$2" ] && [ "$3" = "$lm" ] && [ "$4" = "$2" ]; } \
    || { echo "FAIL: main moved during gate (api base=$3 local=$lm; api merge-base=$4 local=$2); re-run"; return 1; }
}
# overlap_gate <repo> <merge-base> <behind_by> <pr-files>: call-site wiring (v3.4), sourced so tests reach it. Lists main-side files
# (fail closed), then overlap_decision. rc 0 = pass. (Snapshot pinning is snapshot_pin, run unconditionally before it.)
overlap_gate() {
  local repo=$1 mb=$2 bb=$3 pf=$4 ml rc
  [[ "$bb" =~ ^[0-9]+$ ]] || { overlap_decision "$bb" "$pf" /dev/null; return; }
  [ "$bb" -eq 0 ] && return 0
  ml=$(mktemp) || return 1
  list_changed "$repo" "$mb" origin/v3/main "$ml" || : >"$ml"
  overlap_decision "$bb" "$pf" "$ml"; rc=$?
  rm -f "$ml"; return $rc
}
if [ "${OR4_LIB:-0}" = 1 ]; then
  return 0 2>/dev/null
  echo "OR4_LIB set: library mode, NOT a merge" >&2; exit 2
fi
PR=$1; REVIEW=$2; REVIEWED=$3; R=repos/JDC000000/stem-loops; REPO=/home/claude/stem-loops; fail=0
# v3.4 R3: OR4_REPO (test clone) is honoured ONLY with DRY_RUN=1 AND OR4_TEST=1; otherwise set => refuse (fail closed, never ignored).
if [ -n "${OR4_REPO:-}" ]; then
  { [ "${DRY_RUN:-0}" = 1 ] && [ "${OR4_TEST:-0}" = 1 ]; } || { echo "FAIL: OR4_REPO set outside test mode"; exit 1; }
  REPO=$OR4_REPO
fi
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "FAIL: PR not numeric"; exit 1; }
H=$(gh api $R/pulls/$PR --jq .head.sha) || { echo "FAIL: cannot read PR"; exit 1; }
echo "head=$H reviewed=$REVIEWED"
if [ ! -f "$REVIEW" ]; then echo "FAIL: no review file $REVIEW"; fail=1
else
  # v3.1 (L5 review R3 C4): the marker is REQUIRED (no fallback): "VERDICT: PASS <score> HEAD <sha7+>", anchored.
  m=$(grep -E '^VERDICT: ' "$REVIEW" | tail -1); echo "marker: $m"
  marker_ok "$REVIEW" "$REVIEWED" || { echo "FAIL: need marker 'VERDICT: PASS <91-100> HEAD <prefix of $REVIEWED, ≥7>'"; fail=1; }
  grep -q "${REVIEWED:0:7}" "$REVIEW" || { echo "FAIL: review file does not name reviewed SHA ${REVIEWED:0:7}"; fail=1; }
fi
git -C $REPO fetch -q --depth=80 origin v3/main "+refs/pull/$PR/head:refs/remotes/pr/$PR" || { echo "FAIL: fetch"; fail=1; }
git -C $REPO fetch -q --depth=80 origin "$REVIEWED" 2>/dev/null
mb=$(git -C $REPO merge-base origin/v3/main "$H" 2>/dev/null)
# v3.4 R2: one compare call returns behind_by plus the base/merge-base it was computed against (pinned in overlap_gate).
cmp=$(gh api $R/compare/v3/main...$H --jq '[.behind_by,.base_commit.sha,.merge_base_commit.sha]|@tsv') || cmp=""
IFS=$'\t' read -r bb abase amb <<<"$cmp"
snapshot_pin "$REPO" "$mb" "$abase" "$amb" || fail=1
pid() { local mb; mb=$(git -C $REPO merge-base origin/v3/main "$1" 2>/dev/null) || return 1
        git -C $REPO diff --binary --full-index -M --no-color --no-ext-diff "$mb" "$1" | git -C $REPO patch-id --stable | awk '{print $1}' | sort | sha256sum | cut -c1-16; }
a=$(pid "$REVIEWED") || a=""; b=$(pid "$H") || b=""
EMPTY=$(printf '' | sha256sum | cut -c1-16); echo "pr-content reviewed=$a head=$b"
{ [ -n "$a" ] && [ "$a" != "$EMPTY" ] && [ "$a" = "$b" ]; } || { echo "FAIL: PR content at head ≠ reviewed (or not computable)"; fail=1; }
d=$(gh api $R/pulls/$PR --jq .draft); [ "$d" = false ] || { echo "FAIL: draft"; fail=1; }
l=$(gh api $R/pulls/$PR --jq '[.labels[].name]|join(",")') || { echo "FAIL: cannot read PR labels"; fail=1; l=""; }; echo "labels=$l"
echo "$l" | grep -qE "fast-path|rollback-safe|adversarial-reviewed" && { echo "FAIL: merge-bot label present"; fail=1; }
T=$(gh api $R/pulls/$PR --jq .title) || { echo "FAIL: cannot read PR title"; fail=1; T=""; }
# v3.3 R2: names via -z, quotePath off, renames split into delete+add (both old and new names listed); fail closed.
fl=$(mktemp); trap 'rm -f "$fl"' EXIT
if list_changed "$REPO" "$mb" "$H" "$fl"; then
  prot=$(protected_match <"$fl" | head -5 | tr '\n' ' ')
else
  echo "FAIL: cannot list PR changed files (merge-base/diff failed or empty)"; fail=1; prot=""
fi
protected_decision "$l" "$T" "$prot" "$PR" || fail=1
# v3.4: overlap guard (replaces behind_by==0); see overlap_gate.
overlap_gate "$REPO" "$mb" "$bb" "$fl" || fail=1
n=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '[.check_runs[]|select(.conclusion!="success" and .conclusion!="skipped")]|length')
[ "$n" = 0 ] || { echo "FAIL: $n checks not success/skipped"; fail=1; }
t=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '.total_count'); [ "${t:-0}" -ge 10 ] || { echo "FAIL: only ${t:-0} check-runs registered (need ≥10)"; fail=1; }
st=$(gh api "$R/commits/$H/status" --jq '[.statuses[]|select(.state!="success")]|length'); [ "${st:-1}" = 0 ] || { echo "FAIL: $st commit statuses not success"; fail=1; }
if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN fail=$fail (no merge)"; exit $fail; fi
[ $fail = 0 ] || { echo "NOT MERGED"; exit 1; }
gh api -X PUT $R/pulls/$PR/merge -f merge_method=squash -f sha="$H" --jq '"merged=\(.merged) sha=\(.sha)"' || { echo "FAIL: merge PUT"; exit 1; }
ma=$(gh api $R/pulls/$PR --jq '"\(.merged_at) \(.merged_by.login)"'); echo "merged_at merged_by = $ma"
[ "${ma%% *}" != null ] || { echo "FAIL: not merged"; exit 1; }
