# Chord Recognition (V3 Phase 2 Y1)

V3 Phase 2 Y1 ships a chord overlay on top of the Variant D engine. The
recognition step lives in the worker and is behind a swappable provider
interface so the pre-launch bridge can be replaced without touching the
pipeline or the schema.

## Decision record

`claude/phase-2-y1-chord-model-decision.md` v1.1 — hybrid path E:

1. **Now (PR-Y1.1):** Klangio Startup tier as a drop-in bridge for one
   billing cycle. Fastest path to a usable chord overlay on real traffic.
2. **In parallel (PR-Y1.2+):** train our own model against the 20-song
   CC-licensed eval set in this PR, measured with mir_eval MajMin/sevenths
   /root metrics. When the own-model wins (or meets) Klangio on the eval
   AND the pipeline cost is lower, we swap `CHORDS_PROVIDER` to `internal`.
3. **Hard cap:** the Klangio bridge runs for **one billing cycle only**.
   If the own-model is not production-ready by the cycle end, the Y1 lead
   explicitly decides whether to renew (and that renewal is treated as a
   new decision — not a default).

## Provider abstraction

`apps/worker/src/worker/chord_source.py` defines three types the rest of
the pipeline sees:

| Type | Role |
|------|------|
| `ChordSegment` | One `(start_sec, end_sec, label, confidence)` region. Labels are Harte syntax — `C:maj`, `F#:7`, `N` (no chord), `X` (unrecognised). |
| `ChordResult`  | Full-track output: segments + optional key + provider tag + provider version + timing. |
| `ChordSource`  | Protocol every provider implements. One method: `recognize(audio_path, stem=...)`. |

The factory `get_chord_source(provider)` dispatches on the `CHORDS_PROVIDER`
env var:

| Value | Status |
|-------|--------|
| `klangio` (default)  | `KlangioChordSource` — shipped in PR-Y1.1. |
| `replicate`          | Reserved for a hosted model via Replicate. Deferred to PR-Y1.2+. |
| `internal`           | Own-trained model. Deferred to PR-Y1.4+. |
| *(empty string)*     | **Disables** chord recognition — the pipeline logs `chords_skipped_disabled` and continues. Use for Gate-2 fixture runs. |

The pipeline integration (`_maybe_run_chord_recognition` in
`apps/worker/src/worker/pipeline.py`) runs **after** Demucs separation and
uploads `jobs/<job_id>/play.chords.json` to R2 (bucket private;
Content-Type `application/json`, Cache-Control `private, max-age=0`). The
web overlay reads it via a 5-minute signed URL minted by
`GET /api/jobs/<id>/play-chords`. Failures NEVER fail the job — chords are
an optional overlay feature; a missing JSON degrades the Y1 UI only. All
failures go to Sentry + a `chords_failed` (recognition) or
`play_chords_upload_failed` (R2) structured log.

## Stem routing

`ChordSource.recognize(audio_path, stem=...)` takes a `stem` label that is
recorded on the result (Klangio itself has no stem parameter). The Y1 foundations
report flagged removing vocals as a free accuracy lever versus running on the
full mix: vocals confuse most chord recognisers.

`htdemucs_6s` emits exactly `vocals, drums, bass, other, guitar, keys`
(`piano` is renamed to `keys`). **There is no `instrumental` stem.** In a 6-stem
split `other` is the residue left after guitar and keys were extracted, so it is
the harmonically thinnest non-vocal stem; the old ladder (`instrumental` ->
`other` -> `keys` -> `guitar`) therefore always picked `other` and could drop
sections whose harmony lives in guitar or keys. The pipeline now picks:

1. **`harmonic_mix`** (default): `keys` + `guitar` + `other` (+ `bass` for
   roots) summed with ffmpeg into a temporary 44.1 kHz stereo WAV (job-scoped
   tmpdir, removed at job end). Used when 2+ of keys/guitar/other exist.
