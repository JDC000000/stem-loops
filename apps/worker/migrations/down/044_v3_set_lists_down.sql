-- 044_v3_set_lists_down.sql — drop set lists (#322). Run by hand only.
-- WARNING: discards every user's set lists and their items; re-applying 044 does not recover
-- them. The songs themselves (public.jobs) are untouched. The Demo set is code-defined and
-- is unaffected.
-- Deploy the web without the set-list routes FIRST: with the tables gone every
-- /api/set-lists route answers 500.
-- The runner never removes a _migrations row, so this file deletes 044's ledger row itself
-- (the 008 / 009 / 011 pattern); without it a re-apply of 044 would be skipped.

DROP TRIGGER IF EXISTS users_tombstone_delete_set_lists ON public.users;
DROP FUNCTION IF EXISTS public.delete_set_lists_for_tombstoned_user();
DROP TABLE IF EXISTS public.set_list_songs;
DROP TABLE IF EXISTS public.set_lists;
DELETE FROM public._migrations WHERE filename = '044_v3_set_lists.sql';
