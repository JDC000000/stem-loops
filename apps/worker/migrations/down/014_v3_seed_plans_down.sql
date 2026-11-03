-- 014_v3_seed_plans_down.sql — remove the seed rows.
-- Order: subscriptions.plan_code FKs into plans.code, so delete subscriptions first.
-- RESTRICT would block this; we rely on the ON DELETE default (NO ACTION) and
-- cleanup order. In a partial rollback (only the seed, not the schema), there
-- may be live subscriptions — the DELETE will fail safely, which is intended.

DELETE FROM public.plans WHERE code IN ('free','pro','studio');