2. A single stem when only one harmonic stem exists, or the mix fails:
   `keys` -> `guitar` -> `other` (`other` last, it is the residue).
3. Skip entirely (`chords_skipped_no_harmonic_stem`) when none of
   keys/guitar/other exists. `vocals` and `drums` are never selected or mixed;
   `bass` alone is not used.

Observability: every run logs `chords_input_selected` with `chord_input`
(`harmonic_mix` or the stem name), the configured `CHORDS_STEM`, and the
available stems; `chords_complete` also carries `stem`. Alert if
`chord_input=other` becomes common on 6-stem jobs.

## Klangio provider

`apps/worker/src/worker/chord_providers/klangio.py`.

- **Base URL:** `https://api.klang.io` (`KLANGIO_API_BASE` env override).
- **Auth:** header `kl-api-key: <KLANGIO_API_KEY>` on every request.
- **Flow (async job API, verified against the live service 2026-11-05):**
  1. `POST /chord-recognition?vocabulary={root|major-minor|full}` — multipart,
     file field `file`. `vocabulary` is **required** (omitted → HTTP 422).
     Returns `{job_id, creation_date, deletion_date, status_endpoint_url}`.
  2. Poll `GET /job/<id>/status` → `{"status": IN_QUEUE | IN_PROGRESS |
     COMPLETED | FAILED}`; `FAILED` carries an `error` string (e.g. `Audio file
     must be longer than 5 seconds!`), which is surfaced in the raised error
     (bounded to 200 chars, API key scrubbed).
  3. `GET /job/<id>/json` → bare array `[[start_sec, end_sec, harte_label], ...]`
     (no object, no `chords` key, no key/tonality). A FAILED job 404s here
     (`KL003`). `/midi` and `/xml` are not valid for chord jobs.
- **Vocabulary:** `KLANGIO_VOCABULARY` (default `full`). `major-minor` would
  collapse 7ths and slash chords (~1/3 of real chord tokens).
- **Rate limit / quota (Startup, $99/mo):** 2 req/s, 500 requests/month then
  $0.20 each. All requests (including retries and polls) pass a process-wide
  throttle (`KLANGIO_MIN_REQUEST_INTERVAL_SEC`, default 0.5). Results are
  deleted by Klangio after 30 days.
- **Retries:** only the idempotent GETs (status / result) are retried: 429 and
  5xx with exponential backoff + jitter, cap 60s, 5 attempts max;
  `Retry-After` is honoured. **The submit POST is never retried** (see
  "Spend protection").
- **402 (quota exceeded):** terminal — raises `ChordQuotaExceeded`. This is
  the single signal that forces the Y1 bridge decision to be reviewed
  before the next cycle. Never retried.
- **Other 4xx:** terminal `ChordProviderError` — these are our bugs (bad
  body, bad auth), not transient failures.
- **Audio length bounds:** must be **> 5 s** and **<= 300 s**
  (`KLANGIO_MIN_AUDIO_SEC` / `KLANGIO_MAX_AUDIO_SEC`). Both are checked locally
  (via `soundfile`) *before* the POST because a rejected request still consumes
  quota; unreadable audio also fails closed without a request. The pipeline currently runs this on
  the instrumental stem of whatever length the user uploaded; stretched
  tracks will need to be chunked in a follow-up.
- **Confidence:** Klangio does not publish per-segment confidence. We set
  `1.0` and flag a TODO in-code to derive one from strum-gap width in
  Y1.2.

### Response parsing policy

`_parse_klangio_response` never trusts the wire. Principle: the request is already paid
for ($0.20), so keep every row we can prove is sane and drop the rest *loudly*; a dropped
row is an honest gap (timestamps are absolute, later chords do not slide), whereas a guessed
repair is a confident wrong chord.

