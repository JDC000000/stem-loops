import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUploadKey, validateUpload, ACCEPTED_TYPES } from './upload.ts';

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

// W1 overnight QA (2026-11-12, P2): `ext in ACCEPTED_TYPES` also matched inherited
// Object.prototype keys, so POST /api/uploads presigned `a.constructor` (content
// type = a function) and `a.__proto__` (content type = {}). Only own keys count.
test('validateUpload rejects Object.prototype names as extensions', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__']) {
    const v = validateUpload(`a.${name}`, 1000);
    assert.equal(v.ok, false, `a.${name} must be refused`);
    assert.equal(v.error_code, 'UPLOAD_INVALID');
  }
});
test('validateUpload still accepts every listed type, case-insensitively, with a string content type', () => {
  for (const [ext, ct] of Object.entries(ACCEPTED_TYPES)) {
    for (const name of [`song.${ext}`, `SONG.${ext.toUpperCase()}`]) {
      const v = validateUpload(name, 1000);
      assert.equal(v.ok, true, name);
      assert.equal(v.ext, ext);
      assert.equal(v.contentType, ct);
      assert.equal(typeof v.contentType, 'string');
    }
  }
});
