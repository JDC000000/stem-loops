#!/usr/bin/env bash
# or4-merge.sh <pr> <review-file> <reviewed-sha> — OR-4 gate v3.1 (S18). Merges ONLY if every check passes.
# v3 (L5-plan review R2, B2): (1) an explicit "Verdict: PASS" line is required; any FAIL/REVISE/BLOCK/CHANGES/
#   "not (a) PASS" in verdict/score lines refuses; every NN/100 or M-11/M-9/score number there must be > 90;
# (2) the review file must name the reviewed SHA (first 7 chars);
# (3) PR-content equality = `git diff --binary --full-index -M` | `git patch-id --stable` (names, modes, renames,
#   binaries) and FAILS CLOSED if either side can't be computed. DRY_RUN=1 checks without merging.
# Never use a bare PUT .../merge (E-S18-2).
set -uo pipefail
PR=$1; REVIEW=$2; REVIEWED=$3; R=repos/JDC000000/stem-loops; REPO=/home/claude/stem-loops; fail=0
H=$(gh api $R/pulls/$PR --jq .head.sha) || { echo "FAIL: cannot read PR"; exit 1; }
echo "head=$H reviewed=$REVIEWED"
if [ ! -f "$REVIEW" ]; then echo "FAIL: no review file $REVIEW"; fail=1
else
  # v3.1 (L5 review R3 C4): the marker is REQUIRED (no fallback): "VERDICT: PASS <score> HEAD <sha7+>", anchored.
  m=$(grep -E '^VERDICT: ' "$REVIEW" | tail -1); echo "marker: $m"
  ms=$(echo "$m" | grep -oE "^VERDICT: PASS (9[1-9]|100) HEAD [0-9a-f]{7,40}( |$)" | awk '{print $5}')
  { [ -n "$ms" ] && [ "${REVIEWED#$ms}" != "$REVIEWED" ]; } || { echo "FAIL: need marker 'VERDICT: PASS <91-100> HEAD <prefix of $REVIEWED, ≥7>'"; fail=1; }
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
n=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '[.check_runs[]|select(.conclusion!="success" and .conclusion!="skipped")]|length')
[ "$n" = 0 ] || { echo "FAIL: $n checks not success/skipped"; fail=1; }
if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN fail=$fail (no merge)"; exit $fail; fi
[ $fail = 0 ] || { echo "NOT MERGED"; exit 1; }
gh api -X PUT $R/pulls/$PR/merge -f merge_method=squash -f sha="$H" --jq '"merged=\(.merged) sha=\(.sha)"'
gh api $R/pulls/$PR --jq '"merged_at=\(.merged_at) merged_by=\(.merged_by.login)"'
