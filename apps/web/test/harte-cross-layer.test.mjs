// Web layers of the cross-layer Harte table (issue #141, item 4).
//
// The expected validity of every label lives in fixtures/contracts/harte-labels.json (hand
// authored, independent of any validator). Here each label is pushed through the two web
// entry points a user's correction actually takes, not through a regex in isolation:
//   * the REAL POST /api/chord-edits route (accept = 201, reject = 400 CHORD_EDIT_HARTE)
//   * the REAL edit-collector validateChordEdit (reject = EDIT_HARTE)
// The worker validator and the migrated DB CHECK are run against the same file by
// apps/worker/tests/test_harte_cross_layer.py. If the four ever disagree, one of the two
// suites fails on the exact label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';
import { HARTE_QUALITIES } from '../src/chord/harte.ts';

const TABLE = JSON.parse(
  readFileSync(join(WEB, '..', '..', 'fixtures', 'contracts', 'harte-labels.json'), 'utf8'),
);
const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const harteUrl = () => dataUrl(toJs('src/chord/harte.ts'));

async function loadRoute() {
  const auth = dataUrl(`export const getUser = async () => ({ user_id: '11111111-1111-1111-1111-111111111111', email: 'u@x.co' });`);
  const run = `async (text) => {
      const t = String(text);
      if (t.includes('FROM public.jobs') && t.includes('AND user_id')) return { rows: [{ x: 1 }], rowCount: 1 };
      if (t.includes('SELECT COUNT(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (t.includes('INSERT INTO public.chord_edits')) return { rows: [{ id: 'e1', created_at: 'now' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }`;
  const db = dataUrl(`const run = ${run}; export const db = { query: run, tx: async (fn) => fn({ query: run }) };`);
  const sentry = dataUrl(`export const captureException = () => {};`);
  const next = dataUrl(`export class NextResponse {
    constructor(b, i = {}) { this.status = i.status ?? 200; this.headers = new Map(); this.body = b; }
    static json(body, init = {}) { return { status: init.status ?? 200, body, headers: new Map() }; }
  }`);
  const js = toJs('src/app/api/chord-edits/route.ts')
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${auth}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentry}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`)
    .replace(/from ['"]@\/chord\/harte['"]/g, `from '${harteUrl()}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

async function loadCollector() {
  const js = toJs('src/chord/edit-collector.ts').replace(/from '\.\/harte\.ts'/, `from '${harteUrl()}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const BODY = {
  job_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  track_hash: 'f'.repeat(64),
  start_sec: 0, end_sec: 2,
  original_label: 'orig-label',
  provider: 'klangio', provider_version: 'klangio@1.0',
  alphabet_sha: 'a'.repeat(64),
};
const EDIT = {
  jobId: BODY.job_id, trackHash: 't' + 'a'.repeat(63), startSec: 0, endSec: 2,
  originalLabel: BODY.original_label, provider: 'klangio', providerVersion: 'klangio@1.0',
  alphabetSha: 'a'.repeat(64),
};

test('table covers all 24 qualities and matches the web alphabet', () => {
  assert.equal(TABLE.qualities.length, 24);
  assert.deepEqual([...TABLE.qualities].sort(), [...HARTE_QUALITIES].sort());
  const valid = new Set(TABLE.labels.filter((l) => l.valid).map((l) => l.label));
  for (const q of TABLE.qualities) assert.ok(valid.has(`C:${q}`), `no valid case for ${q}`);
});

test('real chord-edits route agrees with the table on every label', async () => {
  const route = await loadRoute();
  const wrong = [];
  for (const { label, valid, note } of TABLE.labels) {
    const res = await route.POST({ json: async () => ({ ...BODY, corrected_label: label }), headers: new Map() });
    const accepted = res.status === 201;
    const harteRejected = res.body?.error_code === 'CHORD_EDIT_HARTE';
    if (valid && !accepted) wrong.push(`route REJECTED valid ${JSON.stringify(label)} (${note}): ${res.status} ${res.body?.error_code}`);
    if (!valid && !harteRejected) wrong.push(`route did not reject invalid ${JSON.stringify(label)} (${note}) with CHORD_EDIT_HARTE: ${res.status} ${res.body?.error_code}`);
  }
  assert.deepEqual(wrong, []);
});

test('real edit-collector agrees with the table on every label', async () => {
  const { validateChordEdit } = await loadCollector();
  const wrong = [];
  for (const { label, valid, note } of TABLE.labels) {
    let code = null;
    try { validateChordEdit({ ...EDIT, correctedLabel: label }); } catch (e) { code = e.code ?? String(e); }
    if (valid && code) wrong.push(`collector REJECTED valid ${JSON.stringify(label)} (${note}): ${code}`);
    if (!valid && code !== 'EDIT_HARTE') wrong.push(`collector did not reject invalid ${JSON.stringify(label)} (${note}) with EDIT_HARTE: ${code}`);
  }
  assert.deepEqual(wrong, []);
});
