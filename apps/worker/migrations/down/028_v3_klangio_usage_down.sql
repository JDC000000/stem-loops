-- 028_v3_klangio_usage_down.sql — drop the klangio_usage counter. Run by hand only.
-- WARNING: dropping the table discards the durable Klangio spend counter, and there is
-- NO safe fallback counter to switch to. Do NOT set KLANGIO_QUOTA_BACKEND=file and do NOT
-- unset DATABASE_URL (this file used to say to do exactly that): apps/worker/fly.toml no
-- longer mounts a volume, so the file counter would write to an ephemeral /data and
-- restart at zero on every deploy while logging as healthy — an uncapped spend that looks
-- green. Instead: set CHORDS_PROVIDER='' (the EMPTY STRING — any other value raises) to
-- stop Klangio submits outright, reconcile against the Klangio dashboard, and only then
-- drop the table.

DROP TABLE IF EXISTS public.klangio_usage;
