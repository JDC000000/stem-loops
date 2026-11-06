// Worker <-> web contract for the completed-job chord overlay (issue #141, item 3).
//
// Wires the REAL pieces end to end, with only the network edges faked:
//   golden file (written by the worker's real upload path, see
//   apps/worker/tests/test_chord_golden_contract.py)
//     -> "R2": serves that JSON ONLY at the key the worker wrote it to
//   real route  GET /api/jobs/[id]/play-chords  (db stubbed to a 'done' job)
//     -> real r2.ts mints a genuinely-signed URL (offline SigV4)
//   real loader fetchPlayChords -> observations
//
// So: rename a field in ChordResult or the loader, or move the R2 key on either side, and the
// overlay data stops arriving here exactly as it would in production.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';
import { fetchPlayChords } from '../src/chord/play-chords-loader.ts';

const GOLDEN = JSON.parse(
  readFileSync(join(WEB, '..', '..', 'fixtures', 'contracts', 'play-chords.golden.json'), 'utf8'),
);
const JOB = GOLDEN.job_id;

const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const resolveBare = (spec) => new URL(import.meta.resolve(spec)).href;

process.env.R2_ACCOUNT_ID = 'acct123';
process.env.R2_BUCKET_NAME = 'stem-loops-test';
process.env.R2_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
process.env.R2_SECRET_ACCESS_KEY = 'secret-secret-secret-secret';
delete process.env.MINIO_ENDPOINT;

async function loadRoute() {
  const retention = dataUrl(toJs('src/lib/retention.ts'));
  const r2Js = toJs('src/lib/r2.ts')
    .replace(/from ['"]@aws-sdk\/client-s3['"]/, `from '${resolveBare('@aws-sdk/client-s3')}'`)
    .replace(/from ['"]@aws-sdk\/s3-request-presigner['"]/, `from '${resolveBare('@aws-sdk/s3-request-presigner')}'`)
    .replace(/from ['"]@\/lib\/retention['"]/, `from '${retention}'`);
  const r2 = dataUrl(r2Js);
  const db = dataUrl(`export const db = { query: (...a) => globalThis.__dbQuery(...a) };`);
  const sentry = dataUrl(`export const captureException = (e) => { globalThis.__sentry.push(e); };`);
  const next = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }
  `);
  const js = toJs('src/app/api/jobs/[id]/play-chords/route.ts')
    .replace(/from ['"]next\/server['"]/, `from '${next}'`)
    .replace(/import \* as Sentry from ['"]@sentry\/nextjs['"]/, `import * as Sentry from '${sentry}'`)
    .replace(/from ['"]@\/lib\/db['"]/, `from '${db}'`)
    .replace(/from ['"]@\/lib\/r2['"]/, `from '${r2}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

let route; let originalFetch; let fetched;
const setJob = (row) => {
  globalThis.__dbQuery = async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
};

/** Fake R2: an object exists ONLY at the key the worker wrote; anything else is a 404. */
function installFakeR2(extraObjects = {}) {
  const objects = { [GOLDEN.r2_key]: GOLDEN.payload, ...extraObjects };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'http://app.test');
    fetched.push(u);
    const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (u.pathname.startsWith('/api/')) {
      const res = await route.GET({}, { params: { id: JOB } });
      return { status: res.status, ok: res.status < 300, json: async () => res.body };
    }
    const obj = objects[key];
    return obj === undefined
      ? { status: 404, ok: false, json: async () => ({}) }
      : { status: 200, ok: true, json: async () => obj };
  };
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  fetched = [];
  globalThis.__sentry = [];
  route = await loadRoute();
  setJob({ id: JOB, status: 'done' });
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('route: a done job returns 200 with a really-signed URL for the key the worker writes', async () => {
  const res = await route.GET({}, { params: { id: JOB } });
  assert.equal(res.status, 200);
  const u = new URL(res.body.signed_url);
  assert.equal(decodeURIComponent(u.pathname), '/' + GOLDEN.r2_key, 'signed key != worker key');
  assert.equal(u.hostname.startsWith('stem-loops-test.') || u.pathname.startsWith('/stem-loops-test/'), true);
  assert.ok(u.searchParams.get('X-Amz-Signature'), 'URL is not actually signed');
  assert.equal(u.searchParams.get('X-Amz-Expires'), String(res.body.expires_in_sec));
  assert.ok(res.body.expires_in_sec > 0 && res.body.expires_in_sec <= 300);
});

test('route: not-done and unknown jobs do not mint a URL', async () => {
  setJob({ id: JOB, status: 'separating' });
  let res = await route.GET({}, { params: { id: JOB } });
  assert.equal(res.status, 404);
  assert.equal(res.body.signed_url, undefined);
  setJob(null);
  res = await route.GET({}, { params: { id: JOB } });
  assert.equal(res.status, 404);
  assert.equal(res.body.signed_url, undefined);
});

test('end to end: worker golden -> fake R2 at the worker key -> real route -> real loader -> every segment arrives', async () => {
  installFakeR2();
  const out = await fetchPlayChords(JOB);
  assert.equal(out.status, 'ready', `loader got ${JSON.stringify(out)}`);
  const want = GOLDEN.payload.segments;
  assert.ok(want.length >= 3, 'golden must carry several segments');
  assert.equal(out.observations.length, want.length, 'segments dropped by the loader');
  want.forEach((s, i) => {
    assert.deepEqual(out.observations[i], {
      startSec: s.start_sec, endSec: s.end_sec, label: s.label, confidence: s.confidence,
    });
  });
  // The second fetch really went to the signed R2 URL, not somewhere invented.
  assert.equal(decodeURIComponent(fetched.at(-1).pathname).endsWith(GOLDEN.r2_key), true);
});

test('golden with zero segments loads as ready/[] (a legal result), not as unavailable', async () => {
  installFakeR2({ [GOLDEN.r2_key]: { ...GOLDEN.payload, segments: [] } });
  const out = await fetchPlayChords(JOB);
  assert.deepEqual(out, { status: 'ready', observations: [] });
});
