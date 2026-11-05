-- 025_v3_chord_edits.sql — append-only ledger for user-submitted chord
-- corrections. TSD §1.6a data-capture contract; decision record v1.3
-- (Phase 2 Y1 chord-model decision). Flywheel seed for PR-Y1.7.
--
-- Why this exists:
--   Every user edit to a model/provider chord label is a training signal.
--   Weekly fine-tune queries this table filtered by (alphabet_sha,
--   provider_version) to keep the decoder matched to the live front-end.
--   Independent of Klangio / model — edits accrue regardless of which
--   provider labeled the frame.
--
-- Shape mirrors credit_adjustments / credit_purchases (013, 023):
--   * RLS on; authenticated self-read + self-insert; stemloops_app
--     INSERT + SELECT only (017 append-only pattern — UPDATE/DELETE are
--     REVOKEd to defeat the 011 default-privileges grant).
--   * cowork_ro_read via the §A3 DO-block (no-op on CI where the role is
--     absent) — this is the read path the weekly fine-tune uses.
--   * Account-delete sweep (Phase 4) removes rows explicitly; no CASCADE
--     from public.users, so a user cannot be removed until their edits
--     have been swept. That is the point — training data is an artifact of
--     a signed-in session and the sweep is the audit trail for its removal.
--
-- Invariants (CHECK constraints):
--   * end_sec > start_sec                — no zero-width or reversed frames
--   * original_label <> corrected_label — a row IS a correction, not a
--                                         no-op (dedupes trivially in the
--                                         app; a stricter guarantee in DB)
--   * corrected_label matches Harte      — N | X | pitch(#|b)?(:quality)?
--
-- Harte alphabet reference: Harte 2010 (QM-DMI chord notation); the §1.6a
-- data-capture contract pins the 60-label alphabet to alphabet_sha so a
-- later expansion doesn't silently mix training samples.
--
-- Down: migrations/down/025_v3_chord_edits_down.sql.

CREATE TABLE IF NOT EXISTS public.chord_edits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.users(id),
  job_id               uuid NOT NULL REFERENCES public.jobs(id),
  track_hash           text NOT NULL,              -- sha256 of audio at edit time
  provider             text NOT NULL,              -- 'klangio' | 'internal' | 'autochord'
  provider_version     text NOT NULL,
  start_sec            numeric(10, 3) NOT NULL,
  end_sec              numeric(10, 3) NOT NULL,
  original_label       text NOT NULL,              -- what the model returned
  corrected_label      text NOT NULL,              -- what the user set it to
  original_confidence  real,                       -- 0..1 if provider reported one
  cqt_plan_version     text,                       -- which CQT front-end was live
  alphabet_sha         text NOT NULL,              -- current 60-label alphabet sha
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chord_edits_valid_time_range CHECK (end_sec > start_sec),
  CONSTRAINT chord_edits_labels_differ    CHECK (original_label <> corrected_label),
  CONSTRAINT chord_edits_valid_harte      CHECK (
    corrected_label ~ '^(N|X|[A-G](#|b)?(:[a-z0-9]+)?)$'
  )
);

-- Training-data read path: filter by alphabet_sha + provider_version, newest
-- first (weekly window). Matches the example query in the ops runbook.
CREATE INDEX IF NOT EXISTS chord_edits_training_idx
  ON public.chord_edits (alphabet_sha, provider_version, created_at DESC);

-- Per-user read path (self-read policy + account-delete sweep both key on
-- user_id). Keeps the sweep linear instead of a seq scan.
CREATE INDEX IF NOT EXISTS chord_edits_user_idx
  ON public.chord_edits (user_id, created_at);

ALTER TABLE public.chord_edits ENABLE ROW LEVEL SECURITY;

-- Authenticated users insert and read their own edits. The WITH CHECK on
-- insert ties user_id to auth.uid() so a client cannot post edits as a
-- different user even with a forged payload.
DROP POLICY IF EXISTS chord_edits_user_insert ON public.chord_edits;
CREATE POLICY chord_edits_user_insert ON public.chord_edits
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS chord_edits_user_read_own ON public.chord_edits;
CREATE POLICY chord_edits_user_read_own ON public.chord_edits
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- stemloops_app (worker role) — append-only. Split into INSERT + SELECT so
-- check_rls.py's rule (c) append-only variant accepts it; UPDATE/DELETE are
-- REVOKEd below to defeat the 011 default-privileges grant (see 017).
DROP POLICY IF EXISTS stemloops_app_all    ON public.chord_edits;
DROP POLICY IF EXISTS stemloops_app_insert ON public.chord_edits;
DROP POLICY IF EXISTS stemloops_app_select ON public.chord_edits;
CREATE POLICY stemloops_app_insert ON public.chord_edits
  FOR INSERT TO stemloops_app WITH CHECK (true);
CREATE POLICY stemloops_app_select ON public.chord_edits
  FOR SELECT TO stemloops_app USING (true);
GRANT SELECT, INSERT ON public.chord_edits TO stemloops_app;
REVOKE UPDATE, DELETE ON public.chord_edits FROM stemloops_app;

-- cowork_ro read path (§A3 pattern). No-op on CI / fresh DBs where
-- cowork_ro does not exist; idempotent on repeat application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'chord_edits' AND policyname = 'cowork_ro_read'
    ) THEN
      CREATE POLICY cowork_ro_read ON public.chord_edits
        FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.chord_edits IS
  'TSD §1.6a: user corrections to chord labels, append-only, feeds weekly fine-tune';
