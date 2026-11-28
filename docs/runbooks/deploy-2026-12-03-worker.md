# Runbook: worker deploy Thu 2026-12-03 11:00 Vancouver (18:00Z), 24B post-freeze batch

One-off plan for session 24A. It documents; it grants nothing. Sources read 2026-11-28:
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
- No migration. No open PR adds a file under `apps/worker/migrations/` (checked 2026-11-28 over
  all 9 open PRs: #501 #503 #504 #506 #507 #508 #509 #510 #516). Repo last = `045_v3_jobs_retry_of.sql`.

## 0 · Authority (check before anything else)

AGENTS.md (D-7, A2 row) says **A sessions never deploy** and **A2 is NOT ACTIVE** in the repo
copy. This deploy is assigned to 24A by the 24A handover and the Klangio/BTC renewal brief.
Before 17:30Z, the VERIFY row must cite the **Jon line (LEDGER-24A row) that lets 24A dispatch
this worker deploy** and, for the smoke song, that A2 (hence A2b) is active or that Jon
separately allowed the one smoke job. If neither is on the ledger: do not dispatch; hand the
plan to Jon (or 24B's D-7 path) and stop. A refused dispatch is OR-1: record, tell Jon, no
re-route (no `make deploy-worker`, no local `flyctl`).

## 1 · Pre-checks (17:30Z–18:00Z)

1. **Batch merged.** #509, #504, #501 merged into v3/main by 24B after the freeze end
   (2026-12-03T01:00Z). Record each merge SHA. If #509 is not merged, skip §4; if #504 is not
   merged, the smoke song is not a #511 test (§6).
2. **Which SHA.** `SHA=$(gh api repos/JDC000000/stem-loops/commits/v3/main --jq .sha)`.
   The deploy uses the head of `v3/main` at dispatch time; record it in full and as sha7.
3. **Main green on that SHA.** Every check-run complete and green:
   `gh api "repos/JDC000000/stem-loops/commits/$SHA/check-runs?per_page=100" --jq '.check_runs[] | [.name,.status,.conclusion] | @tsv'`.
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
7. **Fly baseline (Jon or anyone with read access to the Fly dashboard).** The current release
   number and image ref (`fly releases --app stem-loops --image`, Jon) are the rollback target;
   write them into the VERIFY row before dispatch. If nobody can read it, the rollback step
   reads it afterwards from the release list (the one before ours).

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
gh workflow run deploy.yml --repo JDC000000/stem-loops --ref v3/main -f target=worker
sleep 10
RUN=$(gh api "repos/JDC000000/stem-loops/actions/workflows/deploy.yml/runs?branch=v3/main&event=workflow_dispatch&per_page=1" --jq '.workflow_runs[0] | "\(.id) \(.head_sha)"')
echo "$RUN"      # head_sha must equal $SHA
gh run watch "${RUN%% *}" --repo JDC000000/stem-loops --exit-status
```

- Expected jobs: `CI green gate (deployed SHA on v3/main)` success, `Ruleset drift warning
  (non-blocking)` (warning only, ignored), `Deploy Web to Vercel` **skipped**, `Deploy Worker
  to Fly.io` success.
- Red gate: wait for main CI, dispatch a **new** run. Never `gh run rerun`, never "re-run
  failed jobs" on a deploy run.
- Deploy job red: the old image keeps running (Fly does not swap on a failed build). Release
  the claim, ledger it, tell Jon; no retry before the cause is known.

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
gh api "repos/JDC000000/stem-loops/actions/jobs/$JOB/logs" > /tmp/24A-deploy-worker.log
grep -nE 'btc weights (fetched and verified|already present|NOT installed)|fetch_btc_weights|CACHED' /tmp/24A-deploy-worker.log
```

| Log shows | Meaning | Next |
|---|---|---|
| `btc weights fetched and verified: /app/models/btc/btc_model_large_voca.pt` | size + sha256 matched at build | pass 4a; 4b still wanted |
| `WARNING: btc weights NOT installed (…)` | soft failure: **no file** in the image | BTC unusable; Klangio unaffected; not a rollback. Tell Jon; see "sticky cache" below |
| the `RUN … fetch_btc_weights.py` step marked `CACHED` (no print line) | layer reused from an earlier build; the log proves nothing | 4b is required |
| no line about the step at all | flyctl did not stream that output | 4b is required |

**Sticky cache:** the layer's cache key is the `COPY`'d script plus the `RUN` line, not the
download result. A soft-failed layer is cached **without** the file and every later build
reuses it until the script or the line changes, or Jon deploys with `--no-cache`. So a
WARNING (or a CACHED step after an earlier WARNING) is not fixed by re-dispatching.

**4b · In the running Machine (Jon: `fly ssh console` is Fly access, not a session's).**

```bash
fly ssh console -a stem-loops -C "ls -l /app/models/btc/btc_model_large_voca.pt"
fly ssh console -a stem-loops -C "sha256sum /app/models/btc/btc_model_large_voca.pt"
# or the worker's own check (raises BtcWeightsMissing on missing/mismatch):
fly ssh console -a stem-loops -C "python -c 'from src.worker.chord_providers.btc import verify_weights, weights_path; print(weights_path(), verify_weights(weights_path()))'"
```

Pass: size `12229576` and the sha256 above. Either 4a "fetched and verified" or 4b pass is
enough to record "weights present"; 4b is the only proof when the step was CACHED. A missing
file never blocks the deploy result (prod is on Klangio) but blocks Jon's BTC switch.

**Optional, Jon only, not part of the deploy check:** one BTC run on an already-separated
song without changing the live setting, e.g. `python -m src.worker.chord_eval --provider btc …`
inside `fly ssh console` (arguments per `chord_eval --help`). The live setting stays klangio.

## 5 · /health (liveness only)

```bash
curl -fsS https://stem-loops.fly.dev/health
```

Pass: HTTP 200, `"status":"ok"`, `"sentry":"on"`, `fetch_canary.proxy.ok` true (or null right
after boot; re-probe after 15 min). `/health` is DB-free and is **not** the post-deploy check
(A2 (3)); it can only add a failure (deploy-rollback.md, "do the stricter").

## 6 · Smoke song: one >36-min video (A2b(a), #511)

Only if §0 covers it (A2 active, or Jon's explicit allowance). ≤ 2 smoke jobs/day; this is 1.

- **Primary:** Bach, Well-Tempered Clavier Book 1, Kimiko Ishizaka (channel OpenGoldberg),
  `https://www.youtube.com/watch?v=nPHIZw7HZq4`, about 1 h 49 min (last chapter starts
  1:41:01). Recording released into the public domain (Open Well-Tempered Clavier, 2015). First
  5 min = Prelude + Fugue in C major and the start of C minor: clear tonal harmony.
- **Backup:** Bach, Goldberg Variations, same pianist and channel,
  `https://www.youtube.com/watch?v=15ezpwCHtJs`, about 1 h 22 min (last chapter "Aria da Capo"
  starts 1:19:32). Recording CC0 (Open Goldberg Variations). First 5 min = the Aria in G major.
- Record the link used in the ledger (A2b: a fixed public test song).

Submit once, signed out, by pasting the link at `https://stem-loops.com`, after §3 is green and
the new Machine is up. Then (A3 reads, logged):

```sql
SELECT id, status, error_code, created_at, updated_at FROM public.jobs
 WHERE youtube_url LIKE '%nPHIZw7HZq4%' AND created_at > '<deploy finished, UTC>' ORDER BY created_at DESC LIMIT 1;
SELECT stage, phase, detail FROM public.job_events WHERE job_id = '<id>' AND detail ? 'trimmed';
```

**Expected:** `status = 'done'` within 30 min; a `job_events.detail` of
`{"trimmed": true, "source_sec": <≈ full length, e.g. ~6500>, "used_sec": ~300}`; the job page
`/jobs/<id>` plays the first 5 min and shows the trimmed note with the **true** length (not
5:00); chords present (`jobs/<id>/play.chords.json` in R2, provider klangio). This is the
`--download-sections` leg through the sticky proxy that unit tests cannot prove.

| Result | Meaning | Action |
|---|---|---|
| `done`, trimmed, true length | #504 works live; also satisfies A2 (3)'s "real job" | close #511 with the evidence |
| `failed`, `DOWNLOAD_TIMEOUT` / `FETCH_PROXY_FAILED` | section download did not work through the proxy | not a rollback by itself (≤ 36-min songs are unchanged); tell Jon, comment on #511 via 24A, try the backup only if the cause looks link-specific (2nd and last smoke of the day) |
| `failed`, `INTERNAL_ERROR` `r2_stage_timeout` | new 120 s R2 bound hit | refunded by design; tell Jon |
| `done` but `source_sec` = ~300 (no true length) | trimming works, true-length report does not | file an issue; no rollback |
| any ≤ 36-min tester job failing after the deploy | regression | deploy-rollback.md §1 failure → §2/§3 |

## 7 · Post-deploy check and VERIFY row

Pass needs all of deploy-rollback.md §1 (jobs green, deployed SHA = dispatched head, a job
created after the deploy reaches `done` with a chord file within 30 min). The smoke job may be
that job. Ledger (LEDGER-24A), one VERIFY row:

| Field | Value |
|---|---|
| time | dispatch and finish, UTC |
| authority | Jon row for 24A's dispatch; A2/A2b status or Jon's smoke allowance |
| #414 | DEPLOY comment id, RELEASE comment id |
| SHA | dispatched `v3/main` head (full) = run `head_sha`; PRs included (#509 #504 #501 #516 + merge SHAs) |
| run | deploy run URL; gate / worker job conclusions; web job skipped |
| migrations | A3 query, result (`045_v3_jobs_retry_of.sql`), repo last at SHA |
| Fly | release before (rollback target, image ref) and after |
| BTC weights | 4a log line (verbatim) or CACHED; 4b size + sha256 (who ran it) or "not run (Jon)" |
| /health | status, sentry, fetch_canary.proxy.ok |
| smoke | link, job id, status, error_code, `source_sec` / `used_sec`, page shows true length (y/n), chords (y/n), minutes to done |
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
  pre-#509 image has no working `btc` provider.
- **Slow path:** pure `git revert` PR of the offending merge (likely #504 if long or link jobs
  fail; #501 if chord submits misbehave; #509 only if the image itself breaks), through the
  gate with the same reviewers/score bar (all three are money class), main CI green, then a
  **new** `target=worker` dispatch in a DEPLOY slot (next: 23:00Z the same day).
- Not rollback reasons: BTC weights missing (prod uses Klangio), the smoke song failing on the
  section download alone while ≤ 36-min jobs work (report and fix forward), a drift warning.
- Tell Jon at once on any failed §7 check (what broke, SHA, fast path needed, revert PR).
