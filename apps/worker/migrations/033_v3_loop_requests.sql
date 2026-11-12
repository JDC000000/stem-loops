-- 033_v3_loop_requests.sql — server-side ON-DEMAND loop cutting.
--
-- Jon's decision (2026-11-11): "only do the processing work to create loops when
-- the user asks for the loops to be created." PR #208 took the browser route
-- because it needed no migration; this is the pipeline-grade route, and it is
-- held open for Jon's own review because it carries this file.
--
-- WHAT THE EAGER CUT COSTS TODAY, MEASURED (not arithmetic from constants).
--   One 3-minute track at 120 BPM, 4-bar loops, six stems, is 10 starts x 6
--   stems = 60 loops. Per loop, measured on this box with the repo's own
--   encoder/dsp code:
--       seamless join + PCM_24 write + 800-point peaks = 27.9 ms CPU
--       WAV on disk                                    = 2,116,844 B
--       json.dumps(waveform_peaks)                     = 16,667 B
--   So per job: 121.1 MiB of R2 writes, 60 Class A PUTs, 0.95 MiB of jsonb and
--   ~1.7 s of serial CPU -- produced whether or not anyone opens the loops.
--   The R2 writes and the jsonb dominate; the CPU does not.
--
-- THE SPLIT, AND WHY IT IS DRAWN HERE
-- -----------------------------------
--   `apps/web/src/lib/play/sections.ts` derives the play-along player's
--   section-loop regions from the `loops` rows. Its own row view
--   (`SectionLoopRow`) reads exactly three columns:
--       section_label, start_sec, end_sec
--   It never reads r2_key, filename, duration_ms, waveform_peaks or signed_url.
--   So the player needs the loop ROWS; only a downloader needs the encoded WAVs.
--
--   Therefore the eager pipeline keeps running `extract_and_tag` (beat grid,
--   BPM, key, loop windows, section labels, energy) and keeps INSERTing one
--   `loops` row per loop. What it stops doing is the seamless join, the 24-bit
--   encode, the 800-point peaks and the R2 PUT. That is the whole measured cost
--   above, and the player's data path is untouched -- not re-pointed, not
--   re-shaped: the same table, the same columns, the same query.
--
-- WHY `cut_at` RATHER THAN A NULLABLE `r2_key`
-- -------------------------------------------
--   The obvious move is to let `loops.r2_key` be NULL for an uncut row. That
--   weakens `r2_key NOT NULL` AND it breaks `UNIQUE (job_id, r2_key)` as an
--   upsert target (NULLs are distinct), which is exactly what the cutter needs
--   in order to land on the row the eager pass already described.
--
--   Instead `r2_key` stays NOT NULL and is computed EAGERLY: the key has always
--   been a pure function of (job_id, stem, bars, section, idx), so a row can
--   name where its object WILL live before any byte is written. `cut_at` is then
--   the one honest signal: NULL means "described, not cut". The API mints a
--   signed URL only for a row with `cut_at IS NOT NULL`, because a signed URL to
--   an object that does not exist is a 404 the client cannot tell from an
--   expired job.
--
-- WHY A REQUEST TABLE AND NOT A COLUMN ON `jobs`
-- ---------------------------------------------
--   Three existing CHECK constraints rule out the cheaper shapes, each verified
--   against the file named:
--     1. `jobs.status` is CHECK (status IN ('queued','downloading','separating',
--        'extracting','uploading','done','failed')) -- 001_jobs.sql. A job that
--        is `done` and is now cutting loops has no legal value, and widening
--        that enum would put a second meaning on the column `consumer.py`
--        claims work from (`WHERE status='queued'`): a loop request would be
--        claimed as a fresh separation.
--     2. `job_events.stage` is CHECK (stage IN ('downloading','separating',
--        'extracting','uploading')) with phase IN ('started','completed',
--        'failed') -- 002_job_events.sql. No pair means "a user asked for loops".
--     3. There is no external broker to put the request on. consumer.py's own
--        header: "There is no external queue broker ... No Redis, no sidecar."
--   A table also gives the request a status, an error channel and a single row
--   for `GET /api/jobs/:id/loops` to poll -- none of which fits on a flag.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
--   No `bar_counts` and no `stems` column. A request cuts exactly the loops the
--   eager pass already described: the job's own `loop_length_bars`, the job's
--   own `requested_stems`. Cutting a SECOND bar length would INSERT additional
--   rows into `loops` -- and `deriveSections` collapses overlapping rows by row
--   count, so a bank of 1-bar rows could change which label wins and move the
--   player's section boundaries. That is the one thing this change must not do.
--   Selectable bar banks are a follow-up that needs the player reading only its
--   own bar length first. A column no code honours is worse than no column.
--
-- Shape follows 013 / 023 / 025: RLS on, a stemloops_app_all policy for the
-- worker role, an authenticated self-read policy keyed on auth.uid(), and the
-- §A3 cowork_ro_read block that no-ops where the role is absent.
--
-- Down: migrations/down/033_v3_loop_requests_down.sql.

