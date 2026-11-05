# `apps/worker/tests/fixtures/`

This directory holds the committed fixtures used by the worker's test suite and
the Phase-2 Y1 chord-recognition evaluation.

## Current gate status (PR-Y1.eval-verify-2, 2026-11-05)

| Metric | Value |
|--------|-------|
| Verified rows | **19 / 20** |
| Pending rows | 1 (row 17 — `wildcard-metal`) |
| `CHORD_EVAL_FETCH=1` recommended in CI? | **No, not yet** — one row still `pending`. Per the hard rule below, the CI flag only flips on once every row is `verified`. |
| Last verification pass | PR-Y1.eval-verify-2 (replaces #91's leftovers; see `chord_eval_songs.verification.json` for the per-row evidence trail). |

The second pass moved the gate from 4 / 20 → 19 / 20. The remaining row 17 is
documented in the verification JSON under `last_check_note` with the exact
candidate paths a follow-up (PR-Y1.eval-verify-3) should try. Once row 17
flips to `verified`, CI owners can enable `CHORD_EVAL_FETCH=1` in the chord-eval
job without violating the manifest's verification protocol.


## Contents

| File | Purpose |
|------|---------|
| `chord_eval_songs.json` | 20-song CC-licensed manifest driving `apps/worker/src/worker/chord_eval.py`. |
| `chord_eval_songs.verification.json` | Companion verification report produced on each verification pass (see below). |
| `make_stem_fixtures.py` | Script that generates the stem/golden-loop fixtures used by the audio pipeline tests. |

## Why we pin specific tracks (reproducibility)

The Y1 eval is the **end-of-Month-1 gate** for the student-model swap decision
(see `claude/phase-2-y1-chord-model-decision.md` v1.3). Accuracy numbers from
`chord_eval.py` are only meaningful if the test set is bit-for-bit identical
across runs and across contributors. That means:

1. **Each manifest row must point at a specific track** on a CC-friendly host
   (FMA, Jamendo, YT Audio Library, Public Domain .gov). Placeholder
   artist / catalog URLs are not enough: two different "Kevin MacLeod rock
   track"s will produce two different accuracy curves.
2. **The track's CC license must be visible on a WebFetch-reachable page**
   so the verification protocol below is actually enforceable.
3. **The expected duration** (`duration_sec`) is a sanity check for the
   downloader (`apps/worker/src/worker/chord_eval.py` streams audio into
   `.chord-eval-cache/` only when `CHORD_EVAL_FETCH=1`). A duration delta
   of more than a few seconds usually means the track has been edited,
   re-mastered, or replaced upstream.

The `_schema` block at the top of `chord_eval_songs.json` is the source of
truth for the eval's constraints: `allowed_licenses`, `excluded_licenses`,
`genre_target` (4 pop / 4 rock / 2 folk / 2 jazz / 2 electronic / 2 classical
/ 4 wildcards), and the verification protocol.

## Verification protocol (pass / fail / re-verify quarterly)

> **Never fabricate verification.** A row only becomes `verified` after a real,
> successful WebFetch of a page that renders the specific CC license.

### Pass criteria (all four must hold)

For each row, before flipping `verification_status` to `"verified"`:

1. **URL returns 200 OK** on WebFetch (not client_error, not JS-only shell).
2. **License on the fetched page matches the manifest** AND is in
   `_schema.allowed_licenses` — one of `CC0`, `CC BY 4.0`, `CC BY 3.0`,
   `CC BY-SA 4.0`, `CC BY-SA 3.0`, or `Public Domain`. Reject anything with
   `-NC`, `-ND`, "research only", "paid", or "all rights reserved".
3. **Artist name on the page matches the manifest** (allowing for minor
   capitalization / punctuation differences, e.g. "Jahzzar" vs "jahzzar").
4. **Duration on the page is within ±5 seconds** of `duration_sec` where
   the page shows it. If the duration is more than 5s off, correct the
   manifest's `duration_sec` in the same PR as the verification flip —
   do not quietly let future drift accrue.

Source-specific notes:

- **FMA** (`freemusicarchive.org`): the per-track page must show
  "licensed under a <license> License" linking to the CC legal code.
  Artist landing pages and album pages often defer to per-track info —
  use a `/music/<Artist>/<Album>/<Track>` URL, not `/music/<Artist>/`.
- **Jamendo**: use a direct `/track/<id>` URL. The search result pages
  are client-side rendered and WebFetch cannot see license tags on them.
  A per-track page must show the "CC BY" or "CC BY-SA" tag.
- **YouTube Audio Library**: verify the entry explicitly says
  "No attribution required" or carries a "CC BY" tag. Entries without
  a visible CC tag default to the standard YT Audio Library license,
  which **is not CC** and must not be used.
- **Incompetech** (Kevin MacLeod): the main music pages render license
  text as JS; use the FMA mirror for the same track where available, or
  quote `incompetech.com/music/royalty-free/licenses/` directly in the
  verification report.
- **Public Domain .gov / .mil**: verify the page itself asserts US
  Government public-domain status; a third-party claim is not enough.

### Fail criteria

Mark a row **`failed`** (and either replace it or leave it pending) if any
of these is true:

- URL returns a non-200 (404, 410, 5xx) and no mirror can be located.
- License on the page is in `_schema.excluded_licenses` (`CC BY-NC-*`,
  `CC BY-ND-*`, all-rights-reserved, YouTube-Content-ID-eligible).
- License on the page is in `allowed_licenses` but **does not match the
  manifest's recorded license** in a way that would change downstream
  attribution obligations (e.g. manifest says `CC0` but the page is
  `CC BY-SA 4.0` — correct the manifest, or replace).
- The track is clearly not the same recording as the manifest row
  (artist mismatch, obviously different length, obviously different
  genre).

### Re-verify quarterly

CC licenses can be changed by the artist. FMA artists have moved
individual tracks from CC BY-SA to CC BY-NC after years of being
freely available. Dexter Britain and Podington Bear are both known
to have done this.

Run the full verification pass **once per quarter** and whenever
a CI job that uses `CHORD_EVAL_FETCH=1` fails its download step:

```
# Full pass: verify every row's URL and update verification_status
python apps/worker/scripts/verify_chord_eval.py \
    --manifest apps/worker/tests/fixtures/chord_eval_songs.json \
    --out apps/worker/tests/fixtures/chord_eval_songs.verification.json
```

> The `verify_chord_eval.py` CLI is a planned follow-up. Until it lands,
> the verification pass is performed manually (via WebFetch / curl) and
> the companion `chord_eval_songs.verification.json` is updated by hand.

## How to replace a broken row

When a row fails verification (link rotted, license changed to CC BY-NC,
etc.), replace it rather than silently dropping it — the genre ratio in
`_schema.genre_target` is load-bearing for the eval's balance across
chord-density regimes.

1. **Pick a replacement track in the same genre slot.** Search FMA
   (`freemusicarchive.org/search?quicksearch=&music_type=music`) or the
   YouTube Audio Library's CC-filtered list. Prefer CC0 > CC BY 4.0 >
   CC BY-SA 4.0 in that order (fewer downstream obligations).
2. **Verify the replacement's license via WebFetch before committing.**
   A replacement that has not been WebFetched is as bad as a fabricated
   verification. Capture the exact URL, license, duration, and
   artist name that WebFetch reports.
3. **Update the row in-place** in `chord_eval_songs.json`:
   - `fma_id_or_jamendo_id` to a unique slug describing the new track
   - `title`, `artist`, `url`, `license`, `duration_sec`
   - Keep `genre` (do not change the genre slot)
   - Set `verification_status` to `"verified"`, add
     `verified_at` (today's date) and `verified_via: "webfetch"`
4. **Mirror the change in `chord_eval_songs.verification.json`** —
   add a new entry with `new_status: "verified"` and notes that explain
   why the previous row was replaced.
5. **Note the replacement in the PR body** so reviewers can see the
   ratio preservation at a glance:
   `N verified / N pending / K replaced (rows: X, Y, Z)`.

## Hard rules (do not break these)

- **Only CC0 / CC BY 4.0 / CC BY 3.0 / CC BY-SA 4.0 / CC BY-SA 3.0 /
  Public Domain.** Nothing else, ever, however convenient.
- **Never commit a row with `verification_status: "verified"` whose
  license has not been confirmed on a WebFetch-reachable page.** A row
  for which verification cannot currently be done stays `pending` with a
  `last_check_at` and `last_check_note` recording what was attempted.
- **CHORD_EVAL_FETCH=1 stays gated** until every row is `"verified"`.
  The gate protects staging from downloading audio under a license we
  have not confirmed.
