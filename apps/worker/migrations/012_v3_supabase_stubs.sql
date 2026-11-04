-- 012_v3_supabase_stubs.sql — minimal auth.users stub for bare Postgres CI.
--
-- 013 references auth.users (public.users.id FK + handle_new_user trigger),
-- and on Supabase the `auth` schema is created and managed by Supabase Auth.
-- Bare Postgres (CI, docker-compose local dev) has no `auth` schema, so 013
-- fails with `psycopg.errors.InvalidSchemaName: schema "auth" does not exist`.
-- #21 landed with failing CI because `--admin` bypassed the status check;
-- this hotfix restores green CI AND lets anyone run `make migrate` locally.
--
-- On Supabase (staging/prod), `auth.users` already exists with the full set
-- of columns Supabase Auth manages. Our `CREATE SCHEMA IF NOT EXISTS` and
-- `CREATE TABLE IF NOT EXISTS` are no-ops there. The stub has only the
-- columns 013 references (id, email); real Supabase users keep all their
-- auth-managed columns alongside.
--
-- Extra columns (aud, role, encrypted_password, ...) exist here so that
-- test fixtures inserting into auth.users via psycopg (see
-- apps/worker/tests/test_013_commercial_schema.py) have a shape to write to.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
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
