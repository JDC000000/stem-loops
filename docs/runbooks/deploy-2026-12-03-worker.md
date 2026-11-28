# Runbook: worker deploy Thu 2026-12-03 18:00Z (11:00 on the protocol's UTC−7 Vancouver clock), 24B post-freeze batch

One-off plan for session 24A. It documents; it grants nothing. Times: UTC is canonical. The
#414 PROTOCOL in `scripts/session-merge.sh` reads Vancouver as UTC−7 (18:00Z = 11:00); if a
local clock shows PST (UTC−8), 18:00Z is 10:00 there. Use the Z time. Sources read 2026-11-28:
`.github/workflows/deploy.yml`, `scripts/ci_green_gate.py`, `scripts/session-merge.sh`
(PROTOCOL 2026-11-28), `docs/runbooks/deploy-rollback.md`, `apps/worker/Dockerfile` and
`apps/worker/fly.toml` at v3/main 75ea4e9, draft PRs #509 / #504 / #501, issues #511 / #502.
General rollback rules stay in [deploy-rollback.md](deploy-rollback.md); this page only adds
what is specific to this batch.

**What ships (worker only, `target=worker`):**

| PR | Worker change | Needs a post-deploy proof |
|---|---|---|
| #509 | BTC chord provider (opt-in) + Dockerfile layer that fetches the BTC weights at build with `--soft` | weights file really in the image (§4) |
| #504 | videos over ~36 min cut to the first 5 min at download (`--download-sections "*0-300"`); 120 s R2 stage limit | the >36-min smoke song (§6, #511) |
| #501 | Klangio K-2 breaker: connect failures and 5xx/429 submit POSTs count | none live (unit-tested; no fault injection in prod) |
| #516 | tests only | none |

