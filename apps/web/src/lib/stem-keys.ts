// V3-J2 — stem key layout and mixer constants.
//
// Pure module: no `@aws-sdk`, no `@/` alias imports, no `next`. That is deliberate,
// following the same reasoning as lib/hcaptcha.ts — it makes the key contract unit
// testable with the bare `node:test` runner, which cannot resolve the `@/` path
// alias. r2.ts re-exports all of this, so callers import from either.
//
// ⚠️ The prefix is a correctness property, not a style choice. cleanup.py deletes a
// job's objects with `delete_prefix(f"{job_id}/")`, and its `_job_id_of()` reads the
// FIRST path segment. `play.chords.json` is written as `jobs/<id>/...`, whose first
// segment is the literal "jobs", so the per-job delete misses it and it survives
// until the budget-limited orphan sweep happens to catch it. A stem is 40-60 MB and
// there are six per job, so stems must sit under `<jobId>/`.

// 15 min, not the chord artifact's 5: a stem is ~40-60 MB and the mixer opens all
// six at once, so a slow connection needs materially longer than a small JSON fetch.
export const STEM_SIGNED_URL_TTL_SEC = 900;

// The six stems htdemucs_6s emits (replicate_client.STEM_RENAME maps piano -> keys).
// Order is the mixer's channel order, not alphabetical: rhythm section first.
export const PLAYABLE_STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'] as const;
export type PlayableStem = (typeof PLAYABLE_STEMS)[number];

export function stemR2Key(jobId: string, stem: string): string {
  // Mirror apps/worker/src/worker/storage/r2_uploader.py:stem_r2_key — the worker
  // writes exactly this key; drift here silently 404s the mixer, and a 404 is
  // indistinguishable from "this job has no stems". Pinned on both sides by tests.
  return `${jobId}/_stems/${stem}.wav`;
}
