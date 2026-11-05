-- 028_v3_klangio_usage.sql — durable, cross-instance counter for paid Klangio
-- requests. Backs _PostgresQuotaStore in worker/chord_providers/klangio.py.
--
-- Why this exists:
--   Klangio is $99/month with 500 included requests and $0.20 per request
--   beyond that. The first spend guard kept its counter in a flock-guarded
--   JSON file, which resets on every Fly deploy/restart and is per-machine.
--   One row per billing cycle here survives both, and is shared by every
--   worker instance.
--
-- Atomic reserve (the whole point of this table — one statement, no
-- read-then-write, so two instances cannot both take the last slot):
--
--   INSERT INTO public.klangio_usage (cycle_start, count)
--   SELECT :cycle::date, 1 WHERE :cap > 0
--   ON CONFLICT (cycle_start) DO UPDATE
--     SET count = klangio_usage.count + 1, updated_at = now()
--     WHERE klangio_usage.count < :cap
--   RETURNING count;
--
--   A returned row = slot granted. No row = at cap, refuse. The ON CONFLICT
--   row lock serialises racers, and under READ COMMITTED the loser re-evaluates
--   the WHERE against the winner's committed row. `WHERE :cap > 0` closes the
--   one hole in the obvious shape: a first INSERT never evaluates the
--   DO UPDATE ... WHERE, so a cap of 0 would otherwise admit one request.
--
-- cycle_start is the billing-cycle anchor (the 5th by default) computed by the
-- worker, so a new cycle is simply a new row; old rows are kept as spend history.
--
-- RLS: backend-only. Written and read only by the worker role (stemloops_app);
-- never by end users. REVOKE DELETE/TRUNCATE on purpose: deleting the row
-- would reset the counter and silently re-open the spend cap (see 017, 027).
--
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS / guarded DO block.
-- Down: migrations/down/028_v3_klangio_usage_down.sql.

-- rls-backend-only: klangio_usage

CREATE TABLE IF NOT EXISTS public.klangio_usage (
  cycle_start date        PRIMARY KEY,
  count       integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT klangio_usage_count_nonneg CHECK (count >= 0)
);

ALTER TABLE public.klangio_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stemloops_app_all ON public.klangio_usage;
CREATE POLICY stemloops_app_all ON public.klangio_usage
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.klangio_usage TO stemloops_app;
REVOKE DELETE, TRUNCATE ON public.klangio_usage FROM stemloops_app;
REVOKE ALL ON public.klangio_usage FROM anon, authenticated;

-- cowork_ro read path (§A3 pattern). No-op on CI / fresh DBs where cowork_ro
-- does not exist; idempotent on repeat application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'klangio_usage' AND policyname = 'cowork_ro_read'
    ) THEN
      CREATE POLICY cowork_ro_read ON public.klangio_usage
        FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.klangio_usage IS
  'Paid Klangio requests per billing cycle (cycle_start = cycle anchor date). Atomic cap-checked increment; see migration header.';
