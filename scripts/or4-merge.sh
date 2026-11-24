#!/usr/bin/env bash
# or4-merge.sh <pr> <review-file> <reviewed-sha> [<review-file-2>] — OR-4 gate v3.6.2 (S21): ONE gate for 19A and 19B.
# v3.6.2 (TIGHTENING ONLY; #413, R1 reviews of #411/#410): (1) MONEY_RE also covers apps/web/src/lib/library-server.ts, apps/web/src/app/jobs/[id]/page.tsx and
#   apps/web/src/lib/emails/dispatch.ts; (2) VERDICT:/SCORES: counting now FAILS CLOSED on reworded markers: any line that, after leading non-alphanumerics (indent, tab,
#   NBSP, `>`, `**`, `#`, backticks ...), begins VERDICT/SCORES (any case) with only non-alphanumerics before the `:` counts (`**VERDICT: FAIL**`, `> VERDICT:`, NBSP VERDICT:).
#   Case-insensitive counting predates v3.6.1; v3.6.1 added only indentation. REVIEWERS: never start ANY line, indented or not, in any case, with VERDICT: or SCORES:
#   except the two marker lines (line 1 / line 2). Still not caught: prose like `Final verdict:`.
# v3.6.1 (TIGHTENING ONLY; #406, R2 reviews of #401): (1) MONEY_RE widened (library/remake, worker reaper+consumer, stem-urls/keys, account pages+deletion, lib/db.ts,
#   job failure/retry, signed URLs, allowance/debit, rate limits, fetch gates, receipts ...); (2) any path with a non-ASCII byte is money; (3) VERDICT: and
#   SCORES: lines are counted AND when indented (case-insensitive counting predates v3.6.1), so a later reworded/indented one fails the one-line rule (line 1 / line 2 rules unchanged).
# v3.6 (TIGHTENING ONLY; D-7, #396; no check removed or loosened): (1) MONEY class (MONEY_RE paths or a `[billing]` title, title parsed
#   with jq; any parse/read error = money; MONEY=1 may only RAISE the class; the needs-jon-approval label makes a PR PROTECTED, not money;
#   MONEY_RE is a floor, the orchestrator still classifies by reading the files; money implies protected): every review file needs marker
#   score >= 93 and `SCORES: M-9 <n> M-11 <n>` (n integers 93-100) as the ONLY SCORES line, on line 2. (2) PROTECTED class: a SECOND review
#   file (4th positional arg); both need a valid PASS marker at the same reviewed SHA, must be different files and differ after
#   whitespace normalisation (a byte-level check, NOT proof of independence). (3) Every review file: exactly one `VERDICT:` line and it is
#   line 1. (4) LC_ALL=C and grep -a on path matching (non-UTF-8 path bytes cannot hide a path). (5) Merge tail: pre-PUT main re-check FAILS
#   CLOSED on any gh error; a PUT error or merged!=true exits 1 with a message; after the PUT, merged_at is re-read and must be non-null.
# v3.5.1 (TIGHTENING ONLY; #391, #393): DRY_RUN and ALLOW_BEHIND must each be unset, "0" or "1" (anything else, incl. true/yes/"2"/" 1"/"",
#   FAILS before any network call); text: approval is JON_ROW (see v3.3 below). No check removed or loosened.
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
#   FAILS unless JON_ROW=<ledger row of the approval (D-6 standing row 95 for self-approved merges, per AGENTS.md M-8)> is set in the environment.
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
# v3.6: byte-wise matching: under a UTF-8 locale grep treats a path with an invalid byte as binary and prints nothing (hides it from the regexes).
export LC_ALL=C
# Single definitions shared with scripts/test_or4_merge.py (it sources this file with OR4_LIB=1; no copy can drift).
# v3.3 R2: AGENTS.md/CLAUDE*/.mcp.json/SKILL.md match at ANY depth; matching is always case-insensitive (grep -i).
PROTECTED_RE='^(\.github/|scripts/)|(^|/)(AGENTS\.md|CLAUDE[^/]*|\.mcp\.json|SKILL\.md)$|(^|/)\.claude/|CODEOWNERS|migrations/|(^|/)\.env|billing|stripe|entitlement|(^|/)auth(/|\.)|authz|oauth|middleware|webhook|service[-_]?role|secret'
# marker_sha <review-file>: HEAD prefix of the last "VERDICT: PASS <91-100> HEAD <sha7-40>" line, else nothing.
marker_sha() { grep -E '^VERDICT: ' "$1" | tail -1 | grep -oE "^VERDICT: PASS (9[1-9]|100) HEAD [0-9a-f]{7,40}( |$)" | awk '{print $5}'; }
# marker_ok <review-file> <reviewed-sha>: 0 iff the marker is valid and its sha is a prefix of <reviewed-sha>.
marker_ok() { local ms; ms=$(marker_sha "$1"); [ -n "$ms" ] && [ "${2#$ms}" != "$2" ]; }
# protected_match: stdin = NUL-separated paths; prints (newline-separated) those in the protected class.
protected_match() { grep -azEi "$PROTECTED_RE" | tr '\0' '\n'; }
# protected_decision <labels> <title> <protected-paths> <pr>: prints notes; rc 1 = FAIL (protected and no valid approval).
# Approval = JON_ROW (numeric ledger row) AND JON_PR equal to <pr> (ties the approval to this PR).
protected_decision() {
  local l=$1 T=$2 prot=$3 pr=$4
  if echo "$l" | grep -qi needs-jon-approval || echo "$T" | grep -qi '\[billing\]' || [ -n "$prot" ]; then
    echo "protected: labels/title/paths -> ${prot:-label-or-title}"
    [ -n "${JON_ROW:-}" ] && echo "JON_ROW=$JON_ROW JON_PR=${JON_PR:-}"
    [[ "${JON_ROW:-}" =~ ^[0-9]+$ ]] && [[ "${JON_PR:-}" =~ ^[0-9]+$ ]] && [ "$JON_PR" = "$pr" ] && return 0
    echo "FAIL: protected PR needs JON_ROW=<ledger row of the approval (D-6 standing row 95 for self-approved merges, per AGENTS.md M-8)> and JON_PR=$pr"
    return 1
  fi
  return 0
}
# v3.6 (D-7): MONEY_RE = money/auth/job-admission paths. Case-insensitive (grep -i). A FLOOR, not the classification: the orchestrator still
# classifies by reading the files (MONEY=1 raises). Over-matches on purpose. Adds to, never replaces, PROTECTED_RE.
MONEY_RE='billing|stripe|entitlement|(^|/)auth(/|\.|z)|(^|/)auth[-_.]|authz|oauth|login|password|jwt|credits?|sessions?|service[-_]?role|secret|(^|[/_.-])rls([/_.-]|$)|(^|[/_.-])roles?([/_.-]|$)|grants?|webhook|api/jobs|jobs?[-_]?(admission|creat)|create[-_a-z]*job|claim[-_]?jobs?|job[-_]?access|admission|upload|retention|cleanup|spend|replicate|klangio|worker/pipeline|(^|/)r2|pricing|price|promo|quota|paid|payment|paywall|checkout|subscription|refund|trial|plan[-_]|users/me|hcaptcha|api/library|remake|reaper|consumer|stem[-_]?(urls?|keys?)|signed[-_]?ur[li]|presign|(^|/)account([-_/.]|$)|(^|/)db[-_.]|job[-_]?failure|retry|delet(e|ion)|erase|allowance|debit|commercial|seed[-_]plans|fetch[-_]?gates?|rate[-_]?limit|(^|/)demo[-_]rate|client[-_]ip|chords[-_]claim|job[-_]page[-_]gate|download[-_]gate|receipt|(^|/)success/|job[-_]attempts|library[-_]server|(^|/)emails/dispatch|(^|/)jobs/\[id\]/page\.tsx|(^|/)[0-9]+_jobs[._]'
# money_paths: stdin = NUL-separated paths; prints (newline-separated) those matching MONEY_RE.
# v3.6.1: ANY path with a non-ASCII byte is money (LC_ALL=C has no Unicode case folding, so e.g. U+017F would hide "stripe" from the regex).
NONASCII_RE=$'[\x80-\xff]'
money_paths() { grep -azEi -e "$MONEY_RE" -e "$NONASCII_RE" | tr '\0' '\n'; }
# money_meta <pr-json>: prints 1 if the title has [billing] (jq; the needs-jon-approval label is protected, NOT money), else 0. rc 1 on any parse problem.
money_meta() {
  local o
  o=$(printf '%s' "$1" | jq -r 'if (.title|type)=="string" then (if (.title|test("\\[billing\\]";"i")) then 1 else 0 end) else error("bad") end' 2>/dev/null) || return 1
  [[ "$o" =~ ^[01]$ ]] && echo "$o"
}
# marker_score <review-file>: the NN of the last valid "VERDICT: PASS NN HEAD sha" line, else nothing.
marker_score() { grep -aE '^VERDICT: ' "$1" | tail -1 | grep -oE "^VERDICT: PASS (9[1-9]|100) HEAD [0-9a-f]{7,40}( |$)" | awk '{print $3}'; }
# v3.6.2: a line "starts" VERDICT:/SCORES: if, after any leading non-alphanumeric bytes (space, tab, NBSP, >, *, #, backtick ...), it has the word then only
# non-alphanumerics up to a colon. LC_ALL=C: bytes >= 0x80 are non-alphanumeric. Fails closed (over-counting only costs a re-review).
VERDICT_LINE_RE='^[^[:alnum:]]*verdict[^[:alnum:]:]*:'
SCORES_LINE_RE='^[^[:alnum:]]*scores[^[:alnum:]:]*:'
# verdict_unique <review-file>: rc 0 iff the file has exactly ONE line starting VERDICT: (any case) and it is line 1 and a PASS marker line.
verdict_unique() {
  [ "$(grep -aciE "$VERDICT_LINE_RE" "$1" 2>/dev/null)" = 1 ] || return 1
  sed -n 1p "$1" | grep -qE '^VERDICT: PASS (9[1-9]|100) HEAD [0-9a-f]{7,40}( |$)'
}
# money_review_ok <review-file>: rc 0 iff line 1 is the PASS marker (ending after the sha) with score 93-100, line 2 is exactly
# "SCORES: M-9 <n> M-11 <n>" (n in 93-100), and it is the only SCORES line.
money_review_ok() {
  local sc; sc=$(marker_score "$1")
  [[ "$sc" =~ ^(9[3-9]|100)$ ]] || return 1
  sed -n 1p "$1" | grep -qE '^VERDICT: PASS (9[3-9]|100) HEAD [0-9a-f]{7,40}$' || return 1
  [ "$(grep -aciE "$SCORES_LINE_RE" "$1" 2>/dev/null)" = 1 ] || return 1
  sed -n 2p "$1" | grep -qE '^SCORES: M-9 (9[3-9]|100) M-11 (9[3-9]|100)$'
}
# review_norm <file>: CRLF -> LF, trailing whitespace stripped, blank lines dropped (for the near-duplicate check).
review_norm() { tr -d '\r' <"$1" | sed -E 's/[[:space:]]+$//' | grep -av '^$'; }
# review_pair_decision <protected 0|1> <money 0|1> <review1> <review2> <reviewed-sha>: rc 1 = FAIL (prints why).
review_pair_decision() {
  local prot=$1 money=$2 r1=$3 r2=${4:-} sha=$5 rc=0 f
  if [ "$prot" = 1 ]; then
    if [ -z "$r2" ] || [ ! -f "$r2" ]; then echo "FAIL: protected PR needs a SECOND review file (4th arg; missing or absent)"; return 1; fi
    [ -f "$r1" ] || { echo "FAIL: first review file missing"; return 1; }
    if [ "$r1" = "$r2" ] || [ "$r1" -ef "$r2" ]; then echo "FAIL: the two review files are the same path"; return 1; fi
    if cmp -s "$r1" "$r2"; then echo "FAIL: the two review files are byte-identical"; return 1; fi
    if cmp -s <(review_norm "$r1") <(review_norm "$r2"); then echo "FAIL: the two review files are identical after whitespace normalisation"; return 1; fi
    for f in "$r1" "$r2"; do
      marker_ok "$f" "$sha" || { echo "FAIL: $f lacks a valid PASS marker at reviewed SHA (protected: both reviews)"; rc=1; }
      grep -aq "${sha:0:7}" "$f" || { echo "FAIL: $f does not name reviewed SHA ${sha:0:7}"; rc=1; }
    done
  fi
  for f in "$r1" ${r2:+"$r2"}; do
    verdict_unique "$f" || { echo "FAIL: $f must have exactly one VERDICT: line and it must be line 1 (a PASS marker)"; rc=1; }
  done
  if [ "$money" = 1 ]; then
    for f in "$r1" ${r2:+"$r2"}; do
      money_review_ok "$f" || { echo "FAIL: money PR: $f needs line 1 'VERDICT: PASS <93-100> HEAD <sha>', marker score >= 93 and line 2 exactly 'SCORES: M-9 <93-100> M-11 <93-100>' as the only SCORES line"; rc=1; }
    done
  fi
  return $rc
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
           grep -azEi "$HOT_RE|$COUPLED_RE" "$pf" | tr '\0' '\n'
           grep -azEi "$HOT_RE" "$mf" | tr '\0' '\n'
           grep -azEi "$COUPLED_MAIN_RE" "$mf" | grep -azEiv "$MAIN_EXEMPT_RE" | tr '\0' '\n'; } | sort -u | head -5 | tr '\n' ' ')
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
  local cur; cur=$(gh api repos/JDC000000/stem-loops/branches/v3/main --jq .commit.sha 2>/dev/null) \
    || { echo "FAIL: cannot re-read v3/main before the merge (gh error); not merging (fail closed)"; return 1; }
  { [ -n "$1" ] && [ "$cur" = "$1" ]; } || { echo "FAIL: main moved; re-run (pinned=$1 now=$cur)"; return 1; }
}
if [ "${OR4_LIB:-0}" = 1 ]; then
  return 0 2>/dev/null
  echo "OR4_LIB set: library mode, NOT a merge" >&2; exit 2
