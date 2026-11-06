-- 031_v3_chord_edits_erase_fn_down.sql — drop the chord_edits erasure function. Run by hand only.
-- WARNING: with the function gone, stemloops_app has no way to delete a user's
-- chord_edits, so DELETE /api/users/me (the route that calls it) fails closed with a
-- 500 before cancelling anything. Roll the web code back first.
-- The runner does NOT remove the _migrations row: run
--   DELETE FROM _migrations WHERE filename = '031_v3_chord_edits_erase_fn.sql';
-- (check the column name in worker/migrate.py) or re-applying 031 is skipped.

DROP FUNCTION IF EXISTS public.delete_chord_edits_for_user(uuid);
