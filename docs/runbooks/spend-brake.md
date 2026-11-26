# Runbook: the `spend_global` spend brake (D-1, #459)

One page. Every claim cites `file:line` at `v3/main` b98f12c. This runbook documents; it
grants nothing. **Jon only** writes the brake. Sessions and subagents never write
`kill_switches` (COMMON-RULES: no DB access; any prod SELECT is an orchestrator's A3 read).

## 1 · What it does

- One row in `public.kill_switches` with `scope = 'spend_global'`. `enabled = true` means
  ENGAGED = stopped (`apps/worker/migrations/008_fetch_gates.sql:3`; table at `008:11-17`:
  `scope`, `enabled`, `reason`, `set_by`, `set_at`).
- Seeded RELEASED (`enabled = false`) by migration 035
  (`apps/worker/migrations/035_v3_spend_global_brake.sql:58-62`). A re-run never resets an
  engaged row (`ON CONFLICT DO NOTHING`, `035:53-57`, `035:62`).
- Checked in exactly one place: `consumer.claim_and_run`, before any job is claimed
  (`apps/worker/src/worker/consumer.py:114-122`; import at `consumer.py:42`). Engaged: the
  function returns without claiming, so jobs stay `queued` and nothing is spent. One check
  covers uploads and links, Replicate and Klangio (`035:18-22`, `consumer.py:117-118`).
- **Fail-closed.** Released only if the worker reads exactly one row and `enabled` is false;
  everything else is ENGAGED (`apps/worker/src/worker/spend_gate.py:9-18`, code at
  `spend_gate.py:103-109`, `spend_gate.py:128-138`):

  | Worker sees | Reason logged |
  |---|---|
  | `enabled = true` | `switch_engaged` |
  | no row (incl. deleted, RLS hid it, 035 not applied) | `row_absent` |
  | read error (REVOKE, timeout, connect failure) | `read_failed` |
  | no answer within 5 s | `read_timeout` |

- No cache: every poll (2 s while idle) reads the row afresh (`spend_gate.py:20-27`). The read
  is bounded: connect 3 s, statement/lock timeout 2 s, wall 5 s (`spend_gate.py:61-65`).
- **In-flight jobs are not stopped.** A job already claimed runs to completion; `cli.py
  test-job` is not gated (`spend_gate.py:39-42`).
- **Logs.** `WARN spend_brake_engaged reason=<…>` on every change, then at most once a minute
  while engaged; `INFO spend_brake_released` when it releases (`spend_gate.py:66-67`,
  `spend_gate.py:112-125`).
- **Long brake = refunds.** A job left `queued` past its `expires_at` (created_at + 24 h) is
  failed with a refund by the reaper (`apps/worker/src/worker/reaper.py:37-42`). Engaging for
  more than a day fails waiting jobs; it does not keep them.

## 2 · Read its state (read-only)

```sql
SELECT scope, enabled, reason, set_by, set_at FROM public.kill_switches WHERE scope = 'spend_global';
```

- One row, `enabled = f` → released. One row, `enabled = t` → engaged.
- **Zero rows → ENGAGED** (fail-closed, `035:24-29`). This is also the state of a database
  where migration 035 was never applied (`035:9-13`).
- Cross-check in worker logs: `spend_brake_engaged` / `spend_brake_released` (§1).

## 3 · Engage / release (Jon only)

Exact commands from `035:31-33` (a connection that can write `kill_switches`):

```sql
UPDATE kill_switches SET enabled = true,  reason = '<why>', set_by = '<you>', set_at = now() WHERE scope = 'spend_global';  -- engage
UPDATE kill_switches SET enabled = false, reason = '<why>', set_by = '<you>', set_at = now() WHERE scope = 'spend_global';  -- release
```

- **Never `DELETE` the row.** Deleting it ENGAGES the brake, and a release `UPDATE` then
  matches zero rows, so the brake stays engaged (`035:27-29`). The down migration deletes it
  too (`apps/worker/migrations/down/035_v3_spend_global_brake_down.sql:6`, `:9`).
- If the row is missing and Jon wants it released, re-insert it released. This is the seed
  statement from `035:58-62` (with your own reason/set_by):
  `INSERT INTO public.kill_switches (scope, enabled, reason, set_by) VALUES ('spend_global', false, '<why>', '<you>') ON CONFLICT (scope) DO NOTHING;`
- The scope is CHECK-constrained; a typo like `'Spend_Global'` is rejected, not silently
  ignored (`035:35-45`, `035:64-79`). `UPDATE … WHERE scope = '<typo>'` still matches zero
  rows without error, so always read back (§4).
- Takes effect on the next claim attempt: within one 2 s poll plus up to 5 s for the read,
  plus the run time of a job already in flight (`spend_gate.py:24-27`).

## 4 · Verify (read-back)

1. Run the §2 SELECT. Expect one row with the `enabled` value you set, your `reason`,
   `set_by`, and a fresh `set_at`. An `UPDATE 0` result from §3 means nothing changed.
2. Worker logs within ~10 s: engage → `WARN spend_brake_engaged reason=switch_engaged`;
   release → `INFO spend_brake_released`. Engaged with `reason=row_absent` / `read_failed`
   means the worker cannot see the row (§1 table): fix that, do not just re-run the UPDATE.
3. After release: the next `queued` job is claimed (`INFO job_claimed`, `consumer.py:139`).

## 5 · Who

- **Jon:** engage, release, re-seed. Record the reason in `reason` (it is shown in the
  `spend_brake_engaged` log only as the reason code; the text stays in the row).
- **Orchestrators:** may run the §2 SELECT under A3 and ask Jon. **Subagents:** never.
- Related: [deploy rollback](deploy-rollback.md),
  [chords `submitting` sentinel](chords-submitting-sentinel.md).
