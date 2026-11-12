# PR #229, round 2 — the five required changes, and what I actually verified

Round 1: **58/100, CHANGES REQUESTED**, 8 surviving mutants, 2 user-facing
regressions. All five changes are in. The last code commit is `8112312`;
this report sits on top of it.

| | PR as reviewed (`4c58f3a`) | Now (`8112312`) |
|---|---|---|
| `pnpm test` (apps/web) | 1338 tests, 1318 pass, 0 fail, 20 skipped — rc 0 | **1389 tests, 1369 pass, 0 fail, 20 skipped — rc 0** |
| `pnpm typecheck` | rc 0 | rc 0 |
| `pnpm lint` | rc 0 | rc 0 |
| `make test-py` | not runnable here (see below) | **rc 0 — 675 passed, 168 skipped, 1 xfailed** |
| Mutants attempted / killed / alive | 18 / 10 / **8** | **12 / 12 / 0** |

**Base.** This worktree is detached at the PR head, whose base is `7d3f8ee`.
Round 1's counts (1330 → 1375) were measured on the tree merged with the
current `v3/main`, which is why the absolute numbers differ from mine. I did
not rebase or merge — `mergeable_state` is still `behind`, and that is for
whoever lands this.

---

## 1. The queued threshold, re-derived against the DEPLOYED worker

The old derivation was **885 s**, taken from `apps/worker/src/worker/replicate_client.py:48`:

```python
HARD_DEADLINE = int(os.environ.get("REPLICATE_DEADLINE", "55"))
```

That is the **code default**. `apps/worker/fly.toml:21` sets the deployed value:

```toml
  REPLICATE_DEADLINE = "300"
```

5.45x larger, so the separation row alone was out by 735 s.

A `queued` job is never touched by the reaper (`reaper.py:47` `_NON_TERMINAL`
excludes it), and the consumer runs **one job at a time**
(`consumer.py` `poll_loop` → `claim_and_run`, sequential). So the question is
"how long can the job ahead of me legitimately hold the worker?", and here is
every stage of that job the repo bounds with a constant, on the **upload** input
path (the YouTube path is inert pre-launch, `pipeline.py:1278`):

| # | Stage | Bound | Source (file:line) | Worst case |
|---|---|---|---|---|
| 1 | An idle worker claims the queued job | `POLL_INTERVAL = 2` | `apps/worker/src/worker/consumer.py:37` | 2 s |
| 2 | ffmpeg normalise of the uploaded input | `FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT = 120.0` | `apps/worker/src/worker/pipeline.py:147`, applied `:230` | 120 s |
| 3 | Separation polling × attempts | `HARD_DEADLINE × SEPARATION_MAX_ATTEMPTS` | **`apps/worker/fly.toml:21` = 300** → `replicate_client.py:48`; `pipeline.py:76` = 3; loop `pipeline.py:1301`; wall-clock deadline `replicate_client.py:406` | 300 × 3 = **900 s** |
| 4 | Fetch the 6 separated stems from Replicate's CDN | `httpx.stream(timeout=180)` inside `for attempt in range(4)`, 6-wide pool | `pipeline.py:1114`, `:1112`, `:1128` | 180 × 4 = 720 s |
| 5 | Chord harmonic mix (ffmpeg) | `subprocess.run(..., timeout=300)` | `pipeline.py:689` | 300 s |
| 6 | Chord recognition poll | `POLL_DEADLINE_SEC = 600` | `apps/worker/src/worker/chord_providers/klangio.py:108` | 600 s |
| 7 | Opus encode, 6 stems, **SERIAL** | `subprocess.run(..., timeout=300)` per stem | `pipeline.py:508`; serial loop `retain_stems` `pipeline.py:563-566`; `ALL_STEMS` (6) `pipeline.py:459` | 300 × 6 = **1800 s** |
| | **ONE_JOB_WORST_CASE_S** | | | **4442 s = 74 min** |

**I did not get your 1620 s, and here is the difference.** 1620 = 120 + 900 +
600, i.e. rows 2, 3 and 6. Rows 4, 5 and 7 are also on every job's path and
also bounded by constants — row 7 alone is 1800 s, because `retain_stems` is a
plain `for` loop over six stems, one `subprocess.run` each, not a pool. Your
own note said the 885 s figure "omits the Opus encodes (300 s each)"; including
them is what moves 1620 → 4442.

