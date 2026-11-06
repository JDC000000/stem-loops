-- Down for 029_v3_chord_edits_harte_slash.sql — restore 025's original
-- (looser-quality, no-slash) chord_edits_valid_harte. Run by hand only.
-- Added NOT VALID so rows written under 029 (slash chords) do not block the
-- rollback; new writes are checked against the old pattern again.

ALTER TABLE public.chord_edits DROP CONSTRAINT IF EXISTS chord_edits_valid_harte;

ALTER TABLE public.chord_edits
  ADD CONSTRAINT chord_edits_valid_harte CHECK (
    corrected_label ~ '^(N|X|[A-G](#|b)?(:[a-z0-9]+)?)$'
  ) NOT VALID;
