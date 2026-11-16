-- 039_v3_paid_plans_youtube_links.sql — Pro and Studio may paste YouTube links.
--
-- Jon, 2026-11-16: drop the TSD-V3-DELTA §1.2a "processor separation" rule
-- (paid tiers upload-only) for everyone. Pro and Studio may paste YouTube
-- links; those songs are kept in the account's library under the paid
-- retention rule (#279, lib/retention.ts + worker cleanup.py, which key on the
-- subscription, not on jobs.input_kind), and each link job counts against the
-- plan's monthly quota (Pro 50 / Studio 150) exactly like an upload. Free keeps
-- YouTube links (5/month, 24 h). Reason recorded in TSD-V3-DELTA v1.10: paid
-- plans build a LIBRARY of songs, and most of the songs people want to play
-- along to arrive as links, not files.
--
-- This row change IS the switch. enforceEntitlement('start_job_youtube') in
-- apps/web/src/lib/billing/entitlements.ts no longer refuses pro/studio by
-- plan code; it allows a paid link job only when plans.services lists
-- 'youtube'. So:
--   * deployed code + this migration NOT applied -> paid link jobs are refused
--     with "YouTube links aren't switched on for your plan yet" (402), and
--     /pricing (which renders this column) does not advertise them. Safe.
--   * this migration applied -> paid link jobs allowed, /pricing says
--     "Link import: YouTube" on Pro and Studio, both read off this column.
--
-- What does NOT change: the credit_consumption trigger (013,
-- check_credit_decrement) still accepts upload jobs only. Credits are not spent
-- on link jobs; a free account holding credits pastes links on the free
-- allowance (5/month), capped in POST /api/jobs.
--
-- Conventions: pure DML on two existing rows, idempotent (re-running sets the
-- same value). No DDL, no GRANT/RLS: 013 created public.plans with its RLS and
-- policies; this adds no object. Runs as the migration role (owner,
-- BYPASSRLS) like 034/037.
--
-- Down: migrations/down/039_v3_paid_plans_youtube_links_down.sql.

UPDATE public.plans
   SET services = ARRAY['youtube']::text[]
 WHERE code IN ('pro', 'studio');
