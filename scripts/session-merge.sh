#!/usr/bin/env bash
# session-merge.sh v1.1 (2026-11-28, session 24A, Jon L6 = LEDGER-24A row 10: PROTOCOL 2026-11-28 valid to 12-19T00:00Z, freeze end
#   12-03T01:00Z, CI watch 40 min, shared-file warning). v1.0 (2026-11-25, session 23A) — ONE gated merge for an A or a B session. Port of merge1-B.sh v2.5 (22B for 23B+,
# sha256 fd91a6a5…c45c0a) with the #414 protocol made symmetric and an unread-note ACK guard. Run it in the FOREGROUND.
# Usage: SESSION_TAG=23A|23B session-merge.sh <pr> <reviewed_sha_full> <review-1.md> <review-2.md>
#        SESSION_TAG=23A|23B session-merge.sh ack <comment-id>…      (orchestrators only: posts ONE "ACK <tag> <id>,<id>…" line on #414;
#          every id must be a NOTE/PROTOCOL/QUEUE comment of #414's last two pages, else exit 2 and nothing is posted)
#   Two different review files are required (standing approval A1). It wraps the canonical gate (scripts/or4-merge.sh, re-fetched from
#   v3/main right before DRY_RUN) and adds NO merge route and loosens no gate check.
# Env: SESSION_TAG (required, ^[0-9]{2}[AB]$) · BASE (default /home/claude/s23) · JON_ROW (default 95 = M-SA D-6 row; set Jon's own row
#   for a PR that needs one) · ALLOW_WINDOW=<#414 comment id> where the OTHER session agreed to let this one claim across the A/B block
#   rule (it never waives a DEPLOY slot, the freeze or a live claim) · BLOCKER=<issue no.> to merge an apps/** PR after the freeze ·
#   ACK_SINCE=<ISO time> cutoff for the unread-note guard (default: the oldest comment of the two-page window).
# Tags: 23A/23B-style or Jon ("DEPLOY Jon <sha7> until …" ended by "RELEASE DEPLOY Jon …" or "RELEASE Jon …"). Untagged CLAIM/DEPLOY
#   lines count as another session's and last until their "until"; a RELEASE without a session tag releases nothing.
# Protocol (see the CONFIG section): an A session may claim only when its whole 40-min claim window fits inside an A block; a B session
#   only when its window touches no A block; both refuse a window touching a DEPLOY slot and another session's live CLAIM/DEPLOY
#   (live until its "until", or 40 min after posting if none; 120 min if the "until" cannot be parsed — fail closed) unless that
#   session posted a later RELEASE. Freeze: any session's PR with an apps/ file, from FREEZE_AT until FREEZE_END, unless BLOCKER= is set.
# Shared files (v1.1): before claiming, prints "WARNING: open PR #N also changes: <files>" for every other open PR sharing a changed file
#   (a warning only; never refuses; the gate's overlap guard still applies).
# Unread-note guard: before claiming (and again before the gate), every #414 comment of the last two pages whose first line starts with
#   NOTE, PROTOCOL or QUEUE, posted at/after the cutoff, not by this session (first-line token 2 is EXACTLY the own tag:
#   write notes as "NOTE <author-tag> …"; "NOTE 23B: …" is not exempt for 23B) and not covered by an
#   "ACK <own tag> <id>[,<id>…]" line → exit 13, printing id + first line. Read the note, then `session-merge.sh ack <id…>`.
# Exit: 0 merged AND main CI all green (ack: posted) · 2 usage · 3 window busy / blocked by protocol or freeze · 4 un-draft refused ·
#   5 update-branch · 6 PR CI not green · 7 DRY_RUN fail or gate fetch failed · 8 merge failed · 9 main CI RED after merge (STOP ALL
#   MERGES, AGENTS.md M-5) · 10 main CI unknown/timeout after merge (check by hand before the next claim) · 11 #414 unreadable or a
#   #414 post failed · 12 merged but our RELEASE post failed (post it by hand) · 13 unread NOTE/PROTOCOL/QUEUE on #414 (ACK it first).
# A trap releases our claim on any exit; kill -9 or a box restart cannot be trapped: after a restart read #414 and release by hand.
# The trap's "INFO <tag> #P window abandoned" post is neither a protocol line nor an unread-note line (needs no ACK).
# Never edit or replace this file while a run is in progress.
set -uo pipefail

