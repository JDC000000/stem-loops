-- 012_v3_supabase_stubs_down.sql — reverse of the auth.users stub.
--
-- Safety guard: only drop auth.users if it was created by this migration
-- (i.e., it is a stub, not the Supabase-managed table). Supabase's real
-- auth.users has an `instance_id` column that our stub does not; use that
-- as the discriminator so this is safe to run against a staging or prod
-- database by mistake.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name = 'instance_id'
  ) THEN
    DROP TABLE auth.users CASCADE;
  END IF;
END $$;

-- The auth schema is left in place. Other components may depend on it,
-- and a bare empty schema is harmless.