| Case | Action | Why |
|---|---|---|
| Not a 3+ element list | drop (`bad_shape`) | nothing to salvage |
| Non-numeric / missing / bool / NaN / Infinity start or end | drop (`non_numeric_or_non_finite_time`) | `json.loads` accepts bare `NaN`/`Infinity`; `json.dumps` re-emits them as invalid JSON |
| `end <= start` | drop (`end_not_after_start`) | can't tell which bound is wrong; zero duration is meaningless |
| `end <= 0` | drop (`negative_end`) | entirely before the track |
| `start < 0 < end` | clamp start to 0 (repair) | rounding noise at t=0 |
| Out of order | stable sort by start (repair) | order is recoverable |
| Overlap | trim earlier `end` to later `start` (repair) | timeline needs disjoint segments |
| Same start as predecessor | drop later (`duplicate_start`) | ambiguous; keep first |
| Unrecognised label | `X` (unchanged), counted | overlay renders `X` as "unknown" |
| Rows present, zero survive | raise `ChordProviderError` | an empty track from a non-empty answer is a silent total failure |

Observability: every parse emits one `klangio_parse_summary` event (level `WARNING` if any
row was dropped or repaired or `x_fraction >= 0.30`, else `INFO`) with `rows_total`,
`rows_kept`, `rows_dropped_malformed`, `dropped_by_reason`, `labels_mapped_to_x`,
`x_fraction`, `segments_repaired`, `repaired_by_kind`, `bad_row_samples`, `x_label_samples`.
A high `x_fraction` means a bad stem choice or a vocabulary mismatch.

## Spend protection

Startup tier: $99/mo, 500 included requests, $0.20 each beyond. Overage is real money.

**No double-billing.** Klangio has no idempotency key and no job-list endpoint
(verified against `https://api.klang.io/openapi.json` and `api-docs.klang.io`,
2026-11-05: no `Idempotency-Key` header or request-id parameter on any endpoint, no
`GET /job` or `/jobs`; jobs are reachable only by the `job_id` returned from the POST).
A retried POST after a lost response would create a second billed job that nothing could
detect, so `POST /chord-recognition` is sent exactly once. Any failure (5xx, 429,
timeout) surfaces as `ChordProviderError` ("not retried: a billed job may exist");
the caller decides whether to resubmit. The failed attempt still counts against the quota.

**Idempotent per job (reaper requeues).** A job that finishes chord recognition and then
dies in extract/upload (OOM) is requeued by the reaper up to 2 times, re-running the whole
pipeline. Before stem selection and before the provider call (the quota is reserved inside
`recognize()`, so a skipped call never increments it), `_maybe_run_chord_recognition` GETs
`jobs/<id>/play.chords.json`. It is reused (log `chords_reused_existing_artifact`, zero
provider calls) only if it is a JSON object with a non-empty `segments` list. A missing,
zero-byte, non-JSON or segment-less object is regenerated and overwritten in place (log
`chords_existing_artifact_invalid`), so a bad object can never leave a job permanently
chord-less. A non-404 R2 error on the check fails open (`chords_reuse_check_failed`): at
worst one extra request. The artifact does not record which stem was used, so one written
under a different `CHORDS_STEM` is reused as-is; a requeue happens minutes after the first
run, and re-billing to refresh a chart is the worse trade.

**Heartbeat.** Klangio polling may run `KLANGIO_POLL_DEADLINE_SEC` (600s) against the
reaper's 300s stale window, and nothing else bumped `jobs.updated_at` during the chord stage.
The pipeline now heartbeats every `SEPARATION_HEARTBEAT_SECONDS` (20s) for the stage's
duration, so a second machine's reaper (deploy overlap) cannot requeue a live job and
submit a second billed request before the first artifact exists.

**Quota accounting.** Each submit is counted *before* it is sent, against a cycle that
renews on the 5th (`KLANGIO_BILLING_DAY`). Attempts are never refunded (a rejected request
may still consume quota). Polls and result GETs are not counted.

- From 80% of the cap: `klangio_quota` log at `WARNING` with `near_cap=true`.
- At the cap: `ChordQuotaExceeded` is raised, nothing is sent, `klangio_quota`
  logged at `ERROR` (`outcome=refused_at_cap`). Default cap = 500 = the included allowance.
  Raise `KLANGIO_MONTHLY_CAP` to knowingly accept overage.
