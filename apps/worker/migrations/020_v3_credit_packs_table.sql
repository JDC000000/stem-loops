-- 020_v3_credit_packs_table.sql — DB-driven credit-pack catalog.
--
-- Audit MINOR (session-4 holistic audit): /pricing hardcoded the three
-- one-time credit SKUs in TSX (CREDIT_PACKS array in apps/web/src/app/
-- pricing/page.tsx). That meant any price change required a code deploy
-- and lived outside the single source of truth (`public.plans` for
-- subscriptions already follows the DB-driven pattern per TSD §1.2).
-- Move credit packs to the same pattern: a small public-read catalog
-- the pricing page SELECTs at request time, with a FALLBACK constant
-- in TSX as the degraded-mode safety net (identical to loadPlans()).
--
-- Mirrors the `plans` template from 013 (RLS + public-read for anon +
-- authenticated active rows + stemloops_app_all FOR ALL for the worker
-- write path + cowork_ro_read via the A3 catch-all loop already in 011).
-- Append-only per §11 Merge Safety Rule (b).
--
-- Down migration: 020_v3_credit_packs_table_down.sql (drops the table).

-- rls-backend-only: credit_packs
-- credit_packs is a PUBLIC catalog table like `plans`: public-read policy
-- for anon+authenticated, plus the stemloops_app_all write policy for the
-- worker (seed + price updates). Not per-user data, so the CI gate
-- auth.uid() requirement does not apply — same shape as `plans` in 013.
-- No apostrophes in this comment block on purpose: the gate string-literal
-- masker currently mistakes apostrophes in line comments for string
-- delimiters (same note as 013).

CREATE TABLE IF NOT EXISTS public.credit_packs (
  pack_code       text PRIMARY KEY
                    CHECK (pack_code IN ('credits_20','credits_60','credits_180')),
  credits         integer NOT NULL
                    CHECK (credits IN (20,60,180)),
  -- CAD cents per TSD §1.2 — the Stripe sandbox is a BC CAD catalog, so
  -- a USD-named column would misrepresent what customers are billed
  -- (same precedent as plans.price_cad_cents and
  -- credit_purchases.amount_cad_cents).
  price_cad_cents integer NOT NULL CHECK (price_cad_cents > 0),
  display_name    text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_packs ENABLE ROW LEVEL SECURITY;

-- Public catalog: anyone can read active rows (same shape as plans_public_read).
DROP POLICY IF EXISTS credit_packs_public_read ON public.credit_packs;
CREATE POLICY credit_packs_public_read ON public.credit_packs
  FOR SELECT TO anon, authenticated USING (active);

-- Worker write path per §A2 — seed + future price updates run as stemloops_app.
DROP POLICY IF EXISTS stemloops_app_all ON public.credit_packs;
CREATE POLICY stemloops_app_all ON public.credit_packs
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_packs TO stemloops_app;

-- cowork_ro_read (rule d) — applied via the same conditional FOREACH shape as
-- the 013 A3 block (no-op on CI / fresh DBs where cowork_ro is absent). The
-- check_rls.py gate recognises this form (FOREACH ARRAY + CREATE POLICY
-- cowork_ro_read inside a DO block).
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    FOREACH t IN ARRAY ARRAY['credit_packs'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename=t AND policyname='cowork_ro_read'
      ) THEN
        EXECUTE format('CREATE POLICY cowork_ro_read ON public.%I FOR SELECT TO cowork_ro USING (true)', t);
      END IF;
      EXECUTE format('GRANT SELECT ON public.%I TO cowork_ro', t);
    END LOOP;
  END IF;
END $$;

-- Seed the three TSD §1.2 LOCKED packs. ON CONFLICT re-sync keeps a prior
-- in-code source of truth from diverging if an earlier manual INSERT exists.
INSERT INTO public.credit_packs (pack_code, credits, price_cad_cents, display_name)
VALUES
  ('credits_20',  20,  500,  '20 credits'),
  ('credits_60',  60,  1200, '60 credits'),
  ('credits_180', 180, 3000, '180 credits')
ON CONFLICT (pack_code) DO UPDATE SET
  credits         = EXCLUDED.credits,
  price_cad_cents = EXCLUDED.price_cad_cents,
  display_name    = EXCLUDED.display_name;

COMMENT ON TABLE public.credit_packs IS
  'One-time credit SKUs. Public-read catalog; worker role writes. Prices CAD cents.';
