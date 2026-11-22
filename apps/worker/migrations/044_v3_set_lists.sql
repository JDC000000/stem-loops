-- 044_v3_set_lists.sql — set lists (#322; Phase B, B2). Named, ordered groups of songs.
--
-- WHAT THIS ADDS
--   1. public.set_lists — one row per user list ("JAMS"). user_id NOT NULL, ON DELETE CASCADE:
--      a list belongs to exactly one account and goes with it. There is NO demo row: the
--      "Demo set" is defined in code (apps/web/src/lib/set-lists.ts DEMO_SET, from
--      lib/demo-catalog.ts) and resolved among is_demo jobs at read time (brief D-c), so no
--      route, sweep or account deletion can ever remove it.
--        name: 1-60 characters, already trimmed (the route trims; the CHECK refuses a name
--              that is not). Unique per user case-insensitively (set_lists_user_name_key on
--              (user_id, lower(name))).
--
--   2. public.set_list_songs — one row per item in a list. Items are METADATA keyed by
--      source (brief D-a), not a pointer that dies with the job:
--        source       'link' | 'upload' | 'demo'
--        job_id       the job it was added from. NULLABLE, ON DELETE SET NULL: the retention
--                     sweep deleting a Free link job must leave the item in the list
--                     ("Audio expired"), never take it out of the list (#322 AC 5).
--        youtube_url, video_id, title   a snapshot taken when the item is added. A LINK item
--                     plays the newest live job of the same user and URL, so re-pasting the
--                     URL after the sweep brings the item back with no list edit. UPLOAD and
--                     DEMO items resolve by job_id only (there is nothing to re-paste).
--        position     0-based order. UNIQUE (set_list_id, position) DEFERRABLE INITIALLY
--                     DEFERRED, so a reorder rewrites every position in one transaction and
--                     is checked once, at COMMIT (atomic reorder, AC 4).
--      UNIQUE (set_list_id, youtube_url) and UNIQUE (set_list_id, job_id): a song is in a list
--      at most once (NULLs are distinct, so many expired upload items may coexist). A song
--      may be in many lists.
--      Limits (50 lists per user, 200 songs per list) are constants in lib/set-lists.ts,
--      enforced by the routes under a per-user / per-list lock.
--
--   3. Backstop: AFTER UPDATE OF deleted_at ON public.users deletes the user's lists the
--      moment the account is tombstoned (DELETE /api/users/me step 4), so the lists are gone
--      even if the later Supabase Admin delete (which cascades public.users) fails.
--      SECURITY DEFINER (the 013 check_credit_decrement pattern) with a pinned search_path:
--      it deletes as the migration role, so it works whichever role stamps the tombstone (the
--      app's stemloops_app today; an operator or a future worker path that holds UPDATE on
--      users but no DELETE on set_lists tomorrow). It can only delete the lists of the row
--      being tombstoned (NEW.id). EXECUTE revoked from PUBLIC, anon, authenticated; a trigger
--      function is never callable directly anyway.
--
-- RLS: backend-only (the 028 / 041 / 042 pattern). The web connects as stemloops_app, whose
--   policy admits every row; ownership is enforced in every route from getUser()
--   (`set_lists.user_id = <session user>`, app/api/set-lists/**). anon / authenticated get
--   nothing (Supabase grants them ALL on new public tables by default, so the REVOKE is
--   load-bearing). No auth.uid() policy, so no M-3 stub is needed.
--
-- DEPLOY ORDER: Jon applies 044 -> merge -> web deploys. Web before 044 would 500 every
--   set-list route (relation does not exist); nothing else reads these tables.
--
-- APPLYING IT to staging or production needs Jon (migration on a deployed database):
--   `make migrate` with that DATABASE_URL, or paste this file into the SQL editor and then
--       INSERT INTO public._migrations(filename) VALUES ('044_v3_set_lists.sql');
--   Verify afterwards:
--       SELECT to_regclass('public.set_lists'), to_regclass('public.set_list_songs');   -- not null
--       SELECT relname, relrowsecurity FROM pg_class
--        WHERE oid IN ('public.set_lists'::regclass, 'public.set_list_songs'::regclass);  -- t, t
--       SELECT has_table_privilege('anon', 'public.set_lists', 'SELECT');              -- f
--       SELECT tgname FROM pg_trigger WHERE tgname = 'users_tombstone_delete_set_lists'; -- 1 row
--
-- Idempotent: IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE / guarded DO block.
-- Down: migrations/down/044_v3_set_lists_down.sql.
--
-- rls-backend-only: set_lists, set_list_songs

CREATE TABLE IF NOT EXISTS public.set_lists (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT set_lists_name_shape CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 60)
);

-- Case-insensitive uniqueness per user ("JAMS" and "jams" are the same list).
CREATE UNIQUE INDEX IF NOT EXISTS set_lists_user_name_key
  ON public.set_lists (user_id, lower(name));

CREATE TABLE IF NOT EXISTS public.set_list_songs (
  item_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  set_list_id uuid        NOT NULL REFERENCES public.set_lists(id) ON DELETE CASCADE,
  job_id      uuid        NULL REFERENCES public.jobs(id) ON DELETE SET NULL,
  source      text        NOT NULL,
  youtube_url text        NULL,
  video_id    text        NULL,
  title       text        NULL,
  position    integer     NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT set_list_songs_source_check CHECK (source IN ('link', 'upload', 'demo')),
  CONSTRAINT set_list_songs_link_has_url CHECK (source <> 'link' OR youtube_url IS NOT NULL),
  CONSTRAINT set_list_songs_position_nonneg CHECK (position >= 0),
  CONSTRAINT set_list_songs_title_len CHECK (title IS NULL OR char_length(title) <= 300),
  CONSTRAINT set_list_songs_position_key UNIQUE (set_list_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT set_list_songs_url_key UNIQUE (set_list_id, youtube_url),
  CONSTRAINT set_list_songs_job_key UNIQUE (set_list_id, job_id)
);

-- The FK side of ON DELETE SET NULL: the sweep deletes jobs by id and must find items fast.
CREATE INDEX IF NOT EXISTS set_list_songs_job_idx ON public.set_list_songs (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE public.set_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.set_list_songs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stemloops_app_all ON public.set_lists;
CREATE POLICY stemloops_app_all ON public.set_lists
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS stemloops_app_all ON public.set_list_songs;
CREATE POLICY stemloops_app_all ON public.set_list_songs
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.set_lists TO stemloops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.set_list_songs TO stemloops_app;
REVOKE ALL ON public.set_lists FROM anon, authenticated;
REVOKE ALL ON public.set_list_songs FROM anon, authenticated;

-- cowork_ro read path (§A3 pattern). No-op where cowork_ro does not exist.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    FOREACH t IN ARRAY ARRAY['set_lists', 'set_list_songs'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = t AND policyname = 'cowork_ro_read'
      ) THEN
        EXECUTE format('CREATE POLICY cowork_ro_read ON public.%I FOR SELECT TO cowork_ro USING (true)', t);
      END IF;
    END LOOP;
  END IF;
END $$;

COMMENT ON TABLE public.set_lists IS
  'A user''s named, ordered set list (#322). The Demo set is code-defined, never a row. See migration 044 header.';
COMMENT ON TABLE public.set_list_songs IS
  'One item of a set list: a snapshot keyed by source; job_id SET NULL when the job is swept. See migration 044 header.';

-- Backstop: a tombstoned account keeps no lists (D-b).
CREATE OR REPLACE FUNCTION public.delete_set_lists_for_tombstoned_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.set_lists WHERE user_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_set_lists_for_tombstoned_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_set_lists_for_tombstoned_user() FROM anon, authenticated;

DROP TRIGGER IF EXISTS users_tombstone_delete_set_lists ON public.users;
CREATE TRIGGER users_tombstone_delete_set_lists
  AFTER UPDATE OF deleted_at ON public.users
  FOR EACH ROW
  WHEN (NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.delete_set_lists_for_tombstoned_user();
