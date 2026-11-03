-- Migration 009 (SL-B26 #1): RLS catch-up on V2-era tables.
--
-- Context: 001-008 predate V3 auth. These tables have NO user_id column —
-- they're keyed by client_ip_hash + device fingerprint (V2 anonymous RL).
-- V3's account tables (010+) will carry user_id and auth.uid()-based policies.
--
-- This migration establishes a default-deny posture on the existing tables.
-- In Supabase, the `service_role` is BYPASSRLS, so the worker/API continues
-- to read and write without any policy evaluation. In vanilla Postgres (dev
-- and CI), the table owner also bypasses RLS by default (no FORCE), so the
-- test suite is unaffected. anon and authenticated get nothing — no
-- permissive policies exist for those roles.
--
-- The explicit service_role policy below exists so the CI RLS gate (which
-- asserts every table has at least one CREATE POLICY) stays green. If the
-- service_role role is absent (bare Postgres), we create it NOLOGIN so the
-- policy's TO clause has a valid grantee.
--
-- Idempotent per the migrations/README convention. Down: down/009_rls_catchup_down.sql.

-- 1. Ensure the service_role grantee exists (noop in Supabase).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END$$;

-- 2. Enable RLS and lock table-level privileges on every V2-era table.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs',
    'job_events',
    'loops',
    'upload_rate_events',
    'kill_switches',
    'blocklist',
    'fetch_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('GRANT ALL ON %I TO service_role', t);
  END LOOP;
END$$;

-- 3. One explicit service_role bypass policy per table (satisfies CI gate).
--    In Supabase this is redundant (BYPASSRLS wins); in vanilla PG it makes
--    the posture declarative. Nothing is granted to anon or authenticated.
DO $$
DECLARE
  t text;
  pname text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs',
    'job_events',
    'loops',
    'upload_rate_events',
    'kill_switches',
    'blocklist',
    'fetch_attempts'
  ] LOOP
    pname := t || '_service_role_all';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pname, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      pname, t
    );
  END LOOP;
END$$;
