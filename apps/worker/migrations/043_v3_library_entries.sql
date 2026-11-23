-- 043_v3_library_entries.sql — the song library keeps every song after its audio is gone
-- (Phase B, B1; user stories 1.8, 5.2-5.4; brief D-a; privacy decision PB-1).
--
-- WHAT THIS ADDS
--   1. public.library_entries — one row per song a signed-in user made whose JOB the retention
--      sweep has removed. The row is METADATA keyed by source (brief D-a), never a pointer to a
--      job: there is NO job_id column. An entry exists only once its job is swept; until then
--      the job row itself is the library row.
--        input_kind         'youtube' | 'upload' (copied from jobs.input_kind)
--        youtube_url        the job's canonical link (NULL for an upload). A link entry resolves
--                           by URL: while the same user has a live job of the same URL (done
--                           and retained, or in flight) the library lists that job, not the
--                           entry, so a Re-make never shows twice (AC 7).
--        original_filename  the uploaded file's name (NULL for a link). An upload entry offers
--                           "Upload again", never Re-make: there is nothing to re-fetch (Q3).
--        title, video_id, bpm, musical_key   the snapshot the page shows ("Audio expired").
--        first_created_at   when the song was first made (the swept job's created_at);
--        updated_at         when the snapshot last changed (a later sweep of the same URL).
--      user_id NOT NULL, ON DELETE CASCADE: an entry belongs to exactly one account and goes
--      with it (account deletion deletes public.users; D-b).
--      UNIQUE (user_id, youtube_url) WHERE youtube_url IS NOT NULL: one entry per link per
--      user. The sweep UPSERTs on it, so re-making and re-sweeping a song refreshes the one row.
--
--   2. WRITERS. Only the worker's retention sweep writes entries (cleanup._sweep_expired_jobs):
--      after a job's R2 objects are deleted it UPSERTs the entry from the job row and then, in
--      the SAME transaction, deletes (or, for a ledger-bound job, anonymises) the job. Only an
--      owned, `done`, non-demo, not-yet-anonymised job of an owner who is NOT tombstoned gets an
--      entry. The web only reads entries and deletes one on "Remove" (owner-scoped,
--      app/api/library/[entryId]). Re-make never writes an entry (it starts a new job).
--
--   3. Backstop: AFTER UPDATE OF deleted_at ON public.users deletes the user's entries the
--      moment the account is tombstoned (DELETE /api/users/me), so they are gone even if the
--      later Supabase Admin delete (which cascades public.users) fails. SECURITY DEFINER with a
--      pinned search_path (the 013 / 044 pattern): it deletes as the migration role, so it works
--      whichever role stamps the tombstone, including one that holds UPDATE on users but no
--      DELETE on library_entries. It can only delete the entries of the row being tombstoned
--      (NEW.id). EXECUTE revoked from PUBLIC, anon, authenticated.
--
-- RLS: backend-only (the 028 / 041 / 042 / 044 pattern). The web connects as stemloops_app,
--   whose policy admits every row; ownership is enforced in every route from getUser()
--   (`library_entries.user_id = <session user>`, app/api/library/**). anon / authenticated get
--   nothing (Supabase grants them ALL on new public tables by default, so the REVOKE is
--   load-bearing). No auth.uid() policy, so no M-3 stub is needed.
--
-- DEPLOY ORDER: Jon applies 043 -> merge -> deploy worker (cleanup.py changed) -> web deploys.
--   Either code half before 043 is safe: the worker's snapshot runs in a SAVEPOINT and treats
--   only "relation does not exist" (42P01) as "not migrated yet" (the job is swept exactly as
--   before, with no entry), and the web treats 42P01 as "no entries" (GET /api/library lists
--   the jobs as before; Re-make and Remove answer 404).
--
-- APPLYING IT to staging or production needs Jon (migration on a deployed database):
--   `make migrate` with that DATABASE_URL, or paste this file into the SQL editor and then
--       INSERT INTO public._migrations(filename) VALUES ('043_v3_library_entries.sql');
--   Verify afterwards:
--       SELECT to_regclass('public.library_entries');                                -- not null
--       SELECT relrowsecurity FROM pg_class WHERE oid = 'public.library_entries'::regclass;  -- t
--       SELECT has_table_privilege('anon', 'public.library_entries', 'SELECT');       -- f
--       SELECT indexname FROM pg_indexes WHERE indexname = 'library_entries_user_url_key'; -- 1 row
--       SELECT tgname FROM pg_trigger WHERE tgname = 'users_tombstone_delete_library_entries'; -- 1 row
--       SELECT has_function_privilege('anon',
--         'public.delete_library_entries_for_tombstoned_user()', 'EXECUTE');           -- f
--
-- Idempotent: IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE / guarded DO block.
-- Down: migrations/down/043_v3_library_entries_down.sql.
--
-- rls-backend-only: library_entries

CREATE TABLE IF NOT EXISTS public.library_entries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  input_kind        text        NOT NULL,
  youtube_url       text        NULL,
  original_filename text        NULL,
  title             text        NULL,
  video_id          text        NULL,
  bpm               real        NULL,
  musical_key       text        NULL,
  first_created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_entries_kind_check CHECK (input_kind IN ('youtube', 'upload')),
  CONSTRAINT library_entries_link_has_url CHECK (input_kind <> 'youtube' OR youtube_url IS NOT NULL),
  CONSTRAINT library_entries_upload_no_url CHECK (input_kind <> 'upload' OR youtube_url IS NULL)
);

-- One entry per link per user; the sweep's UPSERT target (ON CONFLICT ... WHERE youtube_url
-- IS NOT NULL). Uploads (youtube_url NULL) are never merged.
CREATE UNIQUE INDEX IF NOT EXISTS library_entries_user_url_key
  ON public.library_entries (user_id, youtube_url) WHERE youtube_url IS NOT NULL;

-- The library read: one user's entries, newest first.
CREATE INDEX IF NOT EXISTS library_entries_user_idx
  ON public.library_entries (user_id, first_created_at DESC);

ALTER TABLE public.library_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stemloops_app_all ON public.library_entries;
CREATE POLICY stemloops_app_all ON public.library_entries
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.library_entries TO stemloops_app;
REVOKE ALL ON public.library_entries FROM anon, authenticated;

-- cowork_ro read path (§A3 pattern). No-op where cowork_ro does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'library_entries' AND policyname = 'cowork_ro_read'
    ) THEN
      CREATE POLICY cowork_ro_read ON public.library_entries
        FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.library_entries IS
  'A signed-in user''s song kept after its job was swept: link/file name, title, BPM, key; no job_id. See migration 043 header.';

-- Backstop: a tombstoned account keeps no library entries (D-b).
CREATE OR REPLACE FUNCTION public.delete_library_entries_for_tombstoned_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.library_entries WHERE user_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_library_entries_for_tombstoned_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_library_entries_for_tombstoned_user() FROM anon, authenticated;

DROP TRIGGER IF EXISTS users_tombstone_delete_library_entries ON public.users;
CREATE TRIGGER users_tombstone_delete_library_entries
  AFTER UPDATE OF deleted_at ON public.users
  FOR EACH ROW
  WHEN (NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.delete_library_entries_for_tombstoned_user();
