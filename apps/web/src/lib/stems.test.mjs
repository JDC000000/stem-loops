// Run: pnpm --filter web test   (node >= 22.6, built-in type stripping + test runner)
//
// V3-J2 key-mirror pin. The worker writes the stem objects and the web app reads
// them; the two key builders are in different languages in different packages, so
// nothing but a test stops them drifting. A drifted key 404s, and a 404 is
// indistinguishable from "this job has no stems" — the failure is SILENT. These
// assertions are deliberately literal: the shared contract IS the string.
//
// The Python side is pinned to the same literals in
// apps/worker/tests/test_stem_keys.py. Changing the layout fails both suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stemPlayR2Key,
  stemDownloadR2Key,
  stemNameFromPlayKey,
  PLAYABLE_STEMS,
  STEM_PLAY_PREFIX,
  STEM_DOWNLOAD_PREFIX,
} from './stem-keys.ts';

const JOB = '550e8400-e29b-41d4-a716-446655440000';

test('playback key matches the worker literal, exactly', () => {
  assert.equal(stemPlayR2Key(JOB, 'drums'), `${JOB}/_stems/play/drums.opus`);
  assert.equal(stemPlayR2Key(JOB, 'keys'), `${JOB}/_stems/play/keys.opus`);
});

test('download key matches the worker literal, exactly', () => {
  assert.equal(stemDownloadR2Key(JOB, 'bass'), `${JOB}/_stems/dl/bass.wav`);
});

test('playback is Opus and download is WAV — not the other way round', () => {
  // TSD 12.2: Opus for playback (4-5 MB/stem), WAV for the DAW hand-off. Serving
  // WAV to the mixer is 240-360 MB per song against a measured 287 MB engine
  // budget, which is the specific defect this pairing exists to prevent.
  assert.ok(stemPlayR2Key(JOB, 'vocals').endsWith('.opus'));
  assert.ok(stemDownloadR2Key(JOB, 'vocals').endsWith('.wav'));
});

test('the two artifacts live in DIFFERENT sub-prefixes', () => {
  // Side by side, `vocals.opus` and `vocals.wav` parse to the same stem name and
  // surface as a duplicate or an arbitrary winner.
  assert.notEqual(STEM_PLAY_PREFIX, STEM_DOWNLOAD_PREFIX);
  const play = stemPlayR2Key(JOB, 'other');
  const dl = stemDownloadR2Key(JOB, 'other');
  assert.notEqual(play.slice(0, play.lastIndexOf('/')), dl.slice(0, dl.lastIndexOf('/')));
});

test('both keys sit UNDER the job prefix, so retention covers them', () => {
  // The property that matters: `<jobId>/` is the prefix the retention sweep is built
  // around. play.chords.json is written as `jobs/<id>/...` and that exception leaked
  // — the per-job delete was delete_prefix(f"{job_id}/") alone and missed it on every
  // job. cleanup.py now walks r2_uploader.job_object_prefixes(job_id), which lists both;
  // a stem under a NEW top-level prefix would need the same, so keep them here.
  // Stems are ~50 MB each and six per job.
  for (const stem of PLAYABLE_STEMS) {
    for (const key of [stemPlayR2Key(JOB, stem), stemDownloadR2Key(JOB, stem)]) {
      assert.equal(key.split('/', 1)[0], JOB, `${key}: first segment must be the job id`);
      assert.ok(!key.startsWith('jobs/'), `${key}: must NOT use the jobs/ prefix`);
    }
  }
});

test('stem keys never collide with loop keys', () => {
  // Loops are `{job_id}/{stem}/{section}_{idx}.wav`. `_stems` is underscore-prefixed
  // (matching `_input.wav`) and no stem is named `_stems`, so the namespaces are disjoint.
  assert.ok(!PLAYABLE_STEMS.includes('_stems'));
  for (const stem of PLAYABLE_STEMS) {
    assert.equal(stemPlayR2Key(JOB, stem).split('/')[1], '_stems');
  }
});

test('all six stems, in mixer channel order, rhythm section first', () => {
  // All six are retained regardless of requested_stems. A job that asked for only
  // vocals previously retained no DRUMS, and the mixer played a drumless song with
  // no error at all.
  assert.deepEqual([...PLAYABLE_STEMS], ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);
  assert.equal(PLAYABLE_STEMS.length, 6);
});

test('stemNameFromPlayKey accepts only the six, and only .opus', () => {
  assert.equal(stemNameFromPlayKey(`${JOB}/_stems/play/drums.opus`), 'drums');
  // the WAV download artifact must never be surfaced as a playback stem
  assert.equal(stemNameFromPlayKey(`${JOB}/_stems/dl/drums.wav`), null);
  // a stray object under the prefix must not become a playable channel
  assert.equal(stemNameFromPlayKey(`${JOB}/_stems/play/README.opus`), null);
  assert.equal(stemNameFromPlayKey(`${JOB}/_stems/play/harmonic_mix.opus`), null);
  assert.equal(stemNameFromPlayKey(`${JOB}/_stems/play/`), null);
  assert.equal(stemNameFromPlayKey(''), null);
});