-- 1. `loops` can now describe a loop that has not been cut yet.
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS cut_at timestamptz;

COMMENT ON COLUMN public.loops.cut_at IS
  'When the WAV at r2_key was encoded and uploaded. NULL = described by the eager pass but not cut; the API mints no signed URL for such a row.';

-- EVERY ROW THAT ALREADY EXISTS IS CUT. Backfill it, or the new column lies
-- about the entire pre-033 table.
--
--   The eager pipeline uploaded a loop's WAV BEFORE it INSERTed the row, so an
--   existing `loops` row is proof its object is in R2. A bare ADD COLUMN leaves
--   every one of them NULL, which this file defines as "described, not cut", and
--   two things act on that the moment the migration lands:
--     * `apps/web/src/app/api/jobs/[id]/route.ts` returns `signed_url: null` for
--       an uncut row, so every download link for every job still inside its 24h
--       window dies at cutover;
--     * `down/033`'s first statement is `DELETE FROM public.loops WHERE cut_at
--       IS NULL`, so a rollback would delete the whole table -- and with it the
--       play-along player's section regions, which `lib/play/sections.ts`
--       derives from exactly these rows.
--
--   `created_at` is the honest value: `loops.created_at` is timestamptz NOT NULL
--   DEFAULT now() (003_loops.sql, unaltered since), so no row escapes the
--   predicate and nothing needs coalescing. It is the INSERT's own timestamp,
--   which the eager pass took moments after the upload it followed.
--
--   PLACEMENT. After the ADD COLUMN, because the column has to exist; and
--   before `loops_uncut_idx`, because that index is partial ON `cut_at IS NULL`
--   -- built first it would index every existing row and then have every entry
--   deleted again by this UPDATE, where built second it is created directly over
--   the true pending set (empty, on a table the eager pass filled). Nothing
--   below this point touches `loops` at all; §2 onward is the new
--   `loop_requests` table, so this is the only window where order matters.
--
--   Gated by tests/test_033_cut_at_backfill.py, which applies ...→032, seeds a
--   row the way the pre-033 pipeline wrote it, applies this file, and asserts
--   both that the row is cut and that it survives `down/033`.
UPDATE public.loops SET cut_at = created_at WHERE cut_at IS NULL;

-- The cutter claims work with "the uncut rows of this job". Partial, so it
-- indexes only the pending tail and costs nothing once a job is fully cut.
CREATE INDEX IF NOT EXISTS loops_uncut_idx
  ON public.loops (job_id) WHERE cut_at IS NULL;

-- 2. The request queue.
CREATE TABLE IF NOT EXISTS public.loop_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- Nullable, like jobs.user_id (added in 013_v3_commercial.sql, NOT in 012 --
  -- 012 only creates the auth.users / public.users stubs). An anonymous job can
  -- still ask for its own loops; the route's ownership check mirrors whatever
  -- jobs.user_id holds.
  requested_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed')),
  loops_cut    integer NOT NULL DEFAULT 0 CHECK (loops_cut >= 0),
  error_code   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz
);

-- ONE live request per job. A partial unique index is the whole concurrency
-- story on the write side: two simultaneous POSTs for one job cannot both
-- create a queued row, so the second gets a 23505 the route turns into "a cut
-- is already running" rather than a duplicate claim. Terminal rows ('done',
-- 'failed') are outside the index, so a job can be re-requested after a failure
-- and keeps its history.
CREATE UNIQUE INDEX IF NOT EXISTS loop_requests_live_idx
  ON public.loop_requests (job_id) WHERE status IN ('queued','running');

-- The claim path: oldest queued first, exactly like consumer.claim_and_run's
-- ORDER BY created_at over jobs.
CREATE INDEX IF NOT EXISTS loop_requests_claim_idx
  ON public.loop_requests (status, created_at);

ALTER TABLE public.loop_requests ENABLE ROW LEVEL SECURITY;

-- The worker role: full CRUD. It claims, updates and closes requests.
DROP POLICY IF EXISTS stemloops_app_all ON public.loop_requests;
CREATE POLICY stemloops_app_all ON public.loop_requests
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loop_requests TO stemloops_app;

-- A signed-in user reads their own requests. Keyed on auth.uid() so
-- check_rls.py rule 3 is satisfied without a backend-only marker: this table
-- carries a user_id-shaped column, so it is user data, not a V2-era table.
DROP POLICY IF EXISTS loop_requests_user_read_own ON public.loop_requests;
CREATE POLICY loop_requests_user_read_own ON public.loop_requests
  FOR SELECT TO authenticated
  USING (auth.uid() = requested_by);

-- cowork_ro read path (§A3 pattern). No-op on CI / fresh DBs where cowork_ro
-- does not exist; idempotent on repeat application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'loop_requests' AND policyname = 'cowork_ro_read'
    ) THEN
      CREATE POLICY cowork_ro_read ON public.loop_requests
        FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.loop_requests IS
  'One row per user request to cut a job''s loops. Claimed by worker.loop_cutter with FOR UPDATE SKIP LOCKED; at most one live row per job via loop_requests_live_idx.';
