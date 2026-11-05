# Chord-edit flywheel — ops runbook (PR-Y1.7)

> Per decision record v1.3 (project doc
> `claude/phase-2-y1-chord-model-decision.md`, §Flywheel): user
> corrections to chord labels are the moat. Weekly fine-tune turns
> accumulated edits into a decoder that closes the accuracy gap on
> Chordify — the same loop Chordify ran for ~10 years. This runbook covers
> the Day-1 seed (migration 025, `/api/chord-edits`, client collector).
> Independent of Klangio / model: edits accrue regardless of which
> provider labeled the frame.

## Why it matters

| Signal              | What the row captures                                              |
| ------------------- | ------------------------------------------------------------------ |
| `original_label`    | What the provider / model returned for that frame                  |
| `corrected_label`   | What the user set it to (ground truth, under user responsibility)  |
| `track_hash`        | SHA-256 of the audio at edit time — a re-encode breaks the match   |
| `provider_version`  | Which decoder version produced the original label                  |
| `cqt_plan_version`  | Which CQT front-end was live (tie signals to feature shape)        |
| `alphabet_sha`      | SHA of the current 60-label Harte alphabet (training-data cohort)  |
| `original_confidence` | Provider's own confidence, when reported — down-weights "the model knew it was guessing" rows during fine-tune |

A mismatch in any of `provider_version`, `cqt_plan_version`, or
`alphabet_sha` means the row is from a DIFFERENT training distribution. The
weekly fine-tune MUST filter on all three; the training index is built
for that exact query.

## Schema

```
                                 chord_edits
                                 (append-only)
+------------------+                    ▲
| authenticated    |  INSERT /          |
| user (RLS)       |  SELECT own  ──────┘
+------------------+                    ▲
                                        │
+------------------+                    │
| stemloops_app    |  INSERT /          │
| (worker role)    |  SELECT only  ─────┘   UPDATE/DELETE REVOKEd (017 pattern)
+------------------+                    ▲
                                        │
+------------------+                    │
| cowork_ro        |  SELECT all   ─────┘   (fine-tune job's read path)
+------------------+
```

Full DDL: [`apps/worker/migrations/025_v3_chord_edits.sql`](../../apps/worker/migrations/025_v3_chord_edits.sql).

Invariants enforced in the DB (CHECK constraints — the API also
pre-validates for a cleaner 400):

- `end_sec > start_sec` — no zero-width or reversed frames
- `original_label <> corrected_label` — a row is a real correction
- `corrected_label` matches `^(N|X|[A-G](#|b)?(:[a-z0-9]+)?)$` — Harte-valid

Indexes:

- `chord_edits_training_idx(alphabet_sha, provider_version, created_at DESC)` — fine-tune read path
- `chord_edits_user_idx(user_id, created_at)` — Phase 4 sweep + self-read

## Weekly fine-tune query (training-data extract)

```sql
SELECT id, track_hash, start_sec, end_sec,
       original_label, corrected_label, original_confidence,
       provider, provider_version, cqt_plan_version
FROM public.chord_edits
WHERE alphabet_sha    = $1   -- current live alphabet
  AND provider_version = $2  -- current live decoder version
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;
```

Run as `cowork_ro`. The index is used; a 7-day window at p95 edits/week
should scan a single-digit page count.

## API surface

`POST /api/chord-edits` — one correction per call.

Request body (all required unless marked optional):

```jsonc
{
  "job_id":              "<uuid>",
  "track_hash":          "<sha256 hex>",
  "start_sec":           0.000,
  "end_sec":             2.000,
  "original_label":      "C",         // whatever the provider returned
  "corrected_label":     "C:min",     // Harte
  "provider":            "klangio",   // klangio | internal | autochord
  "provider_version":    "klangio@1.0",
  "alphabet_sha":        "<sha256 hex>",
  "original_confidence": 0.78,        // optional, [0, 1]
  "cqt_plan_version":    "cqt@v2"     // optional
}
```

Responses:

| Status | `error_code`             | When                                                   |
| -----: | ------------------------ | ------------------------------------------------------ |
| 201    | — (`{edit_id, created_at}`) | Row written                                       |
| 400    | `CHORD_EDIT_INVALID`     | Shape/type/field missing                               |
| 400    | `CHORD_EDIT_HARTE`       | `corrected_label` fails Harte regex                    |
| 400    | `CHORD_EDIT_TIME_RANGE`  | `end_sec <= start_sec`                                 |
| 400    | `CHORD_EDIT_SAME_LABEL`  | `original_label == corrected_label`                    |
| 401    | `UNAUTHENTICATED`        | No verified Supabase session                           |
| 429    | `RATE_LIMITED`           | Over 60 edits / user / hour (hourly `Retry-After`)     |
| 500    | `INTERNAL_ERROR`         | Everything else (logged to Sentry)                     |

## Client collector

`apps/web/src/chord/edit-collector.ts` exposes three entry points:

- `bufferChordEdit(edit)` — optimistic path the overlay UI calls. Puts the
  edit in a `localStorage` queue and kicks off a background flush. Survives
  a page refresh. Fire-and-forget on the returned promise.
- `submitChordEdit(edit)` — synchronous single-shot. Used by tests and by
  flows that must block on delivery.
- `flushBufferedEdits()` — drains the queue. Exponential backoff on network
  error; drops a row on a permanent 4xx (non-429) so one bad row can't
  wedge the queue.

The queue cap is 200 edits (oldest-first drop). Retries cap at 4 attempts
per edit.

## Rate-limit note (follow-up tracked)

The 60/user/hour limit is implemented as a `SELECT COUNT(*)` against
`chord_edits` within the POST handler. That is safe because the table is
append-only at `stemloops_app` (migration 025 REVOKEs UPDATE/DELETE), so
the counter cannot be erased from the app role. A longer-term swap to a
dedicated per-user rate-limit row is tracked in
`claude/project-tracker.md` under "Structural"; it depends on a generic
per-user rate-limit middleware that is not in the repo today.

## Privacy

A user's chord edits are their own data. The account-delete sweep (Phase
4) removes every row keyed on the user's `user_id` before the
`public.users` row is removed (chord_edits does NOT CASCADE from users —
the sweep is the audit trail). A user who exports their data will receive
their edits.

Nothing in `chord_edits` identifies the user beyond the `user_id` FK — no
IP, no device fingerprint, no email. The `track_hash` is a hash of the
uploaded audio content, not of the user.

## Change checklist

Before shipping a new chord-model version:

1. Bump `provider_version` wherever the client / worker emits it.
2. If the alphabet changes (e.g. 60 → 72 labels), bump `alphabet_sha` at
   the same deploy — never mix training samples across alphabets.
3. If the CQT front-end changes, bump `cqt_plan_version` similarly.
4. Confirm the weekly fine-tune filter uses the new values; old rows stay
   in the table but fall out of the weekly window naturally.

## References

- Decision record v1.3 (flywheel rationale): project doc
  `claude/phase-2-y1-chord-model-decision.md` §Flywheel
- TSD §1.6a data-capture contract: `04-tsd-and-workplan/TSD-V3-DELTA.md`
- Harte notation: Harte 2010, QM-DMI chord notation (the 60-label
  alphabet pinned by `alphabet_sha`)
- Migration 025: `apps/worker/migrations/025_v3_chord_edits.sql`
- 017 append-only REVOKE pattern:
  `apps/worker/migrations/017_v3_revoke_mutations_appendonly.sql`