- Unparseable spend env vars, or an unreadable/corrupt counter file, fail closed.
- Watch it: filter worker logs for `event=klangio_quota`; `detail.count` / `detail.cap`.

**Where the counter lives.** Two stores sit behind the `_QuotaStore` protocol
(`reserve(cycle, cap) -> (count, granted)`):

- **Postgres (durable, shared across worker instances).** Table `public.klangio_usage`
  (migration `028_v3_klangio_usage.sql`, one row per billing cycle, keyed by the cycle's
  start date). Selected whenever `DATABASE_URL` is set. The reserve is one statement, so
  racing instances cannot both take the last slot:

  ```sql
  INSERT INTO public.klangio_usage (cycle_start, count)
  SELECT %(cycle)s::date, 1
  WHERE %(cap)s::int > 0
  ON CONFLICT (cycle_start) DO UPDATE
    SET count = klangio_usage.count + 1, updated_at = now()
    WHERE klangio_usage.count < %(cap)s::int
  RETURNING count
  ```

  A returned row means granted; no row means refused. The `WHERE cap > 0` guard exists
  because a first INSERT never evaluates the `DO UPDATE ... WHERE`. A database error
  fails closed (`ChordProviderError`, nothing sent). The worker role has no
  `DELETE`/`TRUNCATE` on the table: deleting the row would reset the counter.
- **File (local/dev fallback).** flock-guarded JSON (`KLANGIO_QUOTA_FILE`, default
  `$TMPDIR/klangio_quota.json`), used when `DATABASE_URL` is unset. Per-machine.
  `apps/worker/fly.toml` mounts a volume at `/data` and points `KLANGIO_QUOTA_FILE` at it,
  so the count survives deploys. A Fly volume is **per-machine**: that is durability across
  deploys, not correctness across instances. Postgres is the real fix.

`KLANGIO_QUOTA_BACKEND` (`auto` | `postgres` | `file`) overrides the choice. `postgres`
without `DATABASE_URL` fails closed rather than quietly using a counter that resets.

Deploy order: apply migration 028 (`make migrate`) **before** deploying this code, or the
first submit fails closed on the missing table; and create the volume
(`fly volumes create klangio_quota --app stem-loops --region iad --size 1`) before
deploying the `fly.toml` change. If the counter is ever lost, recover the true count from
the Klangio dashboard and `UPDATE public.klangio_usage SET count = <n> WHERE cycle_start = <date>`.

**Content type.** The multipart `Content-Type` is inferred from the file extension
(`.wav .mp3 .flac .ogg .m4a .aac`), else `application/octet-stream`; it is no longer
hardcoded `audio/wav`.

## Eval set

`apps/worker/tests/fixtures/chord_eval_songs.json` is a 20-row manifest
(**no audio bytes**) of CC-licensed tracks — FMA, Jamendo, YouTube Audio
Library, public-domain US-government recordings — covering 4 pop, 4 rock,
2 folk, 2 jazz, 2 electronic, 2 classical and 4 wildcards (world, metal,
ambient, acoustic live).

**License filter:** only CC0 / CC BY / CC BY-SA / public domain are accepted.
No NC, no ND, no all-rights-reserved content. The manifest is seeded with
`verification_status: "pending"` on every row — each entry must be
hand-verified against its source license page before the staging lead
flips the flag to `verified` in a follow-up PR. This is the PR-Y1.1
author's conscious choice: verifying 20 live URLs at build time is not
reproducible, and shipping unverified tracks under a copyright-strict
guard would be worse than shipping an explicit `pending` state.

The runner is `apps/worker/src/worker/chord_eval.py`, invoked as:

