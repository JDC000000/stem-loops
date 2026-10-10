import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUploadKey } from './upload.ts';

const ID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';

test('accepts exactly what /api/uploads issues', () => {
  assert.equal(isValidUploadKey(ID, `${ID}/_input.mp3`), true);
  assert.equal(isValidUploadKey(ID, `${ID}/_input.wav`), true);
  assert.equal(isValidUploadKey(ID.toUpperCase(), `${ID}/_input.flac`), true); // id canonicalised
});
test('rejects traversal, extra segments, uppercase key, bad ext, other job', () => {
  for (const k of [
    `${ID}/../${ID}/_input.mp3`,
    `${ID}/x/_input.mp3`,
    `${ID}/_input.mp3/`,
    `${ID}/_input.mp3/../other`,
    `${ID.toUpperCase()}/_input.mp3`,
    `${ID}/_input.exe`,
    `${ID}/_input.`,
    `${ID}/_input`,
    `${ID}/other.mp3`,
    `${ID}x/_input.mp3`,
    `/${ID}/_input.mp3`,
    `00000000-0000-4000-8000-000000000000/_input.mp3`,
    `${ID}/_input.constructor`,
    ``,
  ]) {
    assert.equal(isValidUploadKey(ID, k), false, k);
  }
});
