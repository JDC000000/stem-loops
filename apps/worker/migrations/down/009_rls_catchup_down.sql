-- Down for 009_rls_catchup.sql. Reverses only the posture changes 009 made.
-- Does NOT drop the service_role role (it may be in use by Supabase or 010+).

DO $$
DECLARE
  t text;
  pname text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs',
    'job_events',
    'loops',
    'upload_rate_events',
    'kill_switches',
    'blocklist',
    'fetch_attempts'
  ] LOOP
    pname := t || '_service_role_all';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pname, t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM service_role', t);
    EXECUTE format('GRANT ALL ON %I TO PUBLIC', t);
  END LOOP;
END$$;

DELETE FROM _migrations WHERE filename = '009_rls_catchup.sql';
