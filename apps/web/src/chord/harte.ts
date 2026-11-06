/**
 * Harte label validator for the chord-correction write path.
 *
 * Single TS copy, imported by BOTH `app/api/chord-edits/route.ts` and
 * `chord/edit-collector.ts` (two private copies is how they drifted).
 *
 * Mirrors, and must stay in lockstep with:
 *   - apps/worker/src/worker/chord_source.py   (HARTE_RE; reference)
 *   - apps/training/model/alphabet.py          (source of truth)
 *   - apps/worker/migrations/029_v3_chord_edits_harte_slash.sql (DB CHECK)
 *
 * Grammar: N | X | root [":" quality] ["/" bass]. Root is A-G with an optional
 * #/b. Quality is one of the 24 alphabet qualities (QUALITY_LABELS minus the
 * N slot). Bass is a Harte INTERVAL, not a note name: zero or more b/# then a
 * degree 1..13. N and X take no quality or bass.
 */
export const HARTE_QUALITIES = [
  'maj', 'min', 'dim', 'aug', 'sus2', 'sus4', 'maj6', 'min6', 'maj7', 'min7',
  '7', 'dim7', 'hdim7', 'minmaj7', 'maj9', 'min9', '9', '11', '13', 'add9',
  'add11', '5', 'add6', 'aug7',
] as const;

export const HARTE_BASS_SRC = '/[b#]*(?:1[0-3]|[1-9])';

export const HARTE_RE = new RegExp(
  '^(?:N|X|[A-G](?:#|b)?(?::(?:' + HARTE_QUALITIES.join('|') + '))?(?:' + HARTE_BASS_SRC + ')?)$',
);
