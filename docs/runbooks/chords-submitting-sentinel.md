# Runbook: chords `submitting` sentinel and the Klangio submit breaker (D-2, #459; #467)

One page. Every claim cites `file:line` at `v3/main` b98f12c (after #466, K-1/K-2), except
the lines marked **#501**, which cite `klangio.py` at #501's head b9aec15 (K-2 after #501:
connect failures and 5xx/429 submit POSTs count; #467, #462). This runbook documents; it
grants nothing. **Jon only** writes `jobs.klangio_job_id`. Sessions and subagents never write it (COMMON-RULES: no DB access; any prod SELECT is an orchestrator's A3
read). Paths below are under `apps/worker/`.

## 1 · What `klangio_job_id = 'submitting'` means

`jobs.klangio_job_id` is the per-job at-most-once record of a Klangio spend
(`migrations/030_v3_jobs_klangio_job_id.sql:1-23`):

| Value | Meaning |
|---|---|
| `NULL` | never submitted, or the submit provably never left the worker |
| `'submitting'` | claimed BEFORE the billable POST; the POST may have been sent and paid, but no Klangio job id was recorded |
| anything else | the Klangio job id; a rerun reattaches with free GETs |

- **Claim before POST.** `_KlangioJobLedger.claim()` sets the sentinel with a compare-and-set
  (`… WHERE klangio_job_id IS NULL`) before the request (`src/worker/pipeline.py:1191-1202`,
  called at `src/worker/chord_providers/klangio.py:798-802`). `record()` swaps it for the job
  id right after the POST answers (`pipeline.py:1204-1213`, `klangio.py:847-861`).
- **A rerun that finds the sentinel skips chords** (`pipeline.py:1176-1189` raises
  `ChordSubmitUncertain`, `src/worker/chord_source.py:117-124`). The job still completes;
  chords show as unavailable: `WARN chords_skipped_submit_uncertain`, a Sentry event, tombstone
  `provider_failed`, marker `submit_uncertain` (`pipeline.py:1425-1432`, `pipeline.py:1238`).
- **When the sentinel is released (back to `NULL`)** (`pipeline.py:1215-1221`):
  - quota reservation failed, so nothing was sent (`klangio.py:803-810`);
  - **K-1 (#466):** the POST failed at connect time (`ConnectError`, `ConnectTimeout`,
    `PoolTimeout`): no byte left the process (`klangio.py:264-283`, `klangio.py:820-828`).
    A failed release is logged `ERROR klangio_claim_release_failed` and the sentinel stays
    (`klangio.py:705-712`).
- **When it stays** (a billed job may exist):
  - the POST was sent (or maybe sent) and got no answer: `WriteError/WriteTimeout`,
    read errors and timeouts (`klangio.py:270-272`, `klangio.py:829-832`); marker
    `submit_unanswered` (`pipeline.py:1443-1449`);
  - **#501:** the POST answered HTTP 5xx or 429. The submit POST is never retried, and
    Klangio may still have created and billed the job, so it raises `ChordSubmitNoAnswer`
    and keeps `'submitting'`; marker `submit_unanswered` (#501 `klangio.py:949-956`,
    `klangio.py:837-840`). Before #501 the claim was kept the same way, but it was a plain
    `ChordProviderError` (marker `provider_failed`) and did not count toward the breaker;
  - the POST answered but carried no usable `job_id` (`klangio.py:840-846`);
  - the process died between the POST and `record()`, or `record()` failed
    (`ERROR klangio_job_id_record_failed`, `klangio.py:851-860`).
- A job **in flight** holds the sentinel for the length of its POST
  (`KLANGIO_HTTP_TIMEOUT_SEC`, default 30 s, `klangio.py:117`), so only terminal jobs matter.
- The artifact audit does not expect chords for a sentinel row
  (`src/worker/artifact_audit.py:53`, `:142`).

## 2 · List them (read-only: counts and ids only)

```sql
SELECT count(*) FROM public.jobs WHERE klangio_job_id = 'submitting' AND status IN ('done', 'failed');
SELECT id FROM public.jobs WHERE klangio_job_id = 'submitting' AND status IN ('done', 'failed') ORDER BY id LIMIT 100;
```

No titles, URLs, user ids or other columns. Cross-check in Sentry / logs:
`chords_skipped_submit_uncertain`, `klangio_claim_release_failed`,
`klangio_job_id_record_failed`.

## 3 · Why a manual reset risks a double bill

- Setting a sentinel row back to `NULL` lets the next run of that job POST again.
- Klangio has **no idempotency key and no job-list endpoint**, so neither the worker nor an
  operator can ask Klangio whether the first POST created a billed job
  (`klangio.py:24-31`; verified against the OpenAPI spec, `docs/ops/chord-recognition.md:154-161`).
- Past the 500 included requests each POST is $0.20 (`migrations/030_v3_jobs_klangio_job_id.sql:4`,
  `docs/ops/chord-recognition.md:152`); a second POST is a second bill that nothing detects.
- The quota slot of the first attempt is never refunded either way (`klangio.py:32-41`).
- **Default: leave the sentinel.** The job is done; the user sees "chords unavailable".
  A reset is Jon's call only, per job id, and only when he accepts paying twice:
  `UPDATE public.jobs SET klangio_job_id = NULL WHERE id = '<id>' AND klangio_job_id = 'submitting';`
  (the same guarded statement as `release()`, `pipeline.py:1215-1221`). Read back with the §2
  SELECT. A reset alone does not re-run chords; the job must be re-made.

## 4 · K-2 submit circuit breaker (#466)

- **What.** A closed → open → half-open breaker on the billable POST, checked BEFORE the
  ledger claim and the quota slot, so a skipped submit sends nothing, claims nothing and
  spends no quota (`klangio.py:43-46`, `klangio.py:286-292`, `klangio.py:793-795`).
- **Trips** after `KLANGIO_BREAKER_FAILURES` consecutive **failed** submit POSTs (default
  `3`; `0` disables) and stays open `KLANGIO_BREAKER_PAUSE_SEC` (default `1800`)
  (`klangio.py:293-294`, `klangio.py:305-317`). **#501:** a failed submit is any of: sent with
  no answer (claim kept, `submit_unanswered`); HTTP 5xx or 429 (claim kept,
  `submit_unanswered`); never connected (`ConnectError` / `ConnectTimeout` / `PoolTimeout`;
  claim released, quota slot not refunded) (#501 `klangio.py:303-306`, `klangio.py:413-423`,
  `klangio.py:828-840`). A 2xx or 4xx (incl. 402) answer resets the streak; an abort (no POST
  made: claim, quota or local error) leaves it unchanged (#501 `klangio.py:410-423`,
  `klangio.py:841-845`). Retried GETs (polling) never reach the breaker.
- **Half-open.** After the pause one trial POST is let through: a 2xx/4xx answer closes the
  breaker; no answer, a 5xx/429 or a connect failure re-opens it for another pause
  (#501 `klangio.py:365-380`, `klangio.py:398-409`; the 5xx/429 and connect cases reach this
  branch via #501 `klangio.py:948-956`, `klangio.py:837-840`, `klangio.py:828-836`).
- **While open**, submits raise `ChordProviderPaused` (`klangio.py:375-380`,
  `src/worker/chord_source.py:140`): `INFO chords_skipped_provider_paused`, tombstone
  `not_attempted`, marker `provider_paused`, no per-job Sentry event
  (`pipeline.py:1417-1424`). No sentinel is written for these jobs.
- **Per process, in memory.** No DB, no migration; each worker process trips on its own and a
  restart closes it (`klangio.py:287`, `klangio.py:342-345`).
- **Signals.** `WARN chords_breaker_open` (fields `consecutive_no_answer`, `threshold`,
  `pause_sec`, `trigger`, `from_trial`) plus one Sentry warning per open
  (`klangio.py:418-429`, `klangio.py:443-456`); `WARN chords_breaker_half_open`
  (`klangio.py:372-373`); `WARN chords_breaker_closed` (`klangio.py:430-431`).
- **Env read per call**, so a change applies on the next submit (`klangio.py:305-306`). An
  invalid value (non-integer, negative, non-numeric pause) makes every submit fail with
  `ChordProviderError` before anything is sent (`klangio.py:307-316`, `klangio.py:463-472`).
- Env reference: `docs/ops/chord-recognition.md` "Env vars", root `.env.example`.

## 5 · What Jon does in a Klangio outage

1. **Confirm.** Sentry `chords_breaker_open`; logs `chords_breaker_open` /
   `chords_skipped_provider_paused`. Songs still finish without chords; stems and loops are
   unaffected (`pipeline.py:1417-1424`).
2. **Let the breaker work.** It retries one trial every pause; `chords_breaker_closed` means
   Klangio is answering again. No action needed for paused jobs: nothing was spent.
3. **Optional, Jon only:** stop chord spend outright with `CHORDS_PROVIDER=''`
   (`docs/ops/chord-recognition.md` "Env vars"), or tune `KLANGIO_BREAKER_PAUSE_SEC`. Both
   are Fly env changes, which restart the worker (drain rules in
   [deploy rollback](deploy-rollback.md) §2).
   To stop **all** paid work (Replicate too), engage the [spend brake](spend-brake.md).
4. **Afterwards:** run the §2 SELECT. Rows that keep the sentinel are the possible paid-but-lost
   submits; leave them (§3) and note the count in the ledger.
5. **Connect outage (#467 item 2, Jon E3 = a; closed by #501):** when the POST never connects
   (`ConnectError`/`ConnectTimeout`/`PoolTimeout`), each job still spends one quota slot (no
   refund), but since #501 these count toward the breaker, so a connect outage trips it after
   `KLANGIO_BREAKER_FAILURES` jobs and the rest are paused at no cost, apart from one trial
   submit per pause (one quota slot each) (#501
   `klangio.py:828-836`, `klangio.py:413-418`). K-1 still releases the claim, so those jobs
   can be retried. A 5xx/429 outage also trips it now. Those jobs keep the sentinel, as they
   did before #501 (that part is not new; only the marker changed from `provider_failed` to
   `submit_unanswered`); the breaker now caps the new rows at `KLANGIO_BREAKER_FAILURES` per
   open, plus one for each failed half-open trial, instead of one per job for the whole
   outage.
