# Pricing review trigger — 10 users OR 100 song sessions

Recorded 2026-11-11 alongside migration `034_v3_pricing_model_truth.sql`.

> Jon, 2026-11-11: *"lets review this once we have 10 users OR 100 song sessions
> to get real cost per song from"*

Deliberately **not** a scheduled task. The trigger is a condition, not a date,
and the numbers are two cheap counts — so this is one read-only query to run
whenever anyone wonders, rather than a cron job that emails a `false` every week
for the next several months.

## The query — run this, nothing else needed

Read-only, single statement, returns one row with the answer in the last column.

```sql
BEGIN READ ONLY;
SELECT
  (SELECT count(*) FROM public.users WHERE deleted_at IS NULL)                     AS users,
  (SELECT count(*) FROM public.jobs WHERE status = 'done')                         AS song_sessions,
  (SELECT count(*) FROM public.users WHERE deleted_at IS NULL) >= 10
    OR (SELECT count(*) FROM public.jobs WHERE status = 'done') >= 100             AS review_pricing_now;
ROLLBACK;
```

`review_pricing_now = true` → re-price. Until then, nothing to do.

## Baseline, measured 2026-11-11 (read-only against production)

| metric | threshold | value on 2026-11-11 | remaining |
|---|---|---|---|
| `users` (active, `deleted_at IS NULL`) | **10** | **1** | 9 |
| `song_sessions` (`jobs.status = 'done'`) | **100** | **4** | 96 |
| `review_pricing_now` | — | **false** | — |

For context, not part of the trigger: 5 jobs total (4 `done`), 2 of them tied to
an authenticated user, 1 `entitlements` row, **0 subscriptions**.

### Why these two definitions

- **users** counts `public.users` excluding soft-deleted rows, because migration
  021 added `deleted_at` and a deleted account is not a user you can learn a cost
  per song from. `auth.users` is deliberately not the source — `public.users` is
  what the app's own entitlement path reads.
- **song sessions** counts **completed** jobs (`status = 'done'`), not all jobs. A
  failed or queued job incurs partial or zero Replicate spend, so counting it
  would inflate the denominator of exactly the cost-per-song figure this review
  exists to establish. On 2026-11-11 that distinction is 4 vs 5 — a 25% error at
  this sample size.

## What the review is FOR — the cost data, and its limits

The approved prices ($4.99 for 50 tracks, $12 for 150) imply a per-track cost
ceiling. The only measured cost today is:

| statistic | value (USD per job) |
|---|---|
| median Replicate spend | **$0.0288** |
| mean | **$0.0298** |
| max | **$0.0446** |
| sample size | **4 jobs** |

⚠️ **State both caveats wherever a margin is quoted:**

1. **n = 4.** Four jobs is not a distribution. The max is already 55% above the
   median, and nothing here says what a 9-minute track costs.
2. **It measures Replicate only.** **Klangio, R2 storage, R2 egress, Vercel and
   Fly are all unmeasured.** Klangio in particular is a $99/month floor with 500
   included requests and $0.20 each beyond (see migration 028), which at low
   volume dominates per-song cost completely — at 4 songs a month the Klangio
   subscription alone is ~$25/song, roughly 850× the Replicate figure.

So the honest position is: **Replicate is cheap and well inside the price
points; total cost per song is not yet known.** That is precisely what the
trigger is for — do not treat the Replicate number as the cost per song.

### What to add to the measurement before the review fires

So that the review has something better than Replicate-only when it does fire:

- Klangio request counts per cycle are already durable in `public.klangio_usage`
  (migration 028) — joinable to a cycle cost.
- R2 storage and egress are not instrumented. Retention is 24 h per migration
  007, which bounds storage but not egress.
- Vercel and Fly are flat-ish at this scale and can reasonably be amortised
  rather than attributed per song.

## Related

- Plan values: `apps/worker/migrations/034_v3_pricing_model_truth.sql` (source of truth)
- Model and rationale: `04-tsd-and-workplan/TSD-V3-DELTA.md` §1.2, §1.2b, and the
  v1.7 → v1.8 changelog
- **Open decision O-8** (TSD §11): whether to reverse the §1.2a link-ingest
  separation so paid tiers get YouTube import. Unresolved, and it is the one
  cell of the approved pricing table that migration 034 does not implement.