Threshold = `ceil(4442 × 1.2 / 300) × 300` = **5400 s = 90 min**.

**Two caveats, because 4442 is a floor on the ceiling and not the ceiling.**
`extract_and_tag` and the R2 PUTs are bounded by no constant at all; and
httpx's `timeout=180` is per-operation, not per-transfer, so a response
dribbling a byte every 179 s never trips row 4. Both push the real ceiling UP.
That is why the margin is multiplicative and why the assertion in the test is
`QUEUED_STALL_MS >= ONE_JOB_WORST_CASE_S`, never `<=`.

### Which of the two options I took, and why: both

- **Read the deployed value** — can't, cleanly. `job-poll.ts` is browser code;
  `fly.toml` is not reachable at runtime and plumbing it through
  `NEXT_PUBLIC_*` would add a deploy-time coupling between the web app and the
  worker's Fly config for one number.
- **So: mirror it, and pin the mirror.** The derivation is a named formula over
  mirrored constants in `apps/web/src/lib/job-poll.ts`, and
  `apps/web/test/job-stall-derivation.test.mjs` **reads `fly.toml` and each
  cited `.py` file**, extracts every number, recomputes the sum, and asserts
  the mirror matches. Changing `fly.toml` breaks a test. Changing a mirror
  breaks a test. That is strictly stronger than reading the value, because it
  also catches the arithmetic going stale.

**Your instrument-failure finding is closed.** You moved `REPLICATE_DEADLINE`
55 → 550, `KLANGIO_POLL_DEADLINE_SEC` 600 → 6000 and the ffmpeg default
120 → 1200 and `job-poll.test.mjs` stayed 17/17 green. Mutant **M14** below is
that experiment: `fly.toml` 300 → 600 now fails 3 tests by assertion.

### Why 90 minutes is not "too late"

The panel asserts *"nothing has picked it up"*. With one worker and ten beta
testers, queueing behind another job is the normal case, so at 20 min it was
asserting that about jobs being actively worked on. Being late now costs the
user nothing — the page keeps polling and renders the track the moment it
lands, whether or not the panel appeared (change 2/3). Being early costs them a
false sentence. What it still does not model is queue **depth**: two jobs ahead
can exceed 90 min, and then the page shows a panel that says it has been a long
time (true) beside a poll that is still running.

---

## 2 & 3. The regressions: entering a trouble state no longer stops the poll

`JobView`'s effect `return`ed on `unreachable` and on `stalled`. Both now
`setTimeout(poll, SLOW_POLL_MS)` (30 s) instead, and `terminal` / `continue`
clear the panel. `Try again` / `Check again` are untouched but are no longer
the only path back.

### How I reproduced them — exactly

I wrote the fix's regression tests first, then ran them against the PR as it
stood. Script: `git show 4c58f3a:…` the three changed sources into the
worktree, run **only the new test files**, then restore by copy and verify with
`sha256sum` + `git diff --quiet`.

```
git show 4c58f3a:apps/web/src/app/jobs/[id]/JobView.tsx  > …/JobView.tsx
git show 4c58f3a:apps/web/src/lib/job-poll.ts            > …/job-poll.ts
git show 4c58f3a:apps/web/src/components/play/Player.tsx > …/Player.tsx
node --experimental-strip-types --test \
  test/job-view-poll.test.mjs test/play-player-effect.test.mjs test/job-stall-derivation.test.mjs
```

**BEFORE — 40 tests, 26 pass, 14 fail** (typecheck rc 0 on that tree, so these
are assertion failures, not a build break):

```
not ok 15 - REGRESSION 2: a job that stalls and THEN finishes still renders, unaided
  error: 'the page stopped polling: fetch count frozen at 602'
not ok 17 - the stalled poll keeps running, so the panel is a notice and not a stop
  error: 'the stalled page stopped asking: 602 -> 602'
not ok 10 - REGRESSION 3: five 500s then recovery heals the page on its own
  error: 'the page stopped polling: fetch count frozen at 5'
not ok 11 - the slow poll keeps running for as long as the outage lasts, and stays slow
  error: 'expected ~10 slow polls in 10 intervals, got 0'
not ok 14 - THE BETA BLOCKER: a job queued 21 minutes behind one other job is left alone
  expected: false   actual: true
not ok 13 - a job queued past the threshold gets the stall panel, and it names the queue
  actual: '…has been waiting in line for more than 20 minutes and nothing has picked it up…'
not ok 32 - a manifest 500 says a SERVER error — not "check your connection", which is a lie
  actual: 'We could not reach our servers to start play along. Check your connection and try again.'
not ok  1 - test/job-stall-derivation.test.mjs   (the derivation did not exist)
```

