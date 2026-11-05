-- 027_v3_chord_edits_revoke_anon.sql — revoke public access to chord_edits
-- for the anon and authenticated roles, and drop the direct-insert/select
-- policies added in 025.
--
-- Why this exists (security audit §3 M1):
--   025 added FOR INSERT/SELECT ... TO authenticated policies for chord_edits
--   but did NOT include a matching GRANT. On a vanilla Supabase project, the
--   anon / authenticated roles receive table-level privileges either from the
--   project's default-privileges configuration or from a prior ALTER DEFAULT
--   PRIVILEGES statement in-schema. If any such grant applies to new public
--   tables, a client holding the publishable anon key can POST directly to
--   PostgREST's `/rest/v1/chord_edits` and the RLS policy will admit the
--   insert — completely bypassing the /api/chord-edits route's rate limit,
--   input validation (Harte CHECK is in DB but the surrounding shape/auth
--   checks are not), and the server-side auditing.
--
--   The intended writer/reader for chord_edits is stemloops_app only (worker
--   role, via the /api/chord-edits route). The 025 authenticated policies
--   were a leftover that gives anon the admission the API refuses.
--
-- Fix: REVOKE ALL on public.chord_edits from anon + authenticated, and DROP
-- the two authenticated policies. stemloops_app's policies (added in 025) and
-- the cowork_ro_read policy (if present) survive — they are the only intended
-- read/write paths.
--
-- Idempotent: REVOKE on a privilege that is already absent is a no-op;
-- DROP POLICY IF EXISTS is a no-op when the policy is already gone.
--
-- Depends on 025 (creates the table + authenticated policies). Numbered 027
-- so the F2/F3 bundle (which claims 026) and this security bundle can both
-- land without a filename conflict in git.
--
-- Down: migrations/down/027_v3_chord_edits_revoke_anon_down.sql.

REVOKE ALL ON public.chord_edits FROM anon, authenticated;

DROP POLICY IF EXISTS chord_edits_user_insert   ON public.chord_edits;
DROP POLICY IF EXISTS chord_edits_user_read_own ON public.chord_edits;
