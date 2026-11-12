-- 035_v3_spend_global_brake.sql — the `spend_global` brake, and a CHECK on kill_switches.scope.
--
-- ============================ DEPLOY ORDER (READ FIRST) ============================
--   1. APPLY THIS MIGRATION.            (`make migrate` against production)
--   2. CONFIRM it is recorded:          SELECT 1 FROM _migrations WHERE filename = '035_v3_spend_global_brake.sql';
--                                       SELECT enabled FROM kill_switches WHERE scope='spend_global';  -- one row, f
--   3. ONLY THEN DEPLOY THE WORKER.     (`make deploy-worker`)
--
--   A worker that carries `worker.spend_gate` and runs against a database WITHOUT the
--   `spend_global` row below treats the missing row as ENGAGED (that is the point of the
--   fail-closed rule). It does not crash and it spends nothing, but it also CLAIMS NOTHING:
--   every job stays `queued` and the site shows "waiting" until step 1 is done.
--   Wrong order = a stalled queue, not an outage and not a spend. Right order = no stall.
--   (2026-11-11 is the reason this paragraph exists: web code shipped ahead of its migration
--   and every job page returned HTTP 500 for two hours.)
-- ===================================================================================
--
-- WHAT THE BRAKE IS. `kill_switches.enabled = TRUE` means ENGAGED = stopped (008). A row
-- with scope 'spend_global' is checked by `consumer.claim_and_run` BEFORE a job is claimed.
-- Engaged: nothing is claimed, jobs stay `queued` with nothing spent, and they resume when
-- the brake is released. One check covers both input paths (upload and link) and both
-- paid providers (Replicate and Klangio).
--
-- FAIL-CLOSED. For this scope a MISSING ROW MEANS ENGAGED, and so does a row the worker
-- cannot read (REVOKE SELECT, an RLS policy dropped on this table, a statement/lock
-- timeout, a shadowing schema). That closes those cases as a class instead of one at a
-- time. It also means the row must EXIST for the brake to be released: this migration seeds
-- it as released (enabled = false), and `DELETE FROM kill_switches WHERE scope='spend_global'`
-- is therefore a way of ENGAGING the brake, not of releasing it.
--
-- Operator commands (a connection that can write kill_switches):
--     UPDATE kill_switches SET enabled = true,  reason = '<why>', set_by = '<you>', set_at = now() WHERE scope = 'spend_global';  -- engage
--     UPDATE kill_switches SET enabled = false, reason = '<why>', set_by = '<you>', set_at = now() WHERE scope = 'spend_global';  -- release
--
-- THE SCOPE CHECK. `scope` was free text, so 'Fetch_Global', 'fetch-global' and 'global'
-- were all accepted and all silently did nothing. A typo that quietly disables a brake is
-- the same defect class as the brake. The list below is:
--   READ BY CODE today:           fetch_global, fetch_youtube, fetch_cobalt (fetch_gates.py), spend_global (this).
--   DOCUMENTED BY 008, NO READER: fetch_spotify, serve_mix_first, payments_r. Kept, so a row an operator
--                                 may already have for one of them does not trip the check.
--   DELIBERATELY NOT LISTED:      v3_play and use_proxy_reserve, which TSD-V3-DELTA names but which no code
--                                 reads and 008 never listed. Rejecting them is the point: an INSERT of a
--                                 switch nothing reads is exactly the "silently does nothing" defect. If a
--                                 reader for either is ever built, its migration widens this list.
-- Adding a scope later means a migration that widens the list — deliberately, so a new scope is a reviewed change.
--
-- EXISTING ROWS. The constraint is added NOT VALID, so it rejects every new INSERT/UPDATE of
-- a bad scope immediately without ever failing this migration on a row it cannot see from
-- here. It is then VALIDATED only if no existing row violates it; otherwise the migration
-- RAISEs a WARNING naming the offending scopes and leaves the constraint NOT VALID (still
-- enforced for new writes). A pre-existing bad row is a switch that has been doing nothing.
--
-- Idempotent: ON CONFLICT DO NOTHING (an engaged row is NOT reset to released by a re-run) /
-- guarded DO blocks. Down: migrations/down/035_v3_spend_global_brake_down.sql.

-- 1. Seed the brake RELEASED. DO NOTHING on conflict: re-running must never release a
--    brake an operator engaged.
INSERT INTO public.kill_switches (scope, enabled, reason, set_by)
VALUES ('spend_global', false,
        'spend brake: released. Set enabled = true to stop claiming jobs; a missing row is treated as engaged.',
        'migration 035')
ON CONFLICT (scope) DO NOTHING;

-- 2. The scope CHECK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.kill_switches'::regclass
      AND conname = 'kill_switches_scope_known'
  ) THEN
    ALTER TABLE public.kill_switches
      ADD CONSTRAINT kill_switches_scope_known
      CHECK (scope IN (
        'fetch_global', 'fetch_youtube', 'fetch_spotify', 'fetch_cobalt',
        'serve_mix_first', 'payments_r', 'spend_global'
      )) NOT VALID;
  END IF;
END $$;

-- 3. Validate when nothing violates it; otherwise say so loudly and leave it NOT VALID.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(quote_literal(scope), ', ' ORDER BY scope) INTO bad
  FROM public.kill_switches
  WHERE scope NOT IN (
    'fetch_global', 'fetch_youtube', 'fetch_spotify', 'fetch_cobalt',
    'serve_mix_first', 'payments_r', 'spend_global'
  );
  IF bad IS NULL THEN
    ALTER TABLE public.kill_switches VALIDATE CONSTRAINT kill_switches_scope_known;
  ELSE
    RAISE WARNING 'kill_switches_scope_known left NOT VALID: existing rows with unknown scope % '
                  '(these switches have never matched anything the code reads). Fix or delete them, '
                  'then: ALTER TABLE public.kill_switches VALIDATE CONSTRAINT kill_switches_scope_known;', bad;
  END IF;
END $$;

COMMENT ON CONSTRAINT kill_switches_scope_known ON public.kill_switches IS
  'scope must be one of the documented switches; a typo used to be accepted and silently do nothing (migration 035).';
