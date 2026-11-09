-- Supabase-like prelude for the migration matrix job (AGENTS.md §11 M-3).
--
-- WHY THIS EXISTS
-- ---------------
-- CI runs migrations against bare Postgres as a SUPERUSER. A superuser bypasses
-- every privilege check, and bare Postgres has no `auth` schema at all, so a
-- whole class of Supabase-only failure is invisible to CI. Migration 012 proved
-- it: on Supabase it raised `42501 permission denied for schema auth`, because
-- `CREATE TABLE IF NOT EXISTS auth.users` performs the schema CREATE-privilege
-- check BEFORE the IF-NOT-EXISTS short-circuit. CI stayed green. It was found
-- only by rehearsing against a real Supabase project on the day of the cutover.
--
-- CALIBRATION — every value below was read on 2026-11-06 from the live
-- Supabase project `stem-loops-cutover-rehearsal` (elruuvcyatnggkmegvzo,
-- PG 17.11), and independently confirmed against PRODUCTION `Stem-Loops`
-- (qthrhamfljhifhfwvvwj, PG 17.6). Both agree on all ten. Recalibrate
-- against PRODUCTION, not the rehearsal project, which is disposable. The CI job asserts ALL of them before running any
-- migration. Keep this list and the job's assertions identical: a prelude that
-- has drifted lets the job pass while testing nothing, which is this project's
-- house bug wearing the costume of its own cure.
--
--   has_database_privilege(role, db,   'CREATE')        = true
--   has_schema_privilege  (role,'auth','CREATE')        = false   <- the one that matters
--   has_schema_privilege  (role,'auth','USAGE')         = true
--   has_table_privilege   (role,'auth.users','SELECT')  = true
--   has_table_privilege   (role,'auth.users','TRIGGER') = true    <- 013 needs it
--   rolsuper      = false
--   rolbypassrls  = true
--   rolcreaterole = true
--   database owner      = the migration role        <- NOT a plain grant
--   public schema owner = pg_database_owner
--
-- WHY OWNERSHIP IS IN THAT LIST
-- -----------------------------
-- An earlier draft gave `migrator` a plain GRANT on `public` instead of making
-- it the database owner. Migration 011's `GRANT USAGE ON SCHEMA public TO
-- stemloops_app` then executed as `WARNING: no privileges were granted` —
-- psycopg swallows warnings, the chain stayed green, and the resulting ACL
-- silently differed from production. A silent no-op inside the gate built to
-- catch silent no-ops. The job now asserts the ACL after migrating.
--
-- Run as a superuser. The migration runner then connects as `migrator`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin')      THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')                THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')       THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator')       THEN CREATE ROLE authenticator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')        THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  -- NOLOGIN here: migration 011 creates it NOLOGIN on a fresh DB. On prod it is
  -- LOGIN, applied out of band. Immaterial to what this job exercises.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='stemloops_app')       THEN CREATE ROLE stemloops_app NOLOGIN; END IF;
  -- Stands in for Supabase's `postgres`: creates roles and databases, bypasses
  -- RLS, owns the database — but is NOT a superuser, which is the whole point.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='migrator')            THEN CREATE ROLE migrator LOGIN PASSWORD 'migrator' NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS; END IF;
END $$;

-- Live Supabase: postgres is a member of these WITH ADMIN OPTION. Without the
-- memberships a future migration using SET ROLE authenticated (a common
-- in-migration RLS smoke check) would be red here and green on Supabase.
GRANT anon, authenticated, authenticator, service_role, stemloops_app TO migrator WITH ADMIN OPTION;
GRANT pg_read_all_data, pg_monitor, pg_signal_backend TO migrator;

-- Ownership, per the note above.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO migrator', current_database()); END $$;
ALTER SCHEMA public OWNER TO pg_database_owner;
-- Deliberately NOT granting stemloops_app USAGE here: migration 011 must be the
-- thing that does it, so the post-migration ACL assertion is a real test.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- `auth` is owned by supabase_admin and `migrator` may NOT create in it.
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;
REVOKE CREATE ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO migrator, anon, authenticated, service_role, stemloops_app;
-- auth.users is owned by supabase_auth_admin on live Supabase, so that role
-- needs USAGE *and* CREATE on the schema supabase_admin owns. USAGE is easy to
-- miss: has_schema_privilege(role,'auth','CREATE') returns true without it, and
-- the CREATE TABLE still fails. That function answers a narrower question than
-- "can this role create here".
GRANT USAGE, CREATE ON SCHEMA auth TO supabase_auth_admin;

SET ROLE supabase_auth_admin;
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id        uuid,
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud                text,
  role               text,
  email              text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  phone              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULL::uuid $f$;
RESET ROLE;

-- 013 creates the on_auth_user_created trigger on auth.users and an FK to it.
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, REFERENCES ON auth.users TO migrator;
