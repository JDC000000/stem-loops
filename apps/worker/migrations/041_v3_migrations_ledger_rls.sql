-- 041_v3_migrations_ledger_rls.sql — close public._migrations to the browser roles.
--
-- QA track B, finding B-01 (2026-11-18). The migration runner (apps/worker/src/worker/
-- migrate.py) creates public._migrations itself, so no migration ever enabled RLS on it
-- and scripts/check_rls.py (which read only migrations/*.sql) could not see it. On
-- Supabase, anon and authenticated hold ALL on every new public table by default, and the
-- publishable (anon) key ships in the browser bundle. Proved locally on a Supabase-like
-- scratch database: as anon, DELETE the 014 ledger row; the next routine `make migrate`
-- re-runs 014's seed and silently reverts the plans to the pre-034 pricing.
--
-- WHAT THIS DOES
--   1. ENABLE ROW LEVEL SECURITY, only if it is currently off.
--   2. REVOKE ALL from anon and from authenticated, each only if that role exists
--      (bare Postgres has neither) and still holds a privilege on the table. After the
--      REVOKE the privilege is re-checked and the block RAISES if it survived (a non-owner
--      without grant option gets only a WARNING from REVOKE, which would hide that).
--   It creates, alters and drops NO policy. The ledger is read and written only by the
--   migration role, which owns the table (an owner bypasses RLS unless FORCE is set) or has
--   BYPASSRLS. With RLS on and no policy for them, every other role sees no rows.
--
-- PER ENVIRONMENT (state read by Jon, read-only, 2026-11-18)
--   * production: RLS is already ON, with one policy `stemloops_app_all` for role
--     stemloops_app. Step 1 is skipped (and so never needs table ownership); that policy is
--     NOT touched. The only effective change is the REVOKE.
--   * staging: RLS is OFF. Step 1 turns it on; step 2 revokes.
--   * a fresh database: the runner already did both before it applied anything (its
--     ensure_ledger() runs the same guarded block on EVERY run), so this is a no-op there.
--
-- APPLYING IT to staging or production needs Jon's named approval (migration on a
-- deployed database). Either `make migrate` with that DATABASE_URL, or paste this file
-- into the SQL editor and then record it:
--     INSERT INTO public._migrations(filename) VALUES ('041_v3_migrations_ledger_rls.sql');
-- Verify afterwards (expect `t`, then no anon/authenticated rows):
--     SELECT relrowsecurity FROM pg_class WHERE oid = 'public._migrations'::regclass;
--     SELECT grantee, privilege_type FROM information_schema.role_table_grants
--      WHERE table_schema = 'public' AND table_name = '_migrations'
--        AND grantee IN ('anon', 'authenticated');
--
-- Deploy order: none needed. No application code reads the ledger as anon/authenticated.
--
-- Re-run safe: every step is guarded; a second run changes nothing.
-- Down: migrations/down/041_v3_migrations_ledger_rls_down.sql.
--
-- rls-backend-only: _migrations

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public._migrations'::regclass) THEN
    ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND (SELECT bool_or(has_table_privilege('anon', 'public._migrations', p))
            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
    REVOKE ALL ON TABLE public._migrations FROM anon;
    IF (SELECT bool_or(has_table_privilege('anon', 'public._migrations', p))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
      RAISE EXCEPTION 'public._migrations is still accessible to anon after REVOKE (run this as the table owner)';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (SELECT bool_or(has_table_privilege('authenticated', 'public._migrations', p))
            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
    REVOKE ALL ON TABLE public._migrations FROM authenticated;
    IF (SELECT bool_or(has_table_privilege('authenticated', 'public._migrations', p))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) THEN
      RAISE EXCEPTION 'public._migrations is still accessible to authenticated after REVOKE (run this as the table owner)';
    END IF;
  END IF;
END $$;
