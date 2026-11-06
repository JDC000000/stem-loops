-- 031_v3_chord_edits_erase_fn.sql — a narrow, SECURITY DEFINER erasure path for
-- public.chord_edits so account deletion works without un-doing 025's append-only.
--
-- Why this exists:
--   025 makes chord_edits append-only for the app role (GRANT SELECT, INSERT;
--   REVOKE UPDATE, DELETE). DELETE /api/users/me still ran a raw
--       DELETE FROM public.chord_edits WHERE user_id = $1
--   which, as stemloops_app, raises 42501 (insufficient_privilege) even for zero
--   rows. The route cancelled the user's Stripe subscription and stamped
--   users.deleted_at first, so the user ended with a 500, a live account and a
--   cancelled subscription, and every retry failed identically.
--
--   chord_edits has no ON DELETE CASCADE on user_id (deliberate, see 025), so the
--   sweep is a required step before auth.admin.deleteUser; GDPR/RGPD erasure is
--   the one legitimate delete. Re-granting DELETE to stemloops_app would let the
--   app delete ANY ledger row and would undo 022-027. Instead:
--
--   public.delete_chord_edits_for_user(p_user_id uuid) RETURNS bigint
--     * SECURITY DEFINER: runs as the function owner (the migration role, which
--       owns chord_edits and therefore bypasses its RLS - 025 does not FORCE RLS).
--       stemloops_app itself still has no DELETE; the raw statement keeps failing.
--     * SET search_path = public, pg_temp: an unpinned DEFINER function is a
--       privilege-escalation vector (a caller-planted object in an earlier schema
--       shadowing a name). Same precedent as 013's handle_new_user().
--     * One predicate only: WHERE user_id = p_user_id. No caller-supplied filter,
--       no dynamic SQL. NULL is rejected (a silent 0-row no-op would hide a bug in
--       the caller and let the later FK failure look unrelated).
--     * EXECUTE: REVOKEd from PUBLIC (Postgres grants it to PUBLIC on every new
--       function) AND explicitly from anon/authenticated (Supabase default
--       privileges grant EXECUTE on new public functions to those roles directly,
--       which a PUBLIC revoke does not touch). Granted only to stemloops_app.
--   Trust boundary: the caller (web server, as stemloops_app) is trusted to pass
--   the authenticated user's id, exactly as it was trusted with the raw DELETE.
--   What is removed is the ability to delete other than "all rows of one user".
--
-- Return value: the number of rows erased (bigint). Cheap, leaks nothing, and lets
--   the route log/audit "erased N" and tests assert the delete really happened and
--   touched only that user. 0 is a valid result (user never edited a chord).
--
-- Order / chain: needs 025 (table) and 012 (anon/authenticated stubs), applied
--   immediately after 030 on a clean chain. Touches no data. Idempotent
--   (CREATE OR REPLACE; REVOKE/GRANT are repeatable).
--
-- DEPLOY ORDER: apply 031 BEFORE the web code that calls the function ships. The
--   route no longer tolerates a missing function (42883): it fails closed, before
--   cancelling anything.
--
-- Down: migrations/down/031_v3_chord_edits_erase_fn_down.sql. The runner does NOT
--   delete the _migrations row when a down file is run by hand; remove
--   `031_v3_chord_edits_erase_fn.sql` from _migrations yourself or re-applying
--   will be skipped.

CREATE OR REPLACE FUNCTION public.delete_chord_edits_for_user(p_user_id uuid)
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'delete_chord_edits_for_user: p_user_id must not be null'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  DELETE FROM public.chord_edits WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.delete_chord_edits_for_user(uuid) IS
  'Account-erasure path for append-only chord_edits: deletes ONLY the given user''s rows, SECURITY DEFINER, EXECUTE limited to stemloops_app. See migration 031 header.';

REVOKE ALL ON FUNCTION public.delete_chord_edits_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_chord_edits_for_user(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_chord_edits_for_user(uuid) TO stemloops_app;
