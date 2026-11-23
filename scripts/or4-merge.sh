#!/usr/bin/env bash
# or4-merge.sh <pr> <review-file> <reviewed-sha> — OR-4 gate v3.3 (S18).
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
PROTECTED_RE='^(\.github/|scripts/|AGENTS\.md|CLAUDE|\.mcp\.json)|(^|/)\.claude/|(^|/)SKILL\.md$|CODEOWNERS|migrations/|(^|/)\.env|billing|stripe|entitlement|(^|/)auth(/|\.)|service[-_]?role|secret'
# marker_sha <review-file>: HEAD prefix of the last "VERDICT: PASS <91-100> HEAD <sha7-40>" line, else nothing.
marker_sha() { grep -E '^VERDICT: ' "$1" | tail -1 | grep -oE "^VERDICT: PASS (9[1-9]|100) HEAD [0-9a-f]{7,40}( |$)" | awk '{print $5}'; }
# marker_ok <review-file> <reviewed-sha>: 0 iff the marker is valid and its sha is a prefix of <reviewed-sha>.
marker_ok() { local ms; ms=$(marker_sha "$1"); [ -n "$ms" ] && [ "${2#$ms}" != "$2" ]; }
if [ "${OR4_LIB:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi
PR=$1; REVIEW=$2; REVIEWED=$3; R=repos/JDC000000/stem-loops; REPO=/home/claude/stem-loops; fail=0
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
pid() { local mb; mb=$(git -C $REPO merge-base origin/v3/main "$1" 2>/dev/null) || return 1
        git -C $REPO diff --binary --full-index -M --no-color --no-ext-diff "$mb" "$1" | git -C $REPO patch-id --stable | awk '{print $1}' | sort | sha256sum | cut -c1-16; }
a=$(pid "$REVIEWED") || a=""; b=$(pid "$H") || b=""
EMPTY=$(printf '' | sha256sum | cut -c1-16); echo "pr-content reviewed=$a head=$b"
{ [ -n "$a" ] && [ "$a" != "$EMPTY" ] && [ "$a" = "$b" ]; } || { echo "FAIL: PR content at head ≠ reviewed (or not computable)"; fail=1; }
bb=$(gh api $R/compare/v3/main...$H --jq .behind_by); [ "$bb" = 0 ] || { echo "FAIL: behind_by=$bb"; fail=1; }
d=$(gh api $R/pulls/$PR --jq .draft); [ "$d" = false ] || { echo "FAIL: draft"; fail=1; }
l=$(gh api $R/pulls/$PR --jq '[.labels[].name]|join(",")'); echo "labels=$l"
echo "$l" | grep -qE "fast-path|rollback-safe|adversarial-reviewed" && { echo "FAIL: merge-bot label present"; fail=1; }
T=$(gh api $R/pulls/$PR --jq .title); mb=$(git -C $REPO merge-base origin/v3/main "$H" 2>/dev/null)
prot=$(git -C $REPO diff --name-only "$mb" "$H" 2>/dev/null | grep -Ei "$PROTECTED_RE" | head -5 | tr '\n' ' ')
if echo "$l" | grep -q needs-jon-approval || echo "$T" | grep -qi '\[billing\]' || [ -n "$prot" ]; then
  echo "protected: labels/title/paths -> ${prot:-label-or-title}"
  [[ "${JON_ROW:-}" =~ ^[0-9]+$ ]] || { echo "FAIL: protected PR needs JON_ROW=<ledger row with Jon's named approval>"; fail=1; }
  [ -n "${JON_ROW:-}" ] && echo "JON_ROW=$JON_ROW"
fi
n=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '[.check_runs[]|select(.conclusion!="success" and .conclusion!="skipped")]|length')
[ "$n" = 0 ] || { echo "FAIL: $n checks not success/skipped"; fail=1; }
t=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '.total_count'); [ "${t:-0}" -ge 10 ] || { echo "FAIL: only ${t:-0} check-runs registered (need ≥10)"; fail=1; }
st=$(gh api "$R/commits/$H/status" --jq '[.statuses[]|select(.state!="success")]|length'); [ "${st:-1}" = 0 ] || { echo "FAIL: $st commit statuses not success"; fail=1; }
if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN fail=$fail (no merge)"; exit $fail; fi
[ $fail = 0 ] || { echo "NOT MERGED"; exit 1; }
gh api -X PUT $R/pulls/$PR/merge -f merge_method=squash -f sha="$H" --jq '"merged=\(.merged) sha=\(.sha)"' || { echo "FAIL: merge PUT"; exit 1; }
ma=$(gh api $R/pulls/$PR --jq '"\(.merged_at) \(.merged_by.login)"'); echo "merged_at merged_by = $ma"
[ "${ma%% *}" != null ] || { echo "FAIL: not merged"; exit 1; }