**Not part of this deploy:**
- **`CHORDS_PROVIDER=btc` is Jon's switch and is NOT flipped here.** Prod stays on `klangio`
  (the default; `fly.toml` and secrets are untouched by #509). Jon's command, if and when he
  decides: `fly secrets set CHORDS_PROVIDER=btc -a stem-loops` (restarts the worker; drain
  rules apply). Nobody else runs it.
- Web: #509 also allowlists provider `btc` in `apps/web` (`api/chord-edits`). That only matters
  once BTC is switched on; a web deploy is Jon's (A2 not active) and is not in this plan.
- Web-only PRs merged in the same window (#503 #506 #507 #508 #510) are **not** deployed by
  `target=worker`; the ledger must not list them as shipped.
- No migration. No open PR adds a file under `apps/worker/migrations/` (as of 2026-11-28: all
  open PRs checked, #501–#521; only #501 #504 #509 #516 touch `apps/worker/`). Repo last =
  `045_v3_jobs_retry_of.sql`. Re-check in §1 step 5.

## 0 · Authority (check before anything else)

AGENTS.md (D-7, A2 row) and deploy-rollback.md say **A sessions never deploy**, and **A2 is NOT
ACTIVE** in the repo copy. For this one deploy that rule is overridden **for 24A only**:

- **Dispatch: Jon L4 (LEDGER-24A row 8)** authorises session 24A's orchestrator to dispatch
  `deploy.yml` with `--ref v3/main -f target=worker` in the 2026-12-03 18:00Z slot, and then to
  run one A2b smoke song (≤ 2/day) and record the VERIFY row (§7).
- **Not covered by L4 (all stay Jon's):** web deploys and `target=web|all`; secrets and env;
  Fly settings, `fly.toml`, scaling, `fly ssh`; `CHORDS_PROVIDER`; the Fly fast-path rollback;
  any other session, day or slot.
- **Before 17:30Z** the VERIFY row quotes L4 verbatim with its row number.

Two separate rules:

1. **Dispatch stop rule.** If L4 cannot be found on LEDGER-24A, or its words do not cover a
   worker dispatch by 24A on 12-03: do not dispatch; hand this plan to Jon (or 24B's D-7 path)
   and stop.
2. **Smoke rule (§6).** Covered by L4's smoke clause. If, when read, L4 does not name the
   smoke song and A2 is not active: still deploy, skip §6, write "unverified until next real
   job" for A2 (3), and leave #511 open. The smoke rule never stops the dispatch.

A refused dispatch is OR-1: record, tell Jon, no re-route (no `make deploy-worker`, no local
`flyctl`).

## 1 · Pre-checks (17:30Z–18:00Z)

1. **Batch merged.** #509, #504, #501 merged into v3/main by 24B after the freeze end
   (2026-12-03T01:00Z). Record each merge SHA. If #509 is not merged, skip §4; if #504 is not
   merged, the smoke song is not a #511 test (§6).
2. **Which SHA.** `SHA=$(gh api repos/JDC000000/stem-loops/commits/v3/main --jq .sha)`.
   The deploy uses the head of `v3/main` at dispatch time; record it in full and as sha7.
3. **Main green on that SHA.** Every check-run complete and green:
   `gh api --paginate "repos/JDC000000/stem-loops/commits/$SHA/check-runs?filter=latest&per_page=100" --jq '.check_runs[] | [.name,.status,.conclusion] | @tsv'`
   (`filter=latest`, as the gate uses, so an old failed attempt of a re-run job is not read as red).
   All `completed` + `success` (or `skipped` for non-required). Anything still running: wait;
   the gate (`scripts/ci_green_gate.py`) will fail it anyway, and a red gate is never re-run.
4. **No merge pending behind the SHA.** No live CLAIM on #414 from either session; 24B has
   finished its batch. Merges stop from the DEPLOY post until RELEASE.
5. **Migrations (A3, read by 24A).** One bare SELECT on prod (`qthrhamfljhifhfwvvwj`), logged
   with purpose in LEDGER-24A:
   `SELECT filename FROM public._migrations ORDER BY filename DESC LIMIT 1;`
   Pass: `045_v3_jobs_retry_of.sql` = repo last (`ls apps/worker/migrations/*.sql | tail -1` at
   `$SHA`). Also confirm no 24B PR in the batch added a migration
   (`git diff --name-only 75ea4e9 $SHA -- apps/worker/migrations` is empty). Any mismatch: stop,
   tell Jon (never deploy with a pending migration).
6. **Idle-ish queue (A3, optional, same budget).**
   `SELECT status, count(*) FROM public.jobs WHERE status NOT IN ('done','failed') GROUP BY 1;`
   A job in flight is fine (graceful drain, `kill_timeout = 300`), but note it.
7. **Fly baseline (Jon).** The current release number and image ref
   (`fly releases --app stem-loops --image`) are the fast-path rollback target. Ask Jon for them
   before 17:50Z and write them into the VERIFY row. **No dispatch without them** unless Jon
   says go without; then the rollback reads them from the release list (the one before ours).

## 2 · #414 DEPLOY claim (orchestrator only)

Format (deploy-rollback.md §4, parsed by `scripts/session-merge.sh` `other_live()`):

```
DEPLOY 24A <sha7> until 2026-12-03T19:30Z
```

- Token 2 must be exactly `24A`; `until` must be `YYYY-MM-DDTHH:MMZ` (an unparsable `until`
  is treated as 120 min). 19:30Z covers build (~10 min), the weights check, the smoke job and
  the post-deploy check (≤ 30 min after the job).
- The claim ends at **any later `RELEASE 24A …` line** (session-merge.sh ends a DEPLOY on any
  RELEASE of that session), so post no other RELEASE until the deploy is done. Release line:
  `RELEASE 24A deploy <sha7> ok` or `RELEASE 24A deploy <sha7> rolled back`.
- The DEPLOY slot 18:00–18:30Z is already closed to merges by PROTOCOL 2026-11-28.

## 3 · Dispatch (18:00Z, foreground)

Real input names in `deploy.yml`: `target` (choice `all | web | worker`, default **`all`**, so
it must be given) and `gate_only` (boolean, default false).

```bash
R=JDC000000/stem-loops
SHA=$(gh api repos/$R/commits/v3/main --jq .sha)   # re-read AFTER the DEPLOY post; if it moved, redo §1 step 3 on it
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)                  # record T0 in the VERIFY row
gh workflow run deploy.yml --repo $R --ref v3/main -f target=worker
RUN=""
for i in 1 2 3 4 5 6; do sleep 10
  RUN=$(gh api "repos/$R/actions/workflows/deploy.yml/runs?branch=v3/main&event=workflow_dispatch&head_sha=$SHA&per_page=10" \
    --jq "[.workflow_runs[] | select(.created_at >= \"$T0\")] | sort_by(.created_at) | .[0] // empty | \"\(.id) \(.head_sha) \(.created_at)\"")
  [ -n "$RUN" ] && break; done
echo "$RUN"
[ -n "$RUN" ] || { echo "STOP: no new run within 60 s (do NOT dispatch again; tell Jon)"; exit 1; }
[ "$(cut -d' ' -f2 <<<"$RUN")" = "$SHA" ] || { echo "STOP: head_sha != SHA"; exit 1; }
gh run watch "${RUN%% *}" --repo $R --exit-status
gh api "repos/$R/actions/runs/${RUN%% *}/jobs" --jq '.jobs[] | [.name,.conclusion] | @tsv'
```

- The run is accepted only if **both** `head_sha = $SHA` and `created_at ≥ T0`. An older run
  on the same SHA (a G-1 `gate_only` run, or a red-gate run) fails the `T0` filter. No new run
  within 60 s, or a mismatch: stop and tell Jon; never dispatch a second time to "find" it.
- A green run whose `Deploy Worker to Fly.io` job is **skipped** is the wrong run (or
  `gate_only`): nothing was deployed.
- Expected jobs: `CI green gate (deployed SHA on v3/main)` success, `Ruleset drift warning
  (non-blocking)` (warning only, ignored), `Deploy Web to Vercel` **skipped**, `Deploy Worker
  to Fly.io` success.
- Red gate: wait for main CI, dispatch a **new** run. Never `gh run rerun`, never "re-run
  failed jobs" on a deploy run.
- Deploy job red: if the **build** failed, the old image keeps running. If it failed later
  (release / Machine update), the worker may be down: `fly.toml` records 2026-11-09, when a
  deploy left zero Machines. Probe `/health` (§5) at once; not 200 = tester-facing outage:
  message Jon for the fast path (§8) now. In both cases release the claim, ledger it, tell
  Jon; no retry before the cause is known.

## 4 · BTC weights really in the image (#509)

Why: `RUN python /tmp/fetch_btc_weights.py --soft /app/models/btc/btc_model_large_voca.pt`
exits 0 even when the download or the checksum fails (it prints a WARNING and leaves no
file). The build is green either way. Expected file: `/app/models/btc/btc_model_large_voca.pt`,
**12,229,576 bytes**, sha256
`1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51` (pinned in
`apps/worker/scripts/fetch_btc_weights.py` `SHA256`/`SIZE` and `chord_providers/btc.py`
`BTC_WEIGHTS_SHA256`; the Dockerfile itself carries no hash). Source: jayg996/BTC-ISMIR19
@ 2682317, `test/btc_model_large_voca.pt`.

**4a · Deploy job log (24A, read-only GET, no Jon needed).**

```bash
JOB=$(gh api "repos/JDC000000/stem-loops/actions/runs/${RUN%% *}/jobs" --jq '.jobs[] | select(.name=="Deploy Worker to Fly.io") | .id')
LOG=$(mktemp -p /home/claude/s24/deploy 24A-deploy-worker.XXXXXX.log)
gh api "repos/JDC000000/stem-loops/actions/jobs/$JOB/logs" > "$LOG"
grep -nE 'btc weights (fetched and verified|already present|NOT installed)|fetch_btc_weights|CACHED' "$LOG"
```

| Log shows | Meaning | Next |
|---|---|---|
| `btc weights fetched and verified: /app/models/btc/btc_model_large_voca.pt` | size + sha256 matched at build | pass 4a; 4b still wanted |
| `WARNING: btc weights NOT installed (…)` | soft failure: **no file** in the image | BTC unusable; Klangio unaffected; not a rollback. Tell Jon; see "sticky cache" below |
| a `CACHED` line with the same `#N` as the `#N … fetch_btc_weights` step header (no print line; other steps' `CACHED` lines don't count) | layer reused from an earlier build; the log proves nothing | 4b is required |
| no line about the step at all | flyctl did not stream that output | 4b is required |

**Sticky cache:** the layer's cache key is the `COPY`'d script, the `RUN` line and its parent
layers (base image, `requirements.txt` / `constraints-prod.txt`), not the download result. A
soft-failed layer is cached **without** the file and later builds reuse it until the script,
the line or a parent layer changes, the remote builder's cache is dropped, or Jon deploys with
`--no-cache`. So a
WARNING (or a CACHED step after an earlier WARNING) is not fixed by re-dispatching.

**4b · In the running Machine (Jon: `fly ssh console` is Fly access, not a session's).**

```bash
fly ssh console -a stem-loops -C "ls -l /app/models/btc/btc_model_large_voca.pt"
fly ssh console -a stem-loops -C "sha256sum /app/models/btc/btc_model_large_voca.pt"
# or the worker's own check (raises BtcWeightsMissing on missing/mismatch):
fly ssh console -a stem-loops -C "env PYTHONPATH=/app python -c 'from src.worker.chord_providers.btc import verify_weights, weights_path; print(weights_path(), verify_weights(weights_path()))'"
```

(`fly ssh console -C` may not start in the image's `WORKDIR` `/app`, hence absolute paths and
`PYTHONPATH=/app`; the image runs `python -m src.worker.main` from `/app`.) Pass: size
`12229576` and the sha256 above. Either 4a "fetched and verified" or 4b pass is enough to
record "weights present"; 4b is the only proof when the step was CACHED or not shown. If 4a
has no "fetched and verified" line and nobody with Fly access runs 4b before the VERIFY row is
due, write **`weights present: UNVERIFIED`**; never infer it from a green build. A missing
file never blocks the deploy result (prod is on Klangio) but blocks Jon's BTC switch.

**Optional, Jon only, not part of the deploy check:** one BTC run on an already-separated
song without changing the live setting, e.g. `python -m src.worker.chord_eval --provider btc …`
inside `fly ssh console` after `cd /app` (arguments per `chord_eval --help`). The live setting stays klangio.

## 5 · /health (liveness only)

```bash
curl -fsS https://stem-loops.fly.dev/health
```

Pass: HTTP 200, `"status":"ok"`, `"sentry":"on"`, top-level `fetch_canary.ok` true (it is
false if either the proxy or the youtube check failed), or null right after boot. Record
`fetch_canary.proxy.ok` and `fetch_canary.youtube.ok` too: the smoke depends on YouTube.
Probe within 10 min of the deploy job going green (AGENTS.md D-7); if the canary is still
null, re-probe at 15 min, because the proxy check runs every 900 s (`fetch_canary.py`
`DEFAULT_INTERVAL_S`). This knowingly differs from D-7's 10 min for the canary value only. `/health` is DB-free and is **not** the post-deploy check
(A2 (3)); it can only add a failure (deploy-rollback.md, "do the stricter").

## 6 · Smoke song: one >36-min video (A2b(a), #511)

Covered by L4's smoke clause (§0 rule 2; if not covered, skip this section). ≤ 2 smoke
jobs/day; this is 1.

**Target (album + channel, fixed):** Kimiko Ishizaka's public-domain Bach recordings on her
official YouTube channel **OpenGoldberg**.

- **Primary:** *Well-Tempered Clavier (J.S. Bach), Book 1, Kimiko Ishizaka, piano*,
  `https://www.youtube.com/watch?v=nPHIZw7HZq4`. ID checked 2026-11-28 by YouTube oEmbed
  (fetched via Tavily extract): title as above, `author_name` OpenGoldberg. Chapters list 24
  prelude/fugue pairs, the last (b minor) starting 1:41:01, so ≈ 1 h 49 min (not measured).
  Licence: the Open Well-Tempered Clavier project released the recording into the public domain
  (2015; Wikimedia Commons category "Open Well-Tempered Clavier"). First 5 min = Prelude and
  Fugue in C major: clear tonal harmony.
- **Backup:** *Goldberg Variations Complete (J.S. Bach BWV 988), with score, Kimiko Ishizaka
  piano*, `https://www.youtube.com/watch?v=15ezpwCHtJs`. ID checked 2026-11-28 the same way
  (title as above, `author_name` OpenGoldberg). Last chapter "Aria da Capo" starts 1:19:32, so
  ≈ 1 h 22 min (not measured). Licence: CC0 (opengoldbergvariations.org). First 5 min = the
  Aria in G major.
- One reviewer's web fetch of the primary ID returned a different video, and no session can
  play YouTube itself. So the IDs are **not trusted until the pre-flight below passes on
  12-03**.

**Pre-flight (24A, before submitting; no job created).** For the URL to be used, record in the
VERIFY row: title, channel, exact duration in seconds, licence evidence, and how each was read
(for example oEmbed for title/channel; a human opening the page, or the YouTube page's
`lengthSeconds`, for the duration). Use the video only if **all** hold:
1. the title is Ishizaka's *Well-Tempered Clavier Book 1* / *Goldberg Variations* and the
   channel is OpenGoldberg;
2. the duration is **≥ 2400 s** (40 min; margin over #504's 2160 s threshold);
3. the licence evidence is CC0 / public domain (project page or Commons, as above).

If the primary fails, try the backup. If both fail, do not submit: pick another
OpenGoldberg full-album upload (for example *Art of Fugue, Complete*) that passes 1–3, or skip
§6 and say why in the VERIFY row. Record the link used (A2b: a fixed public test song).

Submit once, signed out, by pasting the link at `https://stem-loops.com`, after §3 is green,
§5 passes and the new Machine is up. Then (A3 reads, logged; use the ID actually submitted):

```sql
SELECT id, status, error_code, created_at, updated_at FROM public.jobs
 WHERE youtube_url LIKE '%<video id>%' AND created_at > '<deploy finished, UTC>' ORDER BY created_at DESC LIMIT 1;
SELECT stage, phase, detail FROM public.job_events WHERE job_id = '<id>' AND detail ? 'trimmed';
```

Also (no DB): `GET https://stem-loops.com/api/jobs/<id>` → `input_trim_used_sec`,
`input_trim_source_sec`.

**Expected:** `status = 'done'` within 30 min; `job_events.detail` =
`{"trimmed": true, "source_sec": <within 2 s of the measured duration>, "used_sec": ~300}`
(same values in `input_trim_*_sec`); the job page `/jobs/<id>` shows the trim note with the
**true** length, which `input-trim.ts` `clock()` renders in minutes (for 6540 s:
"Using the first 5:00 of a 109:00 track."), and its stems are listed; chords present
(`jobs/<id>/play.chords.json` in R2, provider klangio). A signed-out page may not offer play;
playing it is not part of the check. This is the `--download-sections` leg through the sticky
proxy that unit tests cannot prove.

| Result | Meaning | Action |
|---|---|---|
| `done`, trimmed, true length | #504 works live; also satisfies A2 (3)'s "real job" | close #511 with the evidence |
| `failed`, `DOWNLOAD_TIMEOUT` / `FETCH_PROXY_FAILED` | section download did not work through the proxy, **or** the length probe returned nothing (then no cut is made and the full fetch runs): check the worker log for a duration reading / `input_trimmed` before blaming the section download | not a rollback by itself (≤ 36-min songs are unchanged); tell Jon, comment on #511 via 24A, try the backup only if the cause looks link-specific (2nd and last smoke of the day) |
| `failed`, `INTERNAL_ERROR` `r2_stage_timeout` | new 120 s R2 bound hit | refunded by design; tell Jon |
| `done` but `source_sec` ≈ 300 or null (no true length) | trimming works, true-length report does not | file an issue; no rollback |
| any ≤ 36-min tester job failing after the deploy | regression | deploy-rollback.md §1 failure → §2/§3 |

## 7 · Post-deploy check and VERIFY row

Pass needs all of deploy-rollback.md §1 (jobs green, deployed SHA = dispatched head, a job
created after the deploy reaches `done` with a chord file within 30 min). The smoke job may be
that job. Ledger (LEDGER-24A), one VERIFY row:

| Field | Value |
|---|---|
| time | T0 (dispatch), run created_at, finish, UTC |
| authority | Jon L4 (LEDGER-24A row 8), quoted verbatim; smoke covered by L4 (or "smoke skipped", why) |
| #414 | DEPLOY comment id, RELEASE comment id |
| SHA | dispatched `v3/main` head (full) = run `head_sha`; PRs included (#509 #504 #501 #516 + merge SHAs) |
| run | deploy run URL; gate / worker job conclusions; web job skipped |
| migrations | A3 query, result (`045_v3_jobs_retry_of.sql`), repo last at SHA |
| Fly | release before (rollback target, image ref) and after |
| BTC weights | 4a log line (verbatim) or CACHED / absent; 4b size + sha256 (who ran it); else `weights present: UNVERIFIED` |
| /health | status, sentry, fetch_canary.ok / .proxy.ok / .youtube.ok, probe time |
| smoke | pre-flight (title, channel, duration s, licence evidence, how read), link, job id, status, error_code, `source_sec` / `used_sec`, page shows true length (y/n), chords (y/n), minutes to done |
| A2 (3) check | pass / fail / "unverified until next real job" |
| CHORDS_PROVIDER | `klangio`, unchanged (switch is Jon's) |
| A3 count | queries used this session (≤ 20) |
| outcome | ok / rolled back (fast or slow path, who) |

## 8 · Rollback

Use [deploy-rollback.md](deploy-rollback.md) §2–§3; specifics for this batch:

- **Fast path (Jon only):** `fly releases --app stem-loops --image`, then
  `fly deploy --app stem-loops --image registry.fly.io/stem-loops:deployment-<previous ID> --ha=false`
  from `apps/worker/`. Allow up to 5 min drain. No migration to reverse.
- **If Jon had already switched to BTC:** set `CHORDS_PROVIDER=klangio` first (Jon); the
  pre-#509 image has no working `btc` provider. `fly secrets set --stage CHORDS_PROVIDER=klangio`
  then the `fly deploy --image …` does both in one restart (one drain instead of two); Jon's
  call.
- **Slow path:** pure `git revert` PR of the offending merge (likely #504 if long or link jobs
  fail; #501 if chord submits misbehave; #509 only if the image itself breaks), through the
  gate with the same reviewers/score bar (all three are money class), main CI green, then a
  **new** `target=worker` dispatch in a DEPLOY slot (next: 23:00Z the same day).
- Not rollback reasons: BTC weights missing (prod uses Klangio), the smoke song failing on the
  section download alone while ≤ 36-min jobs work (report and fix forward), a drift warning.
- Tell Jon at once on any failed §7 check (what broke, SHA, fast path needed, revert PR).
