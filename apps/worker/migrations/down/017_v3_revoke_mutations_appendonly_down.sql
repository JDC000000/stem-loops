-- Down migration 017 — restore UPDATE/DELETE on the append-only tables.
--
-- This is the reverse of 017_v3_revoke_mutations_appendonly.sql. It puts the
-- role back where it was between 011 (default privileges granted UPDATE/DELETE)
-- and 017 (explicit REVOKE). Run by hand against a throwaway DB only — the
-- migration runner never applies down files.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'usage_events',
    'credit_purchases',
    'credit_consumption',
    'promo_redemptions'
  ] LOOP
    EXECUTE format(
      'GRANT UPDATE, DELETE ON public.%I TO stemloops_app',
      t);
  END LOOP;
END $$;
