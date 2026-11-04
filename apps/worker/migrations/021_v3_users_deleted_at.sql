-- 021_v3_users_deleted_at.sql — add users.deleted_at tombstone for the RGPD
-- account-deletion flow (DELETE /api/users/me, TSD §6.3).
--
-- The route stamps deleted_at BEFORE calling Supabase Admin deleteUser. If a
-- step after the stamp fails (e.g. the Admin API is down) the row stays
-- tombstoned and the user can retry; the route is idempotent. Once
-- auth.users is deleted, public.users cascades away (013: ON DELETE CASCADE)
-- and so does the tombstone.
--
-- Partial index covers only tombstoned rows (normally zero), so a janitor
-- query for "deletions that never completed" stays cheap.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Append-only per §11 Merge Safety Rule (b).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS users_deleted_at_idx
  ON public.users (deleted_at) WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN public.users.deleted_at IS
  'Set by DELETE /api/users/me just before the Supabase auth user is deleted. Non-NULL on a surviving row means a deletion started but did not finish.';