```bash
# Dry run (no network, reports which rows would be fetched):
python -m worker.chord_eval --provider klangio

# Actual run (downloads audio + calls the provider):
CHORD_EVAL_FETCH=1 KLANGIO_API_KEY=… python -m worker.chord_eval --provider klangio
```

Audio lands in `apps/worker/.chord-eval-cache/` (gitignored). Reports land
in `apps/worker/tests/chord_eval_reports/<provider>-<timestamp>.json` and
include raw per-track predictions + mir_eval scores (`root`, `majmin`,
`sevenths`) for any row that has a local `ground_truth_lab` file.

## Env vars

See `.env.example` for the canonical list. The vars this module reads:

| Var | Default | Purpose |
|-----|---------|---------|
| `CHORDS_PROVIDER` | `klangio` | Provider selector. Empty string disables the step. |
| `CHORDS_STEM` | `harmonic_mix` | Input fed to the provider: `harmonic_mix` (default), or a single stem `keys` / `guitar` / `other`. Legacy `instrumental` (no such stem exists) and unknown values resolve to `harmonic_mix`; `vocals` / `drums` are never used. A named stem that is missing falls back to the mix logic. |
| `KLANGIO_API_KEY` | *(unset)* | Server-side only. Sent as `kl-api-key`. Obtain at klang.io/account. |
| `KLANGIO_VOCABULARY` | `full` | `root` / `major-minor` / `full`. Required by the API. |
| `KLANGIO_MIN_AUDIO_SEC` | `5` | Audio must be strictly longer than this. |
| `KLANGIO_MIN_REQUEST_INTERVAL_SEC` | `0.5` | Min spacing between requests (2 req/s tier limit). |
| `KLANGIO_API_BASE` | `https://api.klang.io` | Override for local proxy / staging. |
| `KLANGIO_API_VERSION` | `2026-11-04` | Captured in `ChordResult.provider_version`. |
| `KLANGIO_MAX_RETRIES` | `5` | 429/5xx retry budget for GETs only (never the submit POST). |
| `KLANGIO_MONTHLY_CAP` | `500` | Hard ceiling on submits per billing cycle; further submits raise `ChordQuotaExceeded`. |
| `KLANGIO_WARN_FRACTION` | `0.8` | Log `WARNING` once count >= this fraction of the cap. |
| `KLANGIO_BILLING_DAY` | `5` | Day of month the cycle renews (1-28). |
| `KLANGIO_QUOTA_BACKEND` | `auto` | `auto` = Postgres if `DATABASE_URL` is set, else file. `postgres` / `file` force one (`postgres` without `DATABASE_URL` fails closed). |
| `DATABASE_URL` | *(unset)* | Selects the Postgres counter (`public.klangio_usage`) when set. |
| `KLANGIO_QUOTA_FILE` | `$TMPDIR/klangio_quota.json` | File-store counter path (fallback); per-machine, mounted on the Fly volume at `/data`. |
| `KLANGIO_BACKOFF_CAP_SEC` | `60` | Hard ceiling on a single retry wait. |
| `KLANGIO_BACKOFF_BASE_SEC` | `1` | Base for the exponential backoff. |
| `KLANGIO_HTTP_TIMEOUT_SEC` | `30` | Per-call HTTP timeout. |
| `KLANGIO_POLL_INTERVAL_SEC` | `2` | Delay between job-status polls. |
| `KLANGIO_POLL_DEADLINE_SEC` | `600` | Total wall-clock cap for job completion. |
| `KLANGIO_MAX_AUDIO_SEC` | `300` | Provider's per-file max. |
| `CHORD_EVAL_FETCH` | *(unset)* | `1` enables audio downloads in the eval harness. |

## Deferred to Y1.2–Y1.7

- Replicate / internal providers (factory branches present; implementations
  are `NotImplementedError` until their PRs).
- Per-segment confidence heuristic (Klangio currently reports 1.0 flat).
- Long-file chunking for tracks over 300s.
- mir_eval ground-truth .lab files for the 20-song set.
- CI job to re-run the eval set on a nightly schedule.
