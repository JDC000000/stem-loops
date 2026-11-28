// QW-2 (#492 review): the REAL lib/jobs/stem-artifacts.ts `hasPlayableStems`, with only `r2`
// (lib/r2.ts) and the limiters (lib/admission.ts) stubbed. lib/stem-keys.ts is real.
// Pins the money guarantee "could not tell → null → the paste reuses the old job (no second
// charge)" and the cost bound "every R2 list is admitted by checkPasteProbeRate first".
// #494 item 4: the probe spends its OWN per-IP budget, never the player's checkStemListRate.
// #494 item 2: one list of `<job>/` tells a legacy (pre-V3-J2) job, which is reused, from an
// encode failure and from a job whose objects are gone.
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
      return { Contents: s.keys.map((Key) => ({ Key })), IsTruncated: !!s.truncated }; } };`,
    'lib/admission.ts': `export const checkStemListRate = async (ipHash) => {
      globalThis.__sa.calls.push('PLAYER-BUDGET:' + ipHash); return { allowed: true }; };
    export const checkPasteProbeRate = async (ipHash) => {
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

test('playable: an opus play key is listed → true; rate admitted BEFORE the list, prefix is the whole job folder', async () => {
  reset({ keys: [`${JOB}/_stems/dl/drums.wav`, `${JOB}/_stems/play/drums.opus`] });
  assert.equal(await probe(), true);
  assert.deepEqual(S().calls, ['rate:iphash', 'r2.send'], 'checkPasteProbeRate is invoked, and first');
  assert.equal(S().sent[0].Prefix, `${JOB}/`);
  assert.equal(S().sent[0].MaxKeys, 100);
});

test('#494-4: the probe never spends the player\'s stems budget (checkStemListRate)', async () => {
  for (const keys of [[], [`${JOB}/_stems/play/drums.opus`], [`${JOB}/drums/4bar_verse_0001.wav`]]) {
    reset({ keys });
    await probe();
    assert.equal(S().calls.filter((c) => c.startsWith('PLAYER-BUDGET')).length, 0, JSON.stringify(keys));
  }
});

test('gone: nothing at all under the job folder → false (the paste skips this job)', async () => {
  reset({ keys: [] });
  assert.equal(await probe(), false);
  assert.deepEqual(S().calls, ['rate:iphash', 'r2.send']);
});

test('encode_failed shape: download WAVs / stray stem keys, no playable one → false, even with loops present', async () => {
  reset({ keys: [`${JOB}/_stems/dl/drums.wav`, `${JOB}/_stems/play/notastem.opus`, `${JOB}/_stems/play/drums.wav`] });
  assert.equal(await probe(), false);
  reset({ keys: [`${JOB}/_stems/dl/drums.wav`, `${JOB}/drums/4bar_verse_0001.wav`] });
  assert.equal(await probe(), false, 'loops beside download-only stems are still an encode failure');
  reset({ keys: [`${JOB}/_stems/play/notastem.opus`, `${JOB}/drums/4bar_verse_0001.wav`] });
  assert.equal(await probe(), false, 'any _stems/ key means V3-J2 ran: not legacy');
});

test('#494-2: legacy (pre-V3-J2) job: loops but no _stems/ key at all → true (reused, as the player falls back to loops)', async () => {
  reset({ keys: [`${JOB}/bass/4bar_chorus_0002.wav`, `${JOB}/drums/4bar_verse_0001.wav`] });
  assert.equal(await probe(), true);
  reset({ keys: [`${JOB}/_input.wav`, `${JOB}/drums/4bar_verse_0001.wav`] });
  assert.equal(await probe(), true);
  // A key of ANOTHER job (a prefix bug) is not evidence for this one.
  reset({ keys: [`${JOB}x/drums/4bar_verse_0001.wav`] });
  assert.equal(await probe(), false);
});

test('#494-2: a truncated page with no playable key → null (could not tell), never true or false', async () => {
  reset({ keys: [`${JOB}/drums/4bar_verse_0001.wav`], truncated: true });
  assert.equal(await probe(), null);
  reset({ keys: [`${JOB}/_stems/dl/drums.wav`], truncated: true });
  assert.equal(await probe(), null, 'the play keys could be on the next page');
  // A playable key on a truncated page is still decisive.
  reset({ keys: [`${JOB}/_stems/play/bass.opus`], truncated: true });
  assert.equal(await probe(), true);
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