**The fetch count frozen at 602 is your number, reproduced independently.**
Same scenario, a harness I wrote from scratch, same figure.

**AFTER — those same 40 tests pass**, inside a full suite of 1389 / 1369 pass /
0 fail / 20 skipped, rc 0.

Restore verified: `JobView.tsx sha256 OK`, `job-poll.ts sha256 OK`,
`Player.tsx sha256 OK`, `git diff --quiet: CLEAN`.

---

## 4. `MANIFEST_FAILED` splits by whether a response existed

New `MANIFEST_SERVER_ERROR_MESSAGE` for the case where a server answered;
`MANIFEST_UNREACHABLE_MESSAGE` ("check your connection") is kept **only** for a
`fetch` that never got a response. `stemLoadMessage(code, status?)` reads
`StemLoadError.status`, which the loader already carried.

**The split is "did a server answer us?", not a status range** — a 403 from a
misconfigured edge is no more the user's connection than a 500 is, and the
existence of a response is the only thing we actually know.

Same lie fixed in the JobView panel: `Trouble` now carries `status`, and a 500
reads *"Our server answered the last few tries with an error (500) … this is our
fault, not your connection. We are still checking in the background."*

## 5. `MAX_CONSECUTIVE_FAILURES` and the non-500 path

- `MAX_CONSECUTIVE_FAILURES === 5` pinned as a literal, plus a behavioural
  `['retry','retry','retry','retry','unreachable','unreachable']` sequence, plus
  a mounted scenario written with literal counts (4 → no panel, 5 → panel).
- `unreachable` driven from a rejected `fetch` (status `null`), 502, 503, 429, a
  200 whose body is not a job, and a 200 that is not JSON — pure and mounted.
- The failing `status` now reaches the step and the panel, and is asserted.
- The strict `>` at **both** stall boundaries is pinned at the exact
  millisecond (`age === threshold` → healthy; `+1 ms` → stalled).

---

## The new tests

| File | Tests | What it covers that nothing did |
|---|---|---|
| `apps/web/test/job-view-poll.test.mjs` | 21 | The real `JobView` **mounted**, real effect, real `job-poll.ts`, stubbed `fetch`, **virtual clock** — a 95-minute scenario in microseconds. |
| `apps/web/test/play-player-effect.test.mjs` | 18 | The real `Player` **mounted**, real `load-stems.ts`, stubbed `fetch` — asserts the **rendered banner**, not that a call is written. |
| `apps/web/test/job-stall-derivation.test.mjs` | 6 | Reads `fly.toml` + 4 `.py` files, recomputes the threshold. |

