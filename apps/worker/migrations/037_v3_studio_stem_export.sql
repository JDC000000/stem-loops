-- 037_v3_studio_stem_export.sql — entitle the Studio plan to stem export, in
-- the same change that ships the route which delivers it.
--
-- Follows 034_v3_pricing_model_truth.sql, which cleared export_stems on every
-- plan because no stem-export route existed. 034 is NOT edited (append-only,
-- per §11 Merge Safety Rule (b)); this migration, applying after it, is the new
-- source of truth for the one flag it changes.
--
-- ---------------------------------------------------------------------------
-- Jon's decision (2026-11-12): Studio ($12) gets stem export; Free and Pro do
-- not. The $12 tier is differentiated by stem export plus a larger quota; the
-- $4.99 tier by quota alone.
--
--   code    | export_stems | export_wav24
--   --------+--------------+-------------
--   free    |    false     |    false      (unchanged from 034)
--   pro     |    false     |    false      (unchanged from 034)
--   studio  |    TRUE      |    false      (export_stems: false -> true)
--
-- Why it lands here and not in 034: the flag is an advertisement of a
-- capability, so it may only be true where the capability exists. The
-- capability is GET /api/jobs/[id]/download
-- (apps/web/src/app/api/jobs/[id]/download/route.ts), which signs the
-- full-length stem WAV (`<job>/_stems/dl/<stem>.wav`) only after
-- enforceEntitlement('export_stems', ...) allows it. That route ships in the
-- same PR as this migration (#230), so the flag and the gate that honours it
-- cannot be deployed apart. The route gates on export_stems ALONE; it does
-- not also require export_wav24, which stays false everywhere.
--
-- export_wav24 is NOT touched: 034's reasoning stands. Loops are 24-bit WAV
-- for every tier including free, so the flag can only ever overstate what a
-- paid plan adds.
--
-- ---------------------------------------------------------------------------
-- Conventions:
--   Idempotent — a single-column UPDATE keyed on the primary key (code) to a
--   constant. Re-running sets the same value, so the CI "Migrations" job's
--   second pass is a no-op.
--
--   An UPDATE, not 034's full UPSERT: this migration changes one flag on one
--   existing row and has no business restating prices or quotas. Rewriting
--   every column here would make 037 a second, competing copy of the
--   catalog. 014 inserts the studio row and 034 upserts it, so it exists
--   whenever this runs.
--
--   No RLS or GRANT statements. This migration adds no object; public.plans'
--   RLS and policies are 013's, and 017's append-only REVOKE list does not
--   include plans. Per 017/032 there is no new privilege surface.
--
--   Runs as the migration role (NOSUPERUSER, database owner, BYPASSRLS) that
--   the CI "Migrations on a Supabase-like Postgres" job pins, so the RLS on
--   public.plans does not obstruct this DML.
--
-- Down: migrations/down/037_v3_studio_stem_export_down.sql restores 034's
-- state (export_stems false on studio, and 034's column comment).

UPDATE public.plans
   SET export_stems = true
 WHERE code = 'studio';

COMMENT ON COLUMN public.plans.export_stems IS
  'Entitles a full-length stem WAV download via GET /api/jobs/[id]/download, '
  'which enforces it (enforceEntitlement(''export_stems'')). TRUE on studio '
  'only, FALSE on free and pro, as of migration 037.';
