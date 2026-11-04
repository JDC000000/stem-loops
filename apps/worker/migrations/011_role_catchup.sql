-- Migration 011 (ledger SL-B26, audit-1 blocker #1): role + policy catchup.
--
-- Context: migration 009 shipped RLS on the 7 V2-era tables, but with the
-- wrong role (service_role) and policy name (<table>_service_role_all). The
-- correct template, per the handoff file
--   00-handoff-from-prior-build/stem-loops-handoff/10-db-rls-and-roles.sql
-- (§A1/A2/A3 + §B), is `stemloops_app` role + `stemloops_app_all` policy +
-- SCHEMA USAGE + per-table CRUD grants + default privileges + the A3
-- cowork_ro_read block that activates when cowork_ro exists.
--
-- Prod state (per handoff verified 2026-11-02): all 8 tables already have
-- stemloops_app_all policies applied out-of-band. This migration brings
-- staging and any new rebuild in line with prod, AND drops the wrong policies
-- 009 installed on top. Idempotent per migrations/README.
--
-- Down: migrations/down/011_role_catchup_down.sql.

-- A1. ensure stemloops_app role exists (fresh DB only; on prod/Supabase it
--     already exists as LOGIN and this is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stemloops_app') THEN
    CREATE ROLE stemloops_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO stemloops_app;

-- Drop 009's incorrect <table>_service_role_all policies so the real
-- stemloops_app_all policy is the sole FOR ALL policy per table. Harmless
-- if the policy was never created (e.g. fresh DB that skipped 009).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs','job_events','loops','upload_rate_events',
    'kill_switches','blocklist','fetch_attempts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   t || '_service_role_all', t);
    -- Undo 009's REVOKE ALL FROM PUBLIC (PUBLIC never had any policy so the
    -- REVOKE was a no-op anyway; this is belt-and-suspenders).
    EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
  END LOOP;
END $$;

-- B. per-table catch-up: ENABLE RLS (idempotent) + stemloops_app_all policy +
-- CRUD grants. Includes the three 008-era tables and the five V2 tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs','job_events','loops','upload_rate_events',
    'kill_switches','blocklist','fetch_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS stemloops_app_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY stemloops_app_all ON public.%I FOR ALL TO stemloops_app USING (true) WITH CHECK (true)',
      t);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO stemloops_app',
      t);
  END LOOP;
END $$;

-- Sequences used by these tables — grant USAGE + SELECT to stemloops_app.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stemloops_app;

-- Default privileges so every future table/sequence this migration-runner
-- creates is already accessible to stemloops_app. Mirrors prod read-back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stemloops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stemloops_app;

-- A3. cowork_ro_read policy on every public table, only if cowork_ro exists.
-- No-op on CI and fresh DBs (role doesn't exist there). On prod/staging where
-- Jon has set up cowork_ro per handoff §C, this makes diagnostic reads actually
-- return rows instead of silently returning 0.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = t AND policyname = 'cowork_ro_read'
      ) THEN
        EXECUTE format(
          'CREATE POLICY cowork_ro_read ON public.%I FOR SELECT TO cowork_ro USING (true)',
          t);
      END IF;
    END LOOP;
  END IF;
END $$;