Both harnesses pin themselves first (`UNRESOLVED` import check; "the harness
really runs the effect"), because a file-level crash reports as `not ok 1 -
<file>` and looks exactly like a kill while meaning the opposite.

`test/play-player.test.mjs` and `test/job-page-render.test.mjs` now **say at the
gate** that they are source-text / seeded-state layers and point at the
behavioural file. I kept them: this repo's own doctrine
(`job-page-render.test.mjs` header) is that source gates are kept, not replaced,
because they catch a commented-out mount that rendering cannot speak to.

**Your tautological-test finding, closed as a side effect.**
`play-report-failure.test.mjs`'s "nothing sent can carry a presigned signature"
feeds a summary with no signature in it. The new loader test uses
marker-bearing signed URLs (`?sig=REDACTED`) and asserts
`doesNotMatch(JSON.stringify(report), /REDACTED|sig=/)` **and** that the job id
never appears, driven through the real loader.

---

## Mutants: 12 attempted, 12 killed, 0 alive

Protocol per the repo's rules, enforced by the runner rather than by hand: the
anchor occurs **exactly once** (`grep -c -F` printed below), the mutant
**typechecks** (`rc 0`), the **test count is unchanged at 1389 with 20
skipped**, every death is an **`AssertionError`** (no crashes), the file is
restored **by copying a pristine copy back** and verified with `sha256sum`, and
`git diff --quiet` passes afterwards — **all 12 reported `git_clean=True`**.

Runner: `/tmp/.../scratchpad/r2mut/run.py`. One mutant at a time, full suite each.

### Two of your eight had to be restated, and I am saying so rather than claiming them as written

**M8** was "`case 'unreachable'` re-arms the timer" and **M9** was "`case
'stalled'` keeps polling". Re-arming the timer is now the **correct**
behaviour — it is the fix for regressions 2 and 3 — so those mutations are no
longer mutations. The harm M8 was named for ("the job page polls forever
again", i.e. no terminal state ever reached) is now produced by dropping the
`setTrouble` call and keeping the poll, so that is what I mutated. Same for M9.
If you consider the restatement a dodge, the honest summary is: **the original
M8/M9 edits are now behaviour-preserving and therefore unkillable, and the
defect they stood for is killed.**

| Mutant | File | Anchor (`grep -c -F` = 1) | Mutation | Killed by | Assertion message |
|---|---|---|---|---|---|
| **M3b** | `Player.tsx` | `if (notice === null) {` | `if (notice === null \|\| loaded.sources.length === 0) {` | `encode_failed` is a FAULT with its own sentence, not the calm note (+5 more) | `an encode failure is being rendered as "no stems were kept"` — expected `'load-error'`, actual `'no-stems'` |
| **M3** | `Player.tsx` | `setPhase({ kind: 'load-error', message: notice.message, retryable: notice.retryable });` | `message: NO_STEMS_MESSAGE` | the four zero-stem sentences are four DIFFERENT sentences (+5 more) | `two zero-stem outcomes render the SAME sentence: Play along is not available for this track — no play-along audio was kept for it.` |
| **M4c** | `Player.tsx` | `if (reason === 'FETCH_NETWORK' \|\| reason === 'FETCH_HTTP' \|\| reason === 'FETCH_BODY') {` | drop `FETCH_NETWORK` from the condition | every stem GET rejecting (the CORS signature) is a NETWORK sentence, and is reported | `the browser-only failure was not reported` — `0 !== 1` |
| **M8′** | `JobView.tsx` | `setTrouble({ kind: 'unreachable', status: step.status });` | `setTrouble(null);` | five failed polls put the unreachable panel on the page (+6 more) | `five consecutive failures did not reach the unreachable panel` |
| **M9′** | `JobView.tsx` | `setTrouble({ kind: 'stalled', stall: step.stall });` | `setTrouble(null);` | a job queued past the threshold gets the stall panel, and it names the queue (+3 more) | `a job queued past the threshold never reached the stall panel` |
| **M13** | `JobView.tsx` | `failures = step.failures;` | `failures = 0;` | the failure count ACCUMULATES across polls: it is not reset each time round (+7 more) | `after 171 consecutive failed polls the page still shows no outage: the failure count is being reset` |
| **M7c** | `job-poll.ts` | `export const MAX_CONSECUTIVE_FAILURES = 5;` | `= 50;` | MAX_CONSECUTIVE_FAILURES is 5 — the loops above count it, so the constant itself needs pinning (+7 more) | `50 !== 5` |
| **M12** | `job-poll.ts` | `action: n >= MAX_CONSECUTIVE_FAILURES ? 'unreachable' : 'retry',` | `… && outcome.status === 500 ? …` | ANY failed poll counts toward unreachable, not only a 500 (+2 more) | `fetch rejected (offline / DNS / CORS)` — expected `'unreachable'`, actual `'retry'` |
| **M11** | `job-poll.ts` | `return age > ACTIVE_STALL_MS ? 'active' : null;` | `>=` | the stall comparison is strictly greater-than: AT the threshold a job is still healthy | `active, exactly at` — `'active' !== null` |
| **M11q** | `job-poll.ts` | `if (job.status === 'queued') return age > QUEUED_STALL_MS ? 'queued' : null;` | `>=` | (same test) | `queued, exactly at` — `'queued' !== null` |
| **M14** | **`apps/worker/fly.toml`** | `  REPLICATE_DEADLINE = "300"` | `"600"` | THE BUG: the deployed REPLICATE_DEADLINE is read from fly.toml, not from the code default (+2 more) | `fly.toml changed REPLICATE_DEADLINE: re-derive QUEUED_STALL_MS in src/lib/job-poll.ts` — `600 !== 300`; and `the arithmetic in the job-poll.ts comment is stale` — `5342 !== 4442` |
| **M15** | `job-poll.ts` | `const REPLICATE_DEADLINE_S = 300;` | `= 55;` (revert to the code default) | thresholds: ACTIVE = 660 s, QUEUED = 90 min (+7 more) | expected `5400000`, actual `4500000`; and `a queued job … continues until 90 min` — expected `'continue'`, actual `'stalled'` |

Per-mutant suite result, all with `typecheck rc 0` and `tests 1389 / skipped 20`:
M3b 6 fail · M3 6 · M4c 1 · M8′ 7 · M9′ 4 · M13 8 · M7c 8 · M12 4 · M11 1 ·
M11q 1 · M14 3 · M15 8.

I did not re-attempt the 10 mutants round 1 already killed (M1, M2, M4a, M4b,
M5, M6, M7a, M7b, M10); their tests are untouched except where the threshold
value changed. M11/M11q I did attempt even though your table and your header
disagree on whether M11 counted among the eight.

---

## Exact commands and exit codes

| Command (in `apps/web` unless noted) | rc | Result |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` (repo root) | 0 | 611 packages |
| `pnpm test` **at `4c58f3a`, before any change** | 0 | 1338 tests, 1318 pass, 0 fail, 20 skipped |
| `pnpm typecheck` | 0 | — |
| `pnpm lint` | 0 | 1 pre-existing warning, `src/app/api/uploads/route.ts:17` `no-explicit-any`, untouched by this PR |
| `pnpm test` (final) | 0 | **1389 tests, 1369 pass, 0 fail, 0 cancelled, 20 skipped, 0 todo** |
| `make test-py` (repo root) | 0 | **675 passed, 168 skipped, 1 xfailed, 70.6 s** |
| `node --experimental-strip-types --test test/job-view-poll.test.mjs` | 0 | 21/21 |
| `node … --test test/play-player-effect.test.mjs` | 0 | 18/18 |
| `node … --test test/job-stall-derivation.test.mjs` | 0 | 6/6 |
| the before-fix reproduction above | 1 | 40 tests, 26 pass, **14 fail** — intended |
| `git push origin HEAD:refs/heads/fix/first-run-honest-failures` | 0 | `4c58f3a..8112312`, then this report commit |

The 20 skips are the same 20 `cqt-parity:*` skips as before, and nothing was
newly skipped. `git diff HEAD~2 HEAD` shows **55 `+test(` and 4 `-test(`**,
net **+51** — matching 1338 → 1389. All four of those removals are **renames of
tests I kept**, because their titles and values stated the old threshold:

```
-test('thresholds: ACTIVE = 300*2^(2-1)+60 s = 660 s, QUEUED = 20 min',
-test('QUEUED stalls just past 20 min, not before',
-test('a queued job with no worker: continues until 20 min, then STALLS …',
-test('poll cadence is unchanged: 2 s, 4 s after a failure',
```

No assertion was dropped from any of them; each gained assertions.

**`make test-py` needed a step first, and that is worth knowing.** On the first
commit the pre-commit hook printed `[2/5] make test — SKIPPED: worker test
dependencies are not installed`, and running it by hand gave 38 collection
errors, `ModuleNotFoundError: No module named 'psycopg'`. So I installed them
the way the hook's own message says CI does
(`pip install -r apps/worker/requirements.txt -c apps/worker/constraints-prod.txt`)
and ran it: rc 0, 675 passed. The **second** commit's hook therefore ran
`[2/5] make test` with no SKIP. My commits change **zero** Python files
(`git diff --name-only HEAD~2 HEAD -- '*.py'` → empty); the new derivation test
only *reads* them.

## What I did not do, and what is still open

- **No rebase, no merge, no labels.** `mergeable_state` is still `behind`; CI on
  this head has not been consulted. Pushing was the whole mandate.
- **No real browser.** Everything here is happy-dom. Real CORS against a
  CORS-less R2 bucket, real Opus decoding and layout are all still unproven by
  any gate — your "not covered" list stands on those three.
- **A `fetch` that never resolves** is still not a terminal state on either
  page. Neither has a timeout. I did not add one: it is a third behaviour
  change on top of four, and `AbortSignal.timeout` on the poll is a clean
  follow-up.
- **Queue depth** is not modelled by the stall threshold (stated in the code).
- **`REAPER_*` as Fly secrets** is still unverified from the repo; the active
  thresholds assume `fly.toml` has no override, which is what the file shows.