# ==================== PROTOCOL CONFIG — PROTOCOL 2026-11-28 (24A, Jon L6 = LEDGER-24A row 10; replaces PROTOCOL 2026-11-25) ====================
# Valid to 2026-12-18T16:00 Vancouver = 2026-12-19T00:00Z; after that every claim is refused (exit 3) until this section is renewed by PR.
# All times UTC, "HH:MM HH:MM" = [start, end) on every day.
PROTOCOL_ID="PROTOCOL 2026-11-28"
PROTOCOL_VALID_TO=2026-12-19T00:00:00Z
A_BLOCKS=("15:00 17:00" "21:00 22:00")      # A merge blocks: 08:00–10:00 and 14:00–15:00 Vancouver
DEPLOY_SLOTS=("18:00 18:30" "23:00 23:30")  # DEPLOY slots from 11:00 and 16:00 Vancouver, kept clear for 30 min
FREEZE_AT=2026-11-27T23:00:00Z              # apps/** freeze: Fri 2026-11-27 16:00 Vancouver …
FREEZE_END=2026-12-03T01:00:00Z             # … to Wed 2026-12-02 18:00 Vancouver, the end of the beta no-deploy window: [FREEZE_AT, FREEZE_END)
CLAIM_SECS=2400                             # a claim lasts 40 min
CI_WATCH_SECS=2400                          # wait up to 40 min for PR / main CI to complete (Chromium e2e takes 20–25 min)
# ============================================================================================================

R=JDC000000/stem-loops
usage(){ echo "usage: SESSION_TAG=23A|23B $0 <pr> <reviewed_sha_full> <review-1.md> <review-2.md>"; echo "       SESSION_TAG=23A|23B $0 ack <comment-id>…"; exit 2; }
[[ "${SESSION_TAG:-}" =~ ^[0-9]{2}[AB]$ ]] || { echo "SESSION_TAG must look like 23A or 23B"; usage; }
ME=$SESSION_TAG; SIDE=${ME: -1}
BASE=${BASE:-/home/claude/s23}; L=$BASE/git-net.lock; C=/home/claude/stem-loops; GATE=$BASE/or4-merge.sh; JR=${JON_ROW:-95}
TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT   # replaced by cleanup() below, which also removes $TMP
log(){ echo "[$(date -u +%T)] $*"; }
now(){ date -u +%s; }
epoch(){ date -u -d "$1" +%s 2>/dev/null; }
g(){ local o i; for i in 1 2 3 4 5; do o=$(gh api "$@" 2>"$TMP/g.err") && { printf '%s' "$o"; return 0; }; grep -qE 'HTTP 5[0-9][0-9]|No server|timeout' "$TMP/g.err" || { cat "$TMP/g.err" >&2; return 1; }; sleep 15; done; return 1; }
# the last two pages of #414 into $TMP/pa.json $TMP/pb.json; pages are ~300 KB: always files, never argv (E2BIG, handover R2)
pages(){ local n pg; n=$(g repos/$R/issues/414 --jq .comments) || return 1; [[ "$n" =~ ^[0-9]+$ ]] || return 1
  pg=$(( (n+99)/100 )); [ "$pg" -lt 1 ] && pg=1
  echo '[]' > "$TMP/pa.json"; [ "$pg" -gt 1 ] && { g "repos/$R/issues/414/comments?per_page=100&page=$((pg-1))" > "$TMP/pa.json" || return 1; }
  g "repos/$R/issues/414/comments?per_page=100&page=$pg" > "$TMP/pb.json" || return 1
  jq -es 'all(type=="array")' "$TMP/pa.json" "$TMP/pb.json" >/dev/null || return 1; }
