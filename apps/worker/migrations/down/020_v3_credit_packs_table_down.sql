-- 020_v3_credit_packs_table_down.sql — reverse of 020.
-- Drops the credit_packs catalog table. No dependencies to unwind — nothing
-- references credit_packs by FK; the pricing page's FALLBACK constant keeps
-- the UI rendering during rollback.

DROP TABLE IF EXISTS public.credit_packs;
