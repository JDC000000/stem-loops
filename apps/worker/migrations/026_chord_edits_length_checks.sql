-- 026_chord_edits_length_checks.sql — defence-in-depth CHECK constraints
-- on public.chord_edits. See session-6 security audit v2 finding F3.
--
-- Why this exists:
--   The POST /api/chord-edits route validates shape + length client-side
--   (see apps/web/src/app/api/chord-edits/route.ts), but if a caller ever
--   reaches the table through a different path — PostgREST with a user
--   JWT, a worker-side batch, the stemloops_app role from a compromised
--   service — the DB-level CHECKs here still reject garbage.
--
--   The caps mirror the route constants exactly:
--     SHA256 hex fields  : length = 64
--     provider_version   : length <= 64
--     cqt_plan_version   : NULL or length <= 64
--     labels             : length <= 16
--     start_sec, end_sec : 0 <= x <= 86400 (24 h)
--     original_confidence: NULL or 0..1
--
--   start_sec/end_sec also prevent 1e12 overflowing numeric(10, 3), which
--   previously surfaced as a 500 and could DoS Sentry via noise.
--
-- Immutable migration 025 is NOT touched (M-4: migrations are immutable
-- once shipped). This migration only ADDs constraints; nothing in it
-- conflicts with the 025 CHECKs (valid_time_range, labels_differ,
-- valid_harte) — the new rules are stricter supersets.
--
-- Down: migrations/down/026_chord_edits_length_checks.sql.

ALTER TABLE public.chord_edits
  ADD CONSTRAINT chord_edits_track_hash_len
    CHECK (length(track_hash) = 64),
  ADD CONSTRAINT chord_edits_alphabet_sha_len
    CHECK (length(alphabet_sha) = 64),
  ADD CONSTRAINT chord_edits_provider_version_len
    CHECK (length(provider_version) <= 64),
  ADD CONSTRAINT chord_edits_cqt_plan_version_len
    CHECK (cqt_plan_version IS NULL OR length(cqt_plan_version) <= 64),
  ADD CONSTRAINT chord_edits_original_label_len
    CHECK (length(original_label) <= 16),
  ADD CONSTRAINT chord_edits_corrected_label_len
    CHECK (length(corrected_label) <= 16),
  ADD CONSTRAINT chord_edits_start_sec_range
    CHECK (start_sec >= 0 AND start_sec <= 86400),
  ADD CONSTRAINT chord_edits_end_sec_range
    CHECK (end_sec >= 0 AND end_sec <= 86400),
  ADD CONSTRAINT chord_edits_original_confidence_range
    CHECK (original_confidence IS NULL
      OR (original_confidence >= 0 AND original_confidence <= 1));

COMMENT ON CONSTRAINT chord_edits_track_hash_len ON public.chord_edits IS
  'F3: track_hash is sha256 hex, always 64 chars';
COMMENT ON CONSTRAINT chord_edits_alphabet_sha_len ON public.chord_edits IS
  'F3: alphabet_sha is sha256 hex, always 64 chars';
COMMENT ON CONSTRAINT chord_edits_start_sec_range ON public.chord_edits IS
  'F3: 0..86400 so numeric(10,3) cannot overflow (1e12 → 500 → DoS)';