# every comment of the window, oldest first, as "created_at|first line" (CR stripped)
firstlines(){ pages || return 1
  jq -rs '(.[0]+.[1])[]|"\(.created_at)|\((.body//"")|gsub("\r";"")|split("\n")[0])"' "$TMP/pa.json" "$TMP/pb.json"; }
# protocol lines (CLAIM/RELEASE/DEPLOY) only
recent(){ local f; f=$(firstlines) || return 1; grep -E '^[^|]*\|(CLAIM|RELEASE|DEPLOY) ' <<<"$f"; return 0; }
# post a #414 line once; on an ambiguous error, read back before retrying (no double CLAIM/RELEASE/ACK)
post414(){ local body=$1 i; for i in 1 2 3; do gh api -X POST repos/$R/issues/414/comments -f body="$body" --jq .id >/dev/null 2>"$TMP/p.err" && return 0
  sleep 10; firstlines 2>/dev/null | cut -d'|' -f2- | grep -qxF -- "$body" && return 0; done; cat "$TMP/p.err" >&2; return 1; }

# ---- ack subcommand ----
if [ "${1:-}" = ack ]; then
  shift; [ $# -ge 1 ] || usage
  ids=(); for x in "$@"; do [[ "$x" =~ ^[0-9]+$ ]] || { echo "comment id must be numeric: $x"; exit 2; }; ids+=("$x"); done
  # every id must be a comment of the two-page window whose first line starts with NOTE/PROTOCOL/QUEUE (same match as the guard)
  pages || { log "cannot read #414"; rm -rf "$TMP"; exit 11; }
  noteids=$(jq -rs '(.[0]+.[1])[] | select(((.body//"")|gsub("\r";"")|split("\n")[0]|sub("^[\\s*_>#`~|-]+";""))
      |test("^(NOTE|PROTOCOL|QUEUE)\\b";"i")) | .id' "$TMP/pa.json" "$TMP/pb.json") || { log "cannot read #414"; rm -rf "$TMP"; exit 11; }
  for x in "${ids[@]}"; do grep -qxF -- "$x" <<<"$noteids" || { echo "#414 comment $x is not a NOTE/PROTOCOL/QUEUE comment of the last two pages; nothing posted"; rm -rf "$TMP"; exit 2; }; done
  line="ACK $ME $(printf '%s\n' "${ids[@]}" | awk '!s[$0]++' | paste -sd,)"
  post414 "$line" || { log "ACK post failed"; rm -rf "$TMP"; exit 11; }
  log "posted: $line"; rm -rf "$TMP"; exit 0
fi

[ $# -eq 4 ] || usage
P=$1; RS=$2
[[ "$P" =~ ^[0-9]+$ ]] || { echo "pr must be numeric"; exit 2; }
RV1=$(realpath -e "$3") && RV2=$(realpath -e "$4") || { echo "review file missing"; exit 2; }
[ "$RV1" != "$RV2" ] || { echo "two different review files are required (A1)"; exit 2; }
[[ "$RS" =~ ^[0-9a-f]{40}$ ]] || { echo "reviewed sha must be the full 40-hex SHA"; exit 2; }
[ -z "${ALLOW_WINDOW:-}" ] || [[ "$ALLOW_WINDOW" =~ ^[0-9]+$ ]] || { echo "ALLOW_WINDOW must be a #414 comment id"; exit 2; }
[ -z "${BLOCKER:-}" ] || [[ "$BLOCKER" =~ ^[0-9]+$ ]] || { echo "BLOCKER must be an issue number"; exit 2; }
CUT=""; if [ -n "${ACK_SINCE:-}" ]; then CUT=$(date -u -d "$ACK_SINCE" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || { echo "ACK_SINCE is not a date: $ACK_SINCE"; exit 2; }; fi
mkdir -p "$BASE/reviews"; touch "$L"

# unread NOTE/PROTOCOL/QUEUE comments → "id<TAB>first line"; rc 1 none, 0 some, 2 #414 unreadable
unread(){ local acked cand; pages || return 2
  acked=$(jq -rs --arg me "$ME" '(.[0]+.[1])[]|(.body//"")|gsub("\r";"")|split("\n")[]
      |capture("^ACK (?<t>[^ ]+) (?<ids>[0-9]+(,[0-9]+)*)\\s*$")?|select(.t==$me)|.ids|split(",")[]' "$TMP/pa.json" "$TMP/pb.json") || return 2
  cand=$(jq -rs --arg me "$ME" --arg cut "$CUT" '(.[0]+.[1]) as $all | ($all|map(.created_at)|min) as $start
      | $all[] | select(.created_at >= (if $cut=="" then $start else $cut end))
      | ((.body//"")|gsub("\r";"")|split("\n")[0]) as $l | ($l|sub("^[\\s*_>#`~|-]+";"")) as $s
      | select($s|test("^(NOTE|PROTOCOL|QUEUE)\\b";"i"))
      | select((($s|split(" ")|map(select(.!=""))|.[1]) // "") != $me)   # own note only if token 2 is exactly our tag
      | "\(.id)\t\($l)"' "$TMP/pa.json" "$TMP/pb.json") || return 2
  cand=$(awk -F'\t' 'NR==FNR{if($0!="")a[$0]=1;next} $1!="" && !($1 in a)' <(printf '%s\n' "$acked") <(printf '%s\n' "$cand"))
  [ -n "$cand" ] || return 1; printf '%s\n' "$cand"; return 0; }

expiry(){ # $1 created_at, $2 line → epoch the line expires
  local ca=$1 ln=$2 u c0 e; c0=$(epoch "$ca") || { echo 9999999999; return; }
  u=$(grep -oE 'until [^ ]+' <<<"$ln" | head -1 | cut -d' ' -f2)
  if [ -z "$u" ]; then echo $((c0+CLAIM_SECS)); return; fi
  if [[ "$u" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$ ]]; then e=$(epoch "$u") && { echo "$e"; return; }; fi
  if [[ "$u" =~ ^([0-9]{2}:[0-9]{2})(:[0-9]{2})?Z$ ]]; then e=$(epoch "${ca%%T*}T${BASH_REMATCH[1]}:00Z") && { [ "$e" -lt "$c0" ] && e=$((e+86400)); echo "$e"; return; }; fi
  echo $((c0+7200)); }
other_live(){ # prints the first live CLAIM/DEPLOY of another session, if any
  local lines ca ln who t; lines=$(recent) || return 2; t=$(now)
  local -A rel=() relany=(); local subj
  while IFS= read -r x; do [ -z "$x" ] && continue; ca=${x%%|*}; ln=${x#*|}; who=$(awk '{print $2}' <<<"$ln"); subj=$(awk '{print $3}' <<<"$ln")
    [[ "$ln" == "RELEASE DEPLOY "* ]] && { who=$subj; subj=deploy; }   # Jon's form: "RELEASE DEPLOY Jon <sha> …"
    [[ "$who" =~ ^([0-9]{2}[AB]|Jon)$ ]] || continue   # a RELEASE without a session tag releases nothing
    case "$ln" in RELEASE*) rel["$who $subj"]=$(epoch "$ca"); relany[$who]=$(epoch "$ca");; esac; done <<<"$lines"
  while IFS= read -r x; do [ -z "$x" ] && continue; ca=${x%%|*}; ln=${x#*|}; who=$(awk '{print $2}' <<<"$ln"); subj=$(awk '{print $3}' <<<"$ln")
    [[ "$who" =~ ^([0-9]{2}[AB]|Jon)$ ]] || { who="?"; subj="?"; }   # untagged lines count as another session's
    case "$ln" in CLAIM*|DEPLOY*) [ "$who" = "$ME" ] && continue
      # a CLAIM ends with that session's RELEASE of the same subject (#pr); a DEPLOY with any later RELEASE of that session
      if [[ "$ln" == CLAIM* ]]; then [ "${rel["$who $subj"]:-0}" -ge "$(epoch "$ca")" ] && continue
      else [ "${relany[$who]:-0}" -ge "$(epoch "$ca")" ] && continue; fi
      [ "$t" -le "$(expiry "$ca" "$ln")" ] && { echo "$ln"; return 0; };; esac; done <<<"$lines"
  return 1; }
window_bad(){ # $1 start, $2 end (epochs, [start,end)) → prints why the window is not ours to use; rc 0 = refused
  local s0=$1 e0=$2 d day s e w inside=0; d=$(date -u -d "@$s0" +%F)
  [ "$s0" -lt "$(epoch $PROTOCOL_VALID_TO)" ] || { echo "$PROTOCOL_ID expired at $PROTOCOL_VALID_TO (renew the CONFIG section by PR)"; return 0; }
  for day in "$(date -u -d "$d -1 day" +%F)" "$d" "$(date -u -d "$d +1 day" +%F)"; do
    for w in "${DEPLOY_SLOTS[@]}"; do set -- $w; s=$(epoch "${day}T$1:00Z"); e=$(epoch "${day}T$2:00Z")
      [ "$s0" -lt "$e" ] && [ "$e0" -gt "$s" ] && { echo "DEPLOY slot ${day}T$1Z–$2Z"; return 0; }; done
    for w in "${A_BLOCKS[@]}"; do set -- $w; s=$(epoch "${day}T$1:00Z"); e=$(epoch "${day}T$2:00Z")
      if [ "$SIDE" = B ]; then [ -z "${ALLOW_WINDOW:-}" ] && [ "$s0" -lt "$e" ] && [ "$e0" -gt "$s" ] && { echo "A block ${day}T$1Z–$2Z"; return 0; }
      else [ "$s0" -ge "$s" ] && [ "$e0" -le "$e" ] && inside=1; fi; done; done
  [ "$SIDE" = A ] && [ "$inside" = 0 ] && [ -z "${ALLOW_WINDOW:-}" ] && { echo "outside every A block (${A_BLOCKS[*]} UTC)"; return 0; }
  return 1; }
# the freeze covers apps/** only (WORKPLAN §3): a PR with no apps/ file (e.g. docs/perf, packages/) is not frozen
frozen(){ local t; t=$(now); [ "$t" -ge "$(epoch $FREEZE_AT)" ] && [ "$t" -lt "$(epoch $FREEZE_END)" ] && [ -z "${BLOCKER:-}" ] && [ "${APPS_FILES:-1}" != 0 ]; }
# shared-file WARNING (never a refusal): names every other open PR that changes a file this PR changes. Unreadable listings are
# reported and skipped; the gate's own overlap/hot-file guard (or4-merge.sh) still runs at DRY_RUN.
shared_warn(){ local mine others n f s
  mine=$(g "repos/$R/pulls/$P/files?per_page=100" --jq '.[].filename' | sort -u) || { log "WARN shared-file check skipped (#$P files unreadable)"; return 0; }
  others=$(g "repos/$R/pulls?state=open&per_page=100" --jq '.[].number') || { log "WARN shared-file check skipped (open PRs unreadable)"; return 0; }
  for n in $others; do [[ "$n" =~ ^[0-9]+$ ]] || continue; [ "$n" = "$P" ] && continue
    f=$(g "repos/$R/pulls/$n/files?per_page=100" --jq '.[].filename' | sort -u) || { log "WARN shared-file check: #$n files unreadable"; continue; }
    s=$(comm -12 <(printf '%s\n' "$mine") <(printf '%s\n' "$f") | grep -v '^$' | paste -sd' ')
    [ -n "$s" ] && log "WARNING: open PR #$n also changes: $s"; done
  return 0; }
protocol_block(){ local t; t=$(now); window_bad "$t" $((t+CLAIM_SECS)) && return 0
  frozen && { echo "apps/** freeze since $FREEZE_AT (set BLOCKER=<issue>)"; return 0; }; return 1; }
CLAIMED=0; DONE=0; TAKEN=0
cleanup(){ if [ "$CLAIMED" = 1 ] && [ "$DONE" = 0 ]; then
    if [ "$TAKEN" = 1 ]; then post414 "INFO $ME #$P window abandoned (another session's claim is live; this is not a RELEASE)"; else post414 "RELEASE $ME #$P not merged (aborted)"; fi; fi
  rm -rf "$TMP"; }
trap cleanup EXIT
RELFAIL=0
fin(){ DONE=1; if post414 "RELEASE $ME #$P $1"; then log "RELEASE: $1"; else RELFAIL=1; log "RELEASE POST FAILED — post by hand on #414: RELEASE $ME #$P $1"; fi; }
notes_gate(){ # $1 = "pre" (before claim) or "held" (claim held: release first); exits on unread notes / unreadable #414
  local u rc; u=$(unread); rc=$?
  [ $rc -eq 2 ] && { [ "$1" = held ] && fin "not merged (#414 unreadable)"; log "cannot read #414"; exit 11; }
  [ $rc -eq 0 ] && { log "UNREAD #414 notes (read them, then: SESSION_TAG=$ME $0 ack <id…>):"; printf '%s\n' "$u" | tr '\t' ' ' | sed 's/^/  /'
    [ "$1" = held ] && fin "not merged (unread #414 note)"; exit 13; }
  return 0; }

APPS_FILES=$(g "repos/$R/pulls/$P/files?per_page=100" --jq 'if length>=100 then 1 else [.[].filename|select(startswith("apps/"))]|length end') || APPS_FILES=1
[[ "$APPS_FILES" =~ ^[0-9]+$ ]] || APPS_FILES=1
shared_warn
notes_gate pre
why=$(protocol_block) && { log "protocol: $why"; exit 3; }
o=$(other_live); rc=$?; [ $rc -eq 2 ] && { log "cannot read #414"; exit 11; }; [ $rc -eq 0 ] && { log "OTHER LIVE: $o"; exit 3; }
U=$(date -u -d "@$(( $(now) + CLAIM_SECS ))" +%Y-%m-%dT%H:%MZ)
post414 "CLAIM $ME #$P until $U" || { log "claim post failed"; exit 11; }; CLAIMED=1; sleep 3
o=$(other_live); rc=$?; [ $rc -eq 0 ] && { TAKEN=1; log "race: $o"; exit 3; }; [ $rc -eq 2 ] && exit 11
log "claimed until $U"
g -X POST repos/$R/pulls/$P/ccr/ready_for_review --jq '"draft=\(.draft)"' || { fin "not merged (un-draft refused)"; exit 4; }
H=$(g repos/$R/pulls/$P --jq .head.sha) && B=$(g repos/$R/compare/v3/main...$H --jq .behind_by) || exit 11
log "head ${H:0:7} behind=$B"
if [ "$B" != 0 ]; then g -X PUT repos/$R/pulls/$P/update-branch --jq .message || log "update-branch errored; re-reading"
  H2=$H; for i in $(seq 1 30); do sleep 6; H2=$(g repos/$R/pulls/$P --jq .head.sha) || continue; [ "$H2" != "$H" ] && break; done
  B=$(g repos/$R/compare/v3/main...$H2 --jq .behind_by); { [ "$H2" != "$H" ] && [ "$B" = 0 ]; } || { fin "not merged (update-branch)"; exit 5; }
  H=$H2; log "new head ${H:0:7}"; sleep 20; fi
cistate(){ # → "green N" | "red …" | "unknown …"
  local S=$1 o i; for i in $(seq 1 $(( CI_WATCH_SECS / 20 ))); do o=$(g "repos/$R/commits/$S/check-runs?per_page=100" --jq '"\([.check_runs[]|select(.status!="completed")]|length) \(.check_runs|length)"') || { sleep 20; continue; }
    set -- $o; [ "$1" = 0 ] && [ "$2" -ge 10 ] && break; sleep 20; done
  o=$(g "repos/$R/commits/$S/check-runs?per_page=100" --jq '[.check_runs[]|{s:.status,c:(.conclusion//"none")}] as $r | if ($r|length)<10 or ([$r[]|select(.s!="completed")]|length)>0 then "unknown \($r|length)" elif ([$r[]|select(.c!="success" and .c!="skipped" and .c!="neutral")]|length)>0 then "red " + ([$r[]|.c]|unique|join(",")) else "green \($r|length)" end') || o="unknown read-error"
  echo "$o"; }
r=$(cistate $H); log "PR CI $r"; [[ "$r" == green* ]] || { fin "not merged (PR CI: $r)"; exit 6; }
o=$(other_live); rc=$?; [ $rc -eq 0 ] && { TAKEN=1; log "window taken: $o"; exit 3; }; [ $rc -eq 2 ] && exit 11
notes_gate held
frozen && { fin "not merged (freeze)"; exit 3; }
# re-check our own window right before the gate: claim not about to expire, still allowed for this side, not frozen
[ "$(now)" -lt "$(( $(epoch "${U/Z/:00Z}") - 120 ))" ] || { fin "not merged (own claim expiring; re-claim)"; exit 3; }
t=$(now); why=$(window_bad "$t" $((t+1))) && { fin "not merged (now: $why)"; exit 3; }
rm -f "$GATE"; flock "$L" git -C $C fetch -q --depth=1 origin v3/main && git -C $C show origin/v3/main:scripts/or4-merge.sh > "$GATE" && [ -s "$GATE" ] || { fin "not merged (gate fetch failed)"; exit 7; }
cd $C && git checkout -q --detach origin/v3/main || { fin "not merged (checkout)"; exit 7; }
DR=$BASE/reviews/PR$P-DRYRUN.txt
DRY_RUN=1 JON_ROW=$JR JON_PR=$P bash "$GATE" $P "$RV1" $RS "$RV2" > $DR 2>&1; drc=$?; cat $DR
# the gate's exact summary line (or4-merge.sh: echo "DRY_RUN fail=$fail (no merge)") AND its exit code 0
{ [ "$drc" = 0 ] && grep -qxF "DRY_RUN fail=0 (no merge)" $DR; } || { fin "not merged (DRY_RUN rc=$drc)"; exit 7; }
(echo '```'; cat $DR; echo '```') > "$TMP/dr$P.md"
for f in "$RV1" "$RV2" "$TMP/dr$P.md"; do gh api -X POST repos/$R/issues/$P/comments -F body=@"$f" --jq .id >/dev/null || { fin "not merged (could not post $(basename "$f") on the PR)"; exit 7; }; done
JON_ROW=$JR JON_PR=$P bash "$GATE" $P "$RV1" $RS "$RV2" 2>&1 | tail -3
M=$(g repos/$R/pulls/$P --jq 'if .merged then .merge_commit_sha else "" end') || { fin "merge state UNKNOWN (PR read failed; check #$P by hand)"; exit 8; }
[ -n "$M" ] || { fin "not merged (gate/PUT)"; exit 8; }
fin "merged ${M:0:7}"; sleep 30
r=$(cistate $M); log "main CI on ${M:0:7}: $r"
case "$r" in red*) log "MAIN RED — stop all merges; re-run once only a job that failed on a GitHub/runner error"; exit 9;; esac
[ "$RELFAIL" = 1 ] && { log "merged, but the RELEASE is missing on #414 (exit 12)"; exit 12; }
case "$r" in green*) exit 0;; *) exit 10;; esac
