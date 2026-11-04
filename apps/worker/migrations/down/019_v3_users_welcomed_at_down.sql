-- 019_v3_users_welcomed_at_down.sql — reverse the welcomed_at column +
-- partial index on public.users. Idempotent: DROP ... IF EXISTS.
--
-- Drop the partial index FIRST (the index depends on the column on some
-- Postgres versions; IF EXISTS makes it safe either way).

DROP INDEX IF EXISTS public.users_welcomed_at_null_idx;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS welcomed_at;
