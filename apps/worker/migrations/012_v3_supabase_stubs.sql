-- 012_v3_supabase_stubs.sql — minimal Supabase stubs for bare Postgres CI.
--
-- 013 depends on FOUR Supabase-managed things that bare Postgres (CI,
-- docker-compose local dev) does not have by default:
--   1. The `auth` schema and `auth.users` table (FK + trigger target)
--   2. The `authenticated` role (grantee in RLS policies)
--   3. The `anon` role (grantee in RLS policies for public reads on `plans`)
--   4. The `auth.uid()` helper function (used in `USING (auth.uid() = user_id)`)
--
-- #21 landed with failing CI because `--admin` bypassed the status check
-- when these failed; this hotfix restores green CI AND lets anyone run
-- `make migrate` locally. On Supabase (staging/prod), all four already
-- exist and every statement here is a no-op (IF NOT EXISTS guards).

-- 1. auth schema + minimal users table ----------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

-- Guarded so this is a true no-op on Supabase.
-- `CREATE TABLE IF NOT EXISTS` performs the schema CREATE-privilege check
-- BEFORE the IF-NOT-EXISTS short-circuit. On Supabase the `postgres` role
-- does NOT hold CREATE on the `auth` schema, so the bare statement raises
--   ERROR: 42501: permission denied for schema auth
-- even though auth.users already exists. A bare-Postgres rehearsal cannot
-- surface this because bare Postgres has no auth schema at all.
-- Verified against a real Supabase project 2026-11-06: the bare statement
-- fails, this guarded form succeeds as a no-op, and on bare Postgres the
-- CREATE still runs. See AGENTS.md M-3.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'auth' AND c.relname = 'users' AND c.relkind = 'r'
  ) THEN
    CREATE TABLE auth.users (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email              text,
      aud                text,
      role               text,
      encrypted_password text,
      email_confirmed_at timestamptz,
      phone              text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END
$guard$;

-- 2+3. authenticated and anon roles -------------------------------------
-- On Supabase these are LOGIN roles; here NOLOGIN suffices for the RLS
-- policies to reference them as grantees without needing actual sessions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;

-- 4. auth.uid() helper --------------------------------------------------
-- 013 and future RLS policies read `auth.uid()`. Supabase provides this
-- as a SECURITY DEFINER function that extracts the JWT sub claim. On
-- bare Postgres there is no JWT; return NULL so a policy like
-- `USING (auth.uid() = user_id)` returns no rows for an anonymous caller.
-- Tests that need a specific user id can override this per-transaction.
-- CREATE OR REPLACE is safe on Supabase too — it still returns the JWT sub.
-- EXCEPTION: we only install this stub if auth.uid() is NOT already defined,
-- to avoid overwriting Supabase's real function. Checked via pg_proc.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $f$
      CREATE FUNCTION auth.uid()
        RETURNS uuid
        LANGUAGE sql
        STABLE
      AS $body$
        SELECT NULL::uuid;
      $body$;
    $f$;
  END IF;
END $$;
