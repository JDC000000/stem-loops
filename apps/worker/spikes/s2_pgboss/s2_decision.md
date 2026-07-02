# S2 Decision Record — pg-boss Queue Validation

## Test setup
- pg-boss **10.4.2** against **Postgres 16** (local Docker; Supabase is wire-compatible Postgres).
- `validate.js`: enqueue 5 healthy jobs + 1 poison job, worker drains, poll queue to empty.

## Results (MEASURED — PASS)
- Poison job isolated: **YES** — it failed once (`retryLimit: 0`) and did **not** block the queue.
- Healthy jobs drained: **YES** — all 5 completed.
- Final queue size: **0**.
- `pgboss.job` end state: `completed=5, failed=1`.
- Max pool connections (configured): **3** → Supabase free-tier limit (15): **WITHIN**.
- Worker exit code: **0** (`S2 PASS: healthy jobs drained, poison isolated`).

## ⚠️ Architectural flag for the operator (affects the decision)
pg-boss is a **Node.js** library. In this stack the producer (Next.js API route) is Node and can use
pg-boss natively, **but the consumer (`apps/worker`) is Python** and cannot call pg-boss directly.
Two ways to reconcile, to decide at this gate:
- **(a)** Python worker polls the `pgboss.job` table via `SELECT … FOR UPDATE SKIP LOCKED`
  (this is essentially Option B's mechanism, while still using pg-boss for enqueue/retry/scheduling
  semantics on the producer side), or
- **(b)** a thin Node consumer process owns the queue and shells/RPCs into the Python pipeline.

The poison-isolation + connection-budget validation above holds either way. The open question is the
consumer integration, not whether pg-boss works.

## Decision
[ ] A: Confirm pg-boss for T4 (richer retry/scheduling semantics)
[ ] B: Fallback to raw `SELECT … FOR UPDATE SKIP LOCKED` (zero new dep, lowest connection overhead)

## Developer recommendation
**Confirm pg-boss (A)** for enqueue + retry + scheduled-job semantics, with the Python worker consuming
via `FOR UPDATE SKIP LOCKED` on `pgboss.job` (option (a) above). This keeps one durable Postgres-native
queue (no Redis — anti-goal #7) while respecting the Python worker boundary.

## Operator actions to open this gate
1. Re-run `validate.js` once against the real Supabase `DATABASE_URL` to confirm pooler limits.
2. Pick the consumer integration (a) or (b).

## Gate 0 Status
[ ] APPROVED by operator

---

## SUPERSEDED (2026-07-02) — Outcome: pg-boss removed, option B won in practice

The recommendation above (A: keep pg-boss, Python worker consumes `pgboss.job` via
`FOR UPDATE SKIP LOCKED`) was **never actually implemented**. What shipped is effectively
**option B**: the Next.js API enqueued to pg-boss, but the Python worker consumes the
`jobs` table directly via `SELECT … FOR UPDATE SKIP LOCKED` and **never called
`boss.work()`** — so pg-boss's retry/scheduling engine was never in the consume path.

A Phase-4 security re-verification flagged this: the "max 3 attempts, exponential
backoff" retry config on `pg-boss.send()` was dead config (config-theater) with zero
effect, and the real retry/re-drive is the worker-side reaper (`reaper.py`) + the T33
retention sweep (`cleanup.py`). With nothing consuming it, pg-boss was pure dead weight —
its enqueue records just accumulated (unconsumed) — and its presence was actively
misleading for future work.

**Decision reversed → remove pg-boss entirely.** Retry/attempt-cap/backoff now live in
`reaper.py` (bounded attempts + exponential backoff, BLOCKER #4). Queueing is the single
Postgres-native `jobs`-table `SKIP LOCKED` mechanism — still no Redis (anti-goal #7), one
fewer dependency, and no orphaned "config-theater". This entry keeps the record honest
rather than silently orphaning the original A recommendation.
