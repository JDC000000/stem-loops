-- 037_v3_studio_stem_export_down.sql — restore the state 034 left.
--
-- 037 is pure DML on one existing row plus one column COMMENT, so the reverse
-- is the same UPDATE carrying 034's value (studio export_stems false; free and
-- pro were never changed by 037 and are not touched here) and 034's exact
-- comment text.
--
-- Deliberately an UPDATE, not a DELETE: 037 only CHANGED a value. Deleting the
-- row would take entitlements and subscriptions' FKs on plans(code) with it.
--
-- Note: with this applied, GET /api/jobs/[id]/download answers 402 for every
-- plan, including Studio. That is the correct pre-037 behaviour, not a bug.
--
-- Not applied by the runner — `make migrate` globs only migrations/*.sql.
-- Run by hand against a throwaway DB.

UPDATE public.plans
   SET export_stems = false
 WHERE code = 'studio';

COMMENT ON COLUMN public.plans.export_stems IS
  'Entitles a full-stems export. FALSE on every plan as of migration 034: no '
  'stem-export route exists (the /stems route serves Opus playback only).';
