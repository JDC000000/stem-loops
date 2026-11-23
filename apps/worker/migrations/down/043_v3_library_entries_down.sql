-- 043_v3_library_entries_down.sql — drop the song library's kept entries (Phase B, B1). Run by
-- hand only.
-- WARNING: discards every user's expired-song entries (link / file name, title, BPM, key);
-- re-applying 043 does not recover them. Live songs (public.jobs) are untouched.
-- Safe for the code in either order: the worker's sweep snapshot and the web's library routes
-- treat "relation does not exist" (42P01) as "not migrated yet" (no entries; Re-make and
-- Remove answer 404).
-- The runner never removes a _migrations row, so this file deletes 043's ledger row itself
-- (the 008 / 009 / 011 / 044 pattern); without it a re-apply of 043 would be skipped.

DROP TRIGGER IF EXISTS users_tombstone_delete_library_entries ON public.users;
DROP FUNCTION IF EXISTS public.delete_library_entries_for_tombstoned_user();
DROP TABLE IF EXISTS public.library_entries;
DELETE FROM public._migrations WHERE filename = '043_v3_library_entries.sql';
