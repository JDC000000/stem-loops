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

`ChordSource.recognize(audio_path, stem=...)` takes a `stem` hint
(`mix` | `instrumental` | `other`). The Y1 foundations report flagged the
instrumental stem as a free accuracy lever versus running on the full mix —
vocals confuse most chord recognisers. The pipeline picks, in order:

1. An explicit `instrumental` stem if Demucs already produced one.
2. `other` (Demucs htdemucs_6s has this).
3. `keys` / `guitar` (fallback).
4. Skip entirely rather than feed vocals.

## Klangio provider

`apps/worker/src/worker/chord_providers/klangio.py`.

- **Base URL:** `https://api.klang.io` (`KLANGIO_API_BASE` env override).
- **Auth:** `Authorization: Bearer <KLANGIO_API_KEY>`.
- **Flow:** `POST /transcription/chords` (multipart WAV) → `{job_id}`; poll
  `GET /job/<id>` until status `completed`; fetch results via
  `GET /job/<id>/json`.
- **Retries:** 429 and 5xx retried with exponential backoff + jitter, cap
  60s, 5 attempts max. `Retry-After` header is honoured.
- **402 (quota exceeded):** terminal — raises `ChordQuotaExceeded`. This is
  the single signal that forces the Y1 bridge decision to be reviewed
  before the next cycle. Never retried.
- **Other 4xx:** terminal `ChordProviderError` — these are our bugs (bad
  body, bad auth), not transient failures.
- **Max audio length:** 300s per file per the Klangio docs
  (`KLANGIO_MAX_AUDIO_SEC` override). The pipeline currently runs this on
  the instrumental stem of whatever length the user uploaded; stretched
  tracks will need to be chunked in a follow-up.
- **Confidence:** Klangio does not publish per-segment confidence. We set
  `1.0` and flag a TODO in-code to derive one from strum-gap width in
  Y1.2.

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
| `CHORDS_STEM` | `instrumental` | Stem fed to the provider. Falls back to `other` / `keys` / `guitar` if the preferred stem is missing. |
| `KLANGIO_API_KEY` | *(unset)* | Server-side only. Obtain at klang.io/account. |
| `KLANGIO_API_BASE` | `https://api.klang.io` | Override for local proxy / staging. |
| `KLANGIO_API_VERSION` | `2026-11-04` | Captured in `ChordResult.provider_version`. |
| `KLANGIO_MAX_RETRIES` | `5` | 429/5xx retry budget. |
| `KLANGIO_BACKOFF_CAP_SEC` | `60` | Hard ceiling on a single retry wait. |
| `KLANGIO_BACKOFF_BASE_SEC` | `1` | Base for the exponential backoff. |
| `KLANGIO_HTTP_TIMEOUT_SEC` | `30` | Per-call HTTP timeout. |
| `KLANGIO_POLL_INTERVAL_SEC` | `2` | Delay between job-status polls. |
| `KLANGIO_POLL_DEADLINE_SEC` | `600` | Total wall-clock cap for job completion. |
| `KLANGIO_MAX_AUDIO_SEC` | `300` | Provider's per-file max (docs). |
| `CHORD_EVAL_FETCH` | *(unset)* | `1` enables audio downloads in the eval harness. |

## Deferred to Y1.2–Y1.7

- Replicate / internal providers (factory branches present; implementations
  are `NotImplementedError` until their PRs).
- Per-segment confidence heuristic (Klangio currently reports 1.0 flat).
- Long-file chunking for tracks over 300s.
- mir_eval ground-truth .lab files for the 20-song set.
- CI job to re-run the eval set on a nightly schedule.
