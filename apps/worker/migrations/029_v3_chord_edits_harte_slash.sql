-- 029_v3_chord_edits_harte_slash.sql — align chord_edits_valid_harte with the
-- factored alphabet (13 roots x 25 qualities x 13 bass).
--
-- Why this exists:
--   025's CHECK was '^(N|X|[A-G](#|b)?(:[a-z0-9]+)?)$'. It drifted from the
--   source of truth (apps/training/model/alphabet.py, mirrored by
--   worker/chord_source.py HARTE_RE) in BOTH directions:
--     * too strict on bass : no slash chords, so G:7/5 / A:min/b3 were refused
--                            even though the overlay now renders them;
--     * too loose on quality: C:zzz passed.
--   The web route (api/chord-edits/route.ts) and edit-collector.ts now share
--   chord/harte.ts, which is the same grammar.
--
-- Grammar: N | X | root[:quality][/bass]. 24 explicit qualities. Bass is a
-- Harte interval (zero or more b/# then degree 1..13), never a note name. N
-- and X take no quality or bass. POSIX ARE, not PCRE: no (?:), no \/ escape;
-- alternation is anchored so maj/maj7 and 1/10 backtrack correctly.
--
-- Existing rows: chord_edits is append-only training data, so we never delete
-- or rewrite. The constraint is added NOT VALID (enforced for every new write
-- immediately, existing rows are not scanned), then VALIDATEd only when no
-- existing row violates it. On a violating table the migration still succeeds,
-- raises a NOTICE with the count, and leaves the constraint NOT VALID: new
-- writes are protected, old rows stay for manual triage. On the expected empty
-- table the constraint ends fully validated.
--
-- The constraint NAME is unchanged: route.ts maps chord_edits_valid_harte to
-- CHORD_EDIT_HARTE (23514), so nothing there has to move.
--
-- Immutable migration 025 is NOT touched. Down: migrations/down/029_v3_chord_edits_harte_slash_down.sql.

ALTER TABLE public.chord_edits DROP CONSTRAINT IF EXISTS chord_edits_valid_harte;

ALTER TABLE public.chord_edits
  ADD CONSTRAINT chord_edits_valid_harte CHECK (
    corrected_label ~ '^(N|X|[A-G](#|b)?(:(maj|min|dim|aug|sus2|sus4|maj6|min6|maj7|min7|7|dim7|hdim7|minmaj7|maj9|min9|9|11|13|add9|add11|5|add6|aug7))?(/[b#]*(10|11|12|13|[1-9]))?)$'
  ) NOT VALID;

DO $$
DECLARE
  n_bad bigint;
BEGIN
  SELECT count(*) INTO n_bad FROM public.chord_edits
   WHERE NOT (corrected_label ~ '^(N|X|[A-G](#|b)?(:(maj|min|dim|aug|sus2|sus4|maj6|min6|maj7|min7|7|dim7|hdim7|minmaj7|maj9|min9|9|11|13|add9|add11|5|add6|aug7))?(/[b#]*(10|11|12|13|[1-9]))?)$');
  IF n_bad = 0 THEN
    ALTER TABLE public.chord_edits VALIDATE CONSTRAINT chord_edits_valid_harte;
  ELSE
    RAISE NOTICE '029: % existing chord_edits row(s) violate chord_edits_valid_harte; constraint left NOT VALID (new writes enforced). Triage by hand.', n_bad;
  END IF;
END $$;
