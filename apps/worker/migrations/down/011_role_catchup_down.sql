-- Down for 011_role_catchup.sql. Reverses only what 011 added. Leaves 009's
-- RLS + service_role grants in place (restores the pre-011 state, not the
-- pre-009 state).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs','job_events','loops','upload_rate_events',
    'kill_switches','blocklist','fetch_attempts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS stemloops_app_all ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS cowork_ro_read ON public.%I', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM stemloops_app', t);
    -- Restore 009's state.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t || '_service_role_all', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

REVOKE USAGE ON SCHEMA public FROM stemloops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM stemloops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM stemloops_app;
-- Do NOT drop stemloops_app role — may be in use elsewhere.

DELETE FROM _migrations WHERE filename = '011_role_catchup.sql';
