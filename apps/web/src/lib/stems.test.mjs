// Run: pnpm --filter web test   (node >= 22.6, built-in type stripping + test runner)
//
// V3-J2 key-mirror pin. The worker writes the stem objects and the web app reads
// them; the two key builders live in different languages in different packages,
// so nothing but a test stops them drifting. The chord overlay already carries a
// comment warning that exactly this drift "silently 404s" the feature — a 404 is
// indistinguishable from "this job has no stems", so the failure is SILENT. These
// assertions are deliberately literal: the shared contract is the string itself.
//
// The Python side is pinned to the same literal in
// apps/worker/tests/test_stem_keys.py. Changing the layout fails both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stemR2Key, PLAYABLE_STEMS, STEM_SIGNED_URL_TTL_SEC } from './stem-keys.ts';

const JOB = '550e8400-e29b-41d4-a716-446655440000';

test('stem key matches the worker literal, exactly', () => {
  assert.equal(stemR2Key(JOB, 'drums'), `${JOB}/_stems/drums.wav`);
  assert.equal(stemR2Key(JOB, 'keys'), `${JOB}/_stems/keys.wav`);
});

test('stem keys sit UNDER the job prefix, so retention covers them', () => {
  // This is the property that matters, not an aesthetic choice. cleanup.py deletes
  // a job's objects with delete_prefix(f"{job_id}/") and _job_id_of() reads the
  // FIRST path segment. play.chords.json is written as `jobs/<id>/...`, whose first
  // segment is the literal "jobs" — so the per-job delete MISSES it and it survives
  // until the budget-limited orphan sweep happens to catch it. A stem is 40-60 MB,
  // six per job, so leaking them would be far worse than leaking a small JSON.
  for (const stem of PLAYABLE_STEMS) {
    const key = stemR2Key(JOB, stem);
    assert.equal(key.split('/', 1)[0], JOB, `${stem}: first segment must be the job id`);
    assert.ok(!key.startsWith('jobs/'), `${stem}: must NOT use the jobs/ prefix`);
  }
});

test('stem keys never collide with loop keys', () => {
  // Loops are `{job_id}/{stem}/{section}_{idx}.wav`, so a second segment equal to a
  // stem name is a loop directory. `_stems` is underscore-prefixed (matching
  // `_input.wav`) and no stem is named "_stems", so the namespaces are disjoint.
  assert.ok(!PLAYABLE_STEMS.includes('_stems'));
  for (const stem of PLAYABLE_STEMS) {
    assert.equal(stemR2Key(JOB, stem).split('/')[1], '_stems');
  }
});

test('six stems, in mixer channel order, rhythm section first', () => {
  assert.deepEqual([...PLAYABLE_STEMS], ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);
});

test('stem TTL is longer than the chord artifact TTL', () => {
  // A stem is ~40-60 MB and the mixer opens all six; the chord JSON is a few KB on
  // a 5-minute TTL. Giving stems the same TTL would expire mid-download on a phone.
  assert.ok(STEM_SIGNED_URL_TTL_SEC >= 900, 'at least 15 minutes');
});
