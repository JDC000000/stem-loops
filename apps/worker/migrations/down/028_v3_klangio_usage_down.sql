-- 028_v3_klangio_usage_down.sql — drop the klangio_usage counter. Run by hand only.
-- WARNING: dropping the table discards the durable Klangio spend counter. Before
-- rolling back, set KLANGIO_QUOTA_BACKEND=file (or unset DATABASE_URL) and check
-- the Klangio dashboard count, or the monthly cap guards against nothing.

DROP TABLE IF EXISTS public.klangio_usage;