fi
# v3.5.1 (#391): strict switches, checked before ANY gh/git call (and before the OR4_REPO guard that reads DRY_RUN). Unset, "0" or "1" only;
# a set-but-other value (true, yes, TRUE, 2, " 1", empty) FAILS rather than silently meaning "not dry-run" / "not allowed".
if [ -n "${DRY_RUN+x}" ] && [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then echo "FAIL: DRY_RUN must be 0 or 1"; exit 1; fi
if [ -n "${MONEY+x}" ] && [ "$MONEY" != 0 ] && [ "$MONEY" != 1 ]; then echo "FAIL: MONEY must be 0 or 1"; exit 1; fi
if [ -n "${ALLOW_BEHIND+x}" ] && [ "$ALLOW_BEHIND" != 0 ] && [ "$ALLOW_BEHIND" != 1 ]; then echo "FAIL: ALLOW_BEHIND must be 0 or 1"; exit 1; fi
PR=$1; REVIEW=$2; REVIEWED=$3; REVIEW2=${4:-}; R=repos/JDC000000/stem-loops; REPO=/home/claude/stem-loops; fail=0
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
# v3.6: money class = MONEY_RE path or [billing] title (jq; any read/parse error = money). Money => protected (every protected requirement).
prj=$(gh api $R/pulls/$PR) || prj=""
mn=$(money_meta "$prj") || mn=1
mpaths=""; [ -s "$fl" ] && mpaths=$(money_paths <"$fl" | head -5 | tr '\n' ' ')
pm=0; { [ "$mn" = 1 ] || [ -n "$mpaths" ] || [ ! -s "$fl" ] || [ "${MONEY:-0}" = 1 ]; } && pm=1   # MONEY=1 only raises
echo "money=$pm (${mpaths:-title/none})"
[ "$pm" = 1 ] && [ -z "$prot" ] && prot="money-class:${mpaths:-title/MONEY}"
protected_decision "$l" "$T" "$prot" "$PR" || fail=1
# v3.5: behind guard (v3.4 overlap/hot ∪ v3.4-R2 ALLOW_BEHIND/protected/≤5/coupled/deletions); see overlap_decision.
pp=1; is_protected_pr "$l" "$T" "$prot" || pp=0
review_pair_decision "$pp" "$pm" "$REVIEW" "$REVIEW2" "$REVIEWED" || fail=1
overlap_gate "$REPO" "$mb" "$bb" "$fl" "$pp" || fail=1
n=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '[.check_runs[]|select(.conclusion!="success" and .conclusion!="skipped")]|length')
[ "$n" = 0 ] || { echo "FAIL: $n checks not success/skipped"; fail=1; }
t=$(gh api "$R/commits/$H/check-runs?per_page=100" --jq '.total_count'); [ "${t:-0}" -ge 10 ] || { echo "FAIL: only ${t:-0} check-runs registered (need ≥10)"; fail=1; }
st=$(gh api "$R/commits/$H/status" --jq '[.statuses[]|select(.state!="success")]|length'); [ "${st:-1}" = 0 ] || { echo "FAIL: $st commit statuses not success"; fail=1; }
if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN fail=$fail (no merge)"; exit $fail; fi
[ $fail = 0 ] || { echo "NOT MERGED"; exit 1; }
main_unmoved "$apimain" || exit 1
put_out=$(gh api -X PUT $R/pulls/$PR/merge -f merge_method=squash -f sha="$H" --jq '"merged=\(.merged) sha=\(.sha)"' 2>&1) \
  || { echo "FAIL: merge PUT failed, NOT merged: $put_out"; exit 1; }
echo "$put_out"
case "$put_out" in *merged=true*) ;; *) echo "FAIL: merge PUT did not report merged=true: $put_out"; exit 1;; esac
ma=$(gh api $R/pulls/$PR --jq '"\(.merged_at) \(.merged_by.login)"') || { echo "FAIL: cannot re-read PR after merge PUT (merge unverified)"; exit 1; }
echo "merged_at merged_by = $ma"
{ [ -n "${ma%% *}" ] && [ "${ma%% *}" != null ]; } || { echo "FAIL: not merged (merged_at null after PUT)"; exit 1; }
