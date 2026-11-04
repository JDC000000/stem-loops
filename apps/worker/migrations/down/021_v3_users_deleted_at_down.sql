-- 021_v3_users_deleted_at_down.sql — reverse the deleted_at column + partial
-- index on public.users. Idempotent: DROP ... IF EXISTS.

DROP INDEX IF EXISTS public.users_deleted_at_idx;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS deleted_at;
