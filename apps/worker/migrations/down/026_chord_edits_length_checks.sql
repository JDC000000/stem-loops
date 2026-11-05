-- Down for 026_chord_edits_length_checks.sql — drop the defence-in-depth
-- CHECK constraints on public.chord_edits. Does NOT touch 025's CHECKs.

ALTER TABLE public.chord_edits
  DROP CONSTRAINT IF EXISTS chord_edits_track_hash_len,
  DROP CONSTRAINT IF EXISTS chord_edits_alphabet_sha_len,
  DROP CONSTRAINT IF EXISTS chord_edits_provider_version_len,
  DROP CONSTRAINT IF EXISTS chord_edits_cqt_plan_version_len,
  DROP CONSTRAINT IF EXISTS chord_edits_original_label_len,
  DROP CONSTRAINT IF EXISTS chord_edits_corrected_label_len,
  DROP CONSTRAINT IF EXISTS chord_edits_start_sec_range,
  DROP CONSTRAINT IF EXISTS chord_edits_end_sec_range,
  DROP CONSTRAINT IF EXISTS chord_edits_original_confidence_range;
