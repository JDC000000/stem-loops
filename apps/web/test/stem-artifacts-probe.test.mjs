// QW-2 (#492 review): the REAL lib/jobs/stem-artifacts.ts `hasPlayableStems`, with only `r2`
// (lib/r2.ts) and `checkStemListRate` (lib/admission.ts) stubbed. lib/stem-keys.ts is real.
// Pins the money guarantee "could not tell → null → the paste reuses the old job (no second
// charge)" and the cost bound "every R2 list is admitted by checkStemListRate first".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildModuleGraph } from './helpers/module-graph.mjs';

const S = () => globalThis.__sa;
const graph = buildModuleGraph({
  name: 'stem-artifacts-probe',
  entries: ['lib/jobs/stem-artifacts.ts'],
  overrides: {
    'lib/r2.ts': `export const r2 = { send: async (cmd) => {
      const s = globalThis.__sa; s.calls.push('r2.send'); s.sent.push(cmd.input);
      if (s.r2Throws) throw new Error('R2 down');
      return { Contents: s.keys.map((Key) => ({ Key })) }; } };`,
    'lib/admission.ts': `export const checkStemListRate = async (ipHash) => {
      const s = globalThis.__sa; s.calls.push('rate:' + ipHash);
      if (s.rateThrows) throw new Error('db down');
      return s.allowed ? { allowed: true } : { allowed: false, error_code: 'RATE_LIMITED' }; };`,
  },
});
const { hasPlayableStems } = await import(graph.url('lib/jobs/stem-artifacts.ts'));

const JOB = '0f8fad5b-d9cb-469f-a165-70867728950e';
function reset(state = {}) {
  globalThis.__sa = { calls: [], sent: [], keys: [], allowed: true, r2Throws: false, rateThrows: false, ...state };
}
const ip = () => 'iphash';
async function probe(ipHash = ip) {
  const orig = console.error;
  console.error = () => {};
  try { return await hasPlayableStems(JOB, ipHash); } finally { console.error = orig; }
}

test('playable: an opus play key is listed → true; rate admitted BEFORE the list, prefix is the play folder', async () => {
  reset({ keys: [`${JOB}/_stems/dl/drums.wav`, `${JOB}/_stems/play/drums.opus`] });
  assert.equal(await probe(), true);
  assert.deepEqual(S().calls, ['rate:iphash', 'r2.send'], 'checkStemListRate is invoked, and first');
  assert.equal(S().sent[0].Prefix, `${JOB}/_stems/play/`);
});

test('no stems: empty list → false (the paste skips this job)', async () => {
  reset({ keys: [] });
  assert.equal(await probe(), false);
  assert.deepEqual(S().calls, ['rate:iphash', 'r2.send']);
});

test('encode_failed shape: only download WAVs / stray keys → false', async () => {
  reset({ keys: [`${JOB}/_stems/dl/drums.wav`, `${JOB}/_stems/play/notastem.opus`, `${JOB}/_stems/play/drums.wav`] });
  assert.equal(await probe(), false);
});

test('rate-limited → null ("unknown": reuse the old job, no new charge) and R2 is NOT listed', async () => {
  reset({ allowed: false, keys: [] });
  assert.equal(await probe(), null);
  assert.deepEqual(S().calls, ['rate:iphash'], 'a refused probe spends no R2 list');
});

test('R2 fault → null ("unknown"), never false', async () => {
  reset({ r2Throws: true });
  assert.equal(await probe(), null);
});

test('rate limiter fault → null; client IP hash unavailable → null and nothing called', async () => {
  reset({ rateThrows: true });
  assert.equal(await probe(), null);
  assert.deepEqual(S().calls, ['rate:iphash']);
  reset({ keys: [`${JOB}/_stems/play/drums.opus`] });
  assert.equal(await probe(() => { throw new Error('IP_HASH_KEY unset'); }), null);
  assert.deepEqual(S().calls, []);
});
