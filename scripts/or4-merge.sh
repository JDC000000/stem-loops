#!/usr/bin/env bash
# or4-merge.sh <pr> <review-file> <reviewed-sha> — OR-4 gate v3.5 (S19A): ONE gate for 19A and 19B.
# v3.5 = the STRICTEST union of v3.4 (19A, #382) and v3.4-R2 (19B, #385; Jon 2026-11-23 23:29Z "structurally solve" merge
#   contention) plus #384 (I1, I2):
#   - behind_by==0 passes the behind guard as before. behind_by>0 passes ONLY if ALLOW_BEHIND=1 AND the PR is NOT protected AND
#     behind_by <= 5 (MAX_BEHIND may lower it, never raise it) AND PR/main changed files are disjoint AND no hot/coupled file on
#     either side (PR side: HOT_RE ∪ COUPLED_RE; main side: HOT_RE ∪ (COUPLED_MAIN_RE minus MAIN_EXEMPT_RE)) AND main deleted or
#     renamed nothing since the merge-base. Listings fail closed.
#   - Snapshot pin EVERY run: compare base_commit == local origin/v3/main == GET branches/v3/main, merge_base_commit == local $mb.
#   - Right before the merge PUT, v3/main is re-read; if it moved: FAIL "main moved; re-run".
#   - #384 I2: repo-redirecting GIT_* vars are unset and GIT_NO_REPLACE_OBJECTS=1 exported at gate start (GIT_CONFIG_*,
#     GIT_ASKPASS, GIT_SSL_CAINFO are KEPT: proxy/auth needs them); any `git replace -l` entry in the clone FAILS.
# v3.4 (JON 2026-11-23 16:34, "require branches up to date" OFF on ruleset 26478884; LEDGER-19A rows 63/65): overlap/hot guard.
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
# v3.5 (#384 I2): never let the environment redirect git to another repo/object store or substitute objects. Applied in library
# mode too (harmless). GIT_CONFIG_*, GIT_ASKPASS, GIT_SSL_CAINFO, GIT_TERMINAL_PROMPT stay: the session's proxy/auth needs them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_REPLACE_REF_BASE GIT_NAMESPACE GIT_COMMON_DIR
export GIT_NO_REPLACE_OBJECTS=1
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
# v3.5: COUPLED_RE / COUPLED_MAIN_RE / MAIN_EXEMPT_RE verbatim from 19B v3.4-R2 (#385, review R3 PASS 93). Union with HOT_RE.
COUPLED_RE='(^|/)(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.npmrc|\.nvmrc|\.node-version|\.python-version|\.tool-versions|pyproject\.toml|setup\.cfg|conftest\.py|requirements[^/]*\.txt|constraints[^/]*\.txt|tsconfig[^/]*\.json|Makefile|Dockerfile|docker-compose[^/]*\.yml|generated\.ts|models\.py)$|^\.github/|^scripts/|(^|/)migrations/|(^|/)\.claude/|AGENTS\.md|CLAUDE|\.config\.[cm]?[jt]s$|(^|/)\.(eslint|prettier)[^/]*$'
COUPLED_MAIN_RE='(^|/)(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.npmrc|\.nvmrc|\.node-version|\.python-version|\.tool-versions|pyproject\.toml|setup\.cfg|conftest\.py|requirements[^/]*\.txt|constraints[^/]*\.txt|tsconfig[^/]*\.json|Makefile|Dockerfile|docker-compose[^/]*\.yml|generated\.ts|models\.py)$|^\.github/(workflows|actions)/|(^|/)scripts/.*\.(py|sh|bash|mjs|cjs|js|ts|json|ya?ml|sql|html)$|(^|/)migrations/|\.config\.[cm]?[jt]s$|(^|/)\.(eslint|prettier)[^/]*$'
# Main-side exemption from COUPLED_MAIN_RE only (never from HOT_RE): the gate files, which no CI job runs or imports.
MAIN_EXEMPT_RE='^scripts/(or4-merge\.sh|test_or4_merge\.py)$'
# is_protected_pr <labels> <title> <protected-paths>: rc 0 iff the PR is in the protected class (label, [billing] title or path).
is_protected_pr() { echo "$1" | grep -qi needs-jon-approval || echo "$2" | grep -qi '\[billing\]' || [ -n "$3" ]; }
# overlap_decision <behind_by> <pr-files> <main-files> <main-deleted-files> <protected 0|1>: lists are NUL-separated files
# (main = changed on v3/main since the PR's merge-base; deleted = --diff-filter=D --no-renames on the same range, so renames
# count). rc 0 = pass. behind==0 passes; everything else must satisfy every v3.5 condition (header), failing closed.
overlap_decision() {
  local bb=$1 pf=$2 mf=$3 df=${4:-} pr_prot=${5:-1} mx=${MAX_BEHIND:-5} bad
  [[ "$bb" =~ ^[0-9]+$ ]] || { echo "FAIL: behind_by not numeric ($bb)"; return 1; }
  [ "$bb" -eq 0 ] && return 0
  [ "${ALLOW_BEHIND:-0}" = 1 ] || { echo "FAIL: behind_by=$bb and ALLOW_BEHIND!=1: update-branch first"; return 1; }
  [ "$pr_prot" = 0 ] || { echo "FAIL: protected PR must be up to date (behind_by=$bb): update-branch first"; return 1; }
  { [[ "$mx" =~ ^[0-9]+$ ]] && [ "$mx" -le 5 ]; } || mx=5
  [ "$bb" -le "$mx" ] || { echo "FAIL: behind_by=$bb > $mx (stale): update-branch first"; return 1; }
  { [ -s "$pf" ] && [ -s "$mf" ] && [ -n "$df" ] && [ -f "$df" ]; } \
    || { echo "FAIL: behind_by=$bb and a changed-file listing is empty/unavailable (fail closed)"; return 1; }
  bad=$( { sort -zu "$pf" | comm -z -12 - <(sort -zu "$mf") | tr '\0' '\n'
           grep -zEi "$HOT_RE|$COUPLED_RE" "$pf" | tr '\0' '\n'
           grep -zEi "$HOT_RE" "$mf" | tr '\0' '\n'
           grep -zEi "$COUPLED_MAIN_RE" "$mf" | grep -zEiv "$MAIN_EXEMPT_RE" | tr '\0' '\n'; } | sort -u | head -5 | tr '\n' ' ')
  [ -z "$bad" ] || { echo "FAIL: behind_by=$bb overlap/hot/coupled file: update-branch first: $bad"; return 1; }
  bad=$(tr '\0' '\n' <"$df" | head -5 | tr '\n' ' ')
  [ -z "$bad" ] || { echo "FAIL: behind_by=$bb and main deleted/renamed files since merge-base: update-branch first: $bad"; return 1; }
  echo "behind_by=$bb (ALLOW_BEHIND=1, not protected, <=$mx): no overlap, no hot/coupled file, no main deletion/rename -> ok"
  return 0
}
# snapshot_pin <repo> <merge-base> <api_base_sha> <api_merge_base_sha> <api_branch_sha>: ALWAYS (behind or not) the API compare and
# GET branches/v3/main must describe the same main/merge-base as the local clone, else FAIL "main moved during gate".
snapshot_pin() {
  local lm; lm=$(git -C "$1" rev-parse origin/v3/main 2>/dev/null)
  { [ -n "$lm" ] && [ -n "$2" ] && [ "$3" = "$lm" ] && [ "$4" = "$2" ] && [ "${5:-}" = "$lm" ]; } \
    || { echo "FAIL: main moved during gate (api base=$3 branch=${5:-} local=$lm; api merge-base=$4 local=$2); re-run"; return 1; }
}
# overlap_gate <repo> <merge-base> <behind_by> <pr-files> <protected 0|1>: call-site wiring, sourced so tests reach it. Lists the
# main-side changed and deleted files (fail closed), then overlap_decision. rc 0 = pass. (Snapshot pin runs unconditionally before.)
overlap_gate() {
  local repo=$1 mb=$2 bb=$3 pf=$4 pp=$5 ml dl rc
  [[ "$bb" =~ ^[0-9]+$ ]] || { overlap_decision "$bb" "$pf" /dev/null "" "$pp"; return; }
  [ "$bb" -eq 0 ] && return 0
  ml=$(mktemp) || return 1; dl=$(mktemp) || { rm -f "$ml"; return 1; }
  list_changed "$repo" "$mb" origin/v3/main "$ml" || : >"$ml"
  if ! { [ -n "$mb" ] && git -C "$repo" -c core.quotePath=false diff --no-renames --diff-filter=D --name-only -z "$mb" origin/v3/main >"$dl" 2>/dev/null; }; then
    rm -f "$dl"; dl=""
  fi
  overlap_decision "$bb" "$pf" "$ml" "$dl" "$pp"; rc=$?
  rm -f "$ml" ${dl:+"$dl"}; return $rc
}
# replace_check <repo>: #384 I2. rc 1 (FAIL) if the clone has any replace ref, or if listing them fails.
replace_check() {
  local r; r=$(git -C "$1" replace -l 2>/dev/null) || { echo "FAIL: cannot list git replace refs (fail closed)"; return 1; }
  [ -z "$r" ] || { echo "FAIL: git replace refs present in $1 (would hide changed files): $(echo "$r" | head -3 | tr '\n' ' ')"; return 1; }
}
# main_unmoved <pinned-main-sha>: right before the merge PUT, v3/main must still be the pinned snapshot. rc 1 = FAIL.
main_unmoved() {
  local cur; cur=$(gh api repos/JDC000000/stem-loops/branches/v3/main --jq .commit.sha 2>/dev/null) || cur=""
  { [ -n "$1" ] && [ "$cur" = "$1" ]; } || { echo "FAIL: main moved; re-run (pinned=$1 now=$cur)"; return 1; }
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
replace_check "$REPO" || fail=1
mb=$(git -C $REPO merge-base origin/v3/main "$H" 2>/dev/null)
# v3.4 R2: one compare call returns behind_by plus the base/merge-base it was computed against (pinned in overlap_gate).
cmp=$(gh api $R/compare/v3/main...$H --jq '[.behind_by,.base_commit.sha,.merge_base_commit.sha]|@tsv') || cmp=""
IFS=$'\t' read -r bb abase amb <<<"$cmp"
apimain=$(gh api $R/branches/v3/main --jq .commit.sha) || apimain=""
snapshot_pin "$REPO" "$mb" "$abase" "$amb" "$apimain" || fail=1
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
# v3.5: behind guard (v3.4 overlap/hot ∪ v3.4-R2 ALLOW_BEHIND/protected/≤5/coupled/deletions); see overlap_decision.
pp=1; is_protected_pr "$l" "$T" "$prot" || pp=0
overlap_gate "$REPO" "$mb" "$bb" "$fl" "$pp" || fail=1
n=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '[.check_runs[]|select(.conclusion!="success" and .conclusion!="skipped")]|length')
[ "$n" = 0 ] || { echo "FAIL: $n checks not success/skipped"; fail=1; }
t=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '.total_count'); [ "${t:-0}" -ge 10 ] || { echo "FAIL: only ${t:-0} check-runs registered (need ≥10)"; fail=1; }
st=$(gh api "$R/commits/$H/status" --jq '[.statuses[]|select(.state!="success")]|length'); [ "${st:-1}" = 0 ] || { echo "FAIL: $st commit statuses not success"; fail=1; }
if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN fail=$fail (no merge)"; exit $fail; fi
[ $fail = 0 ] || { echo "NOT MERGED"; exit 1; }
main_unmoved "$apimain" || exit 1
gh api -X PUT $R/pulls/$PR/merge -f merge_method=squash -f sha="$H" --jq '"merged=\(.merged) sha=\(.sha)"' || { echo "FAIL: merge PUT"; exit 1; }
ma=$(gh api $R/pulls/$PR --jq '"\(.merged_at) \(.merged_by.login)"'); echo "merged_at merged_by = $ma"
[ "${ma%% *}" != null ] || { echo "FAIL: not merged"; exit 1; }
