-- 027_v3_chord_edits_revoke_anon_down.sql — restore the 025 state.
--
-- Recreates the two authenticated policies that 027 dropped. Does NOT re-grant
-- anything to anon/authenticated; the audit finding is that 025 never granted
-- in the first place, and granting now would re-open the PostgREST bypass that
-- 027 closes. Run by hand against a throwaway DB only — the migration runner
-- never applies down files.

CREATE POLICY chord_edits_user_insert ON public.chord_edits
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY chord_edits_user_read_own ON public.chord_edits
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
