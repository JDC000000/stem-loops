// V3-J2 — stem key layout and mixer constants.
//
// Pure module: no `@aws-sdk`, no `@/` alias imports, no `next`. Deliberate, for two
// reasons. It makes the key contract unit-testable with the bare `node:test` runner,
// which cannot resolve the `@/` path alias (same reasoning as lib/hcaptcha.ts). And
// it keeps these additions OUT of lib/r2.ts, which the play-chords and CSP contract
// tests load by inlining as a base64 `data:` URL — a `data:` module has no base URL,
// so any relative import added to r2.ts fails to resolve and takes 10 tests down.
//
// TWO artifacts per stem, per TSD 12.2, in SEPARATE sub-prefixes:
//
//   <jobId>/_stems/play/<stem>.opus   playback  — Opus, 4-5 MB/stem
//   <jobId>/_stems/dl/<stem>.wav      download  — WAV, for a DAW
//
// Separate sub-prefixes rather than two extensions in one directory: the reader
// lists the prefix and parses the stem name out of the key, so side by side
// `vocals.opus` and `vocals.wav` would collapse to one name and surface as a
// duplicate or an arbitrary winner.
//
// ⚠️ Both sit under `<jobId>/`, and that is a correctness property. cleanup.py's
// per-job delete is `delete_prefix(f"{job_id}/")` and its `_job_id_of()` reads the
// FIRST path segment. `play.chords.json` is written as `jobs/<id>/...`, whose first
// segment is the literal "jobs", so the per-job delete misses it and it survives
// until the budget-limited orphan sweep happens to catch it. Stems are far larger.

// The six stems htdemucs_6s emits (replicate_client.STEM_RENAME maps piano -> keys).
// Order is the mixer's channel order, not alphabetical: rhythm section first.
// ALL SIX are retained regardless of which loops the user asked for — `requested_stems`
// governs loop cutting only. A mixer missing an instrument is worse than useless.
export const PLAYABLE_STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'] as const;
export type PlayableStem = (typeof PLAYABLE_STEMS)[number];

export const STEM_PLAY_PREFIX = '_stems/play/';
export const STEM_DOWNLOAD_PREFIX = '_stems/dl/';
export const STEM_PLAY_EXT = 'opus';
export const STEM_DOWNLOAD_EXT = 'wav';

export function stemPlayR2Key(jobId: string, stem: string): string {
  // Mirror apps/worker/.../r2_uploader.py:stem_play_r2_key. Drift silently 404s the
  // mixer, and a 404 is indistinguishable from "this job has no stems". Pinned both sides.
  return `${jobId}/${STEM_PLAY_PREFIX}${stem}.${STEM_PLAY_EXT}`;
}

export function stemDownloadR2Key(jobId: string, stem: string): string {
  // Mirror apps/worker/.../r2_uploader.py:stem_download_r2_key.
  return `${jobId}/${STEM_DOWNLOAD_PREFIX}${stem}.${STEM_DOWNLOAD_EXT}`;
}

/** Parse a stem name out of a playback key, or null if it is not one of the six.
 *
 * Validated against the closed set on purpose: the prefix is shared with whatever
 * else a future change puts under it, and an unvalidated `pop()` would happily
 * surface a stray object as a playable stem.
 */
export function stemNameFromPlayKey(key: string): PlayableStem | null {
  const file = key.split('/').pop();
  if (!file || !file.endsWith(`.${STEM_PLAY_EXT}`)) return null;
  const name = file.slice(0, -(STEM_PLAY_EXT.length + 1));
  return (PLAYABLE_STEMS as readonly string[]).includes(name) ? (name as PlayableStem) : null;
}
