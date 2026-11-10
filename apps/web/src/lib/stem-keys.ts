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

// Signed-URL lifetime CEILING for a stem, in seconds.
//
// TSD §12.2 requires "short-TTL signed GETs". 15 min, not the chord artifact's 5: a
// stem is ~4-5 MB and the mixer opens all six, so a phone on a slow line needs
// materially longer than a small JSON fetch. The route takes
// min(this, presignTtlSec(expires_at)) so a URL is never longer-lived than this AND
// never outlives the objects it points at — an earlier version used presignTtlSec
// alone, which traded the outlive bug for a 24-hour stem URL.
export const STEM_SIGNED_URL_TTL_SEC = 900;

// The six stems htdemucs_6s emits (replicate_client.STEM_RENAME maps piano -> keys).
// Order is the mixer's channel order, not alphabetical: rhythm section first.
// ALL SIX are retained regardless of which loops the user asked for — `requested_stems`
// governs loop cutting only. A mixer missing an instrument is worse than useless.
export const PLAYABLE_STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'] as const;
export type PlayableStem = (typeof PLAYABLE_STEMS)[number];

/** The shared parent of both artifact prefixes — one list call covers them both. */
export const STEM_PREFIX = '_stems/';
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

function stemNameFrom(key: string, prefix: string, ext: string): PlayableStem | null {
  // Require the FULL prefix, not just the extension: play/ and dl/ are siblings, so
  // matching on extension alone would let a download key be served as playback.
  const marker = `/${prefix}`;
  const at = key.indexOf(marker);
  if (at < 0) return null;
  const file = key.slice(at + marker.length);
  if (!file.endsWith(`.${ext}`) || file.includes('/')) return null;
  const name = file.slice(0, -(ext.length + 1));
  return (PLAYABLE_STEMS as readonly string[]).includes(name) ? (name as PlayableStem) : null;
}

/** Parse a stem name out of a PLAYBACK key, or null if it is not one of the six.
 *
 * Validated against the closed set on purpose: the prefix is shared with whatever
 * else a future change puts under it, and an unvalidated `pop()` would happily
 * surface a stray object — or the WAV download artifact — as a playable stem.
 */
export function stemNameFromPlayKey(key: string): PlayableStem | null {
  return stemNameFrom(key, STEM_PLAY_PREFIX, STEM_PLAY_EXT);
}

/** Parse a stem name out of a DOWNLOAD key, or null.
 *
 * Needed to tell two states apart that otherwise look identical: a job that
 * predates V3-J2 (no stems at all) and a job whose Opus encoding failed (six WAVs,
 * zero Opus). Both yield an empty playback set, and a reviewer demonstrated that
 * collapsing them hides a total encoder failure behind "not an error".
 */
export function stemNameFromDownloadKey(key: string): PlayableStem | null {
  return stemNameFrom(key, STEM_DOWNLOAD_PREFIX, STEM_DOWNLOAD_EXT);
}

/** What the mixer should do with a job, derived from what actually landed in R2. */
export type StemState =
  /** No stems of either kind: a pre-V3-J2 job. Fall back to the loop view. */
  | 'unavailable'
  /** All six playable. */
  | 'ready'
  /** Some but not all playable — a mix with an instrument missing. Do not autoplay. */
  | 'partial'
  /** Downloads exist but nothing is playable: the ENCODER failed. Alertable. */
  | 'encode_failed';

export function stemState(playCount: number, downloadCount: number): StemState {
  if (playCount === PLAYABLE_STEMS.length) return 'ready';
  if (playCount > 0) return 'partial';
  return downloadCount > 0 ? 'encode_failed' : 'unavailable';
}
