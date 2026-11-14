// POST /api/history/set-cookie signs only an array of job UUIDs (<= 50).
//
// W1 overnight QA (2026-11-12, P2): the route HMAC-signed ANY JSON array, so it
// was a signing oracle (`["anything-at-all",{"x":1},"<script>"]` came back as a
// valid sl-history cookie that GET /api/history then returned), and 20 x 100 KB
// ids produced a Set-Cookie header over 64 KB.
//
// The route is transpiled in memory with next/server and @/lib/retention
// stubbed; cookies.set calls are recorded on the response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/history/set-cookie/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const nextStub = dataUrl(`
  export class NextResponse {
    static json(body, init = {}) {
      const set = [];
      return { status: init.status ?? 200, body, set, cookies: { set: (...a) => set.push(a) } };
    }
  }
  export class NextRequest {}
`);
const retentionStub = dataUrl(`export const RETENTION_SEC = 86400;`);

async function loadRoute() {
  const js = toJs(readFileSync(SRC, 'utf8'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionStub}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

const post = async (body) => (await loadRoute()).POST({ json: async () => body });
const uuid = (n) => `3f2b8c1e-5a4d-4e6f-8a9b-${String(n).padStart(12, '0')}`;
const decode = (cookieVal) => {
  const [b64, sig] = cookieVal.split('.');
  const payload = Buffer.from(b64, 'base64').toString('utf8');
  return { ids: JSON.parse(payload), sig, payload };
};

test('a list of job UUIDs is signed (newest 20 kept, lowercased); signature verifies', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => uuid(i));
  ids[0] = ids[0].toUpperCase();
  const res = await post({ jobIds: ids });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.set.length, 1);
  const [name, val, opts] = res.set[0];
  assert.equal(name, 'sl-history');
  assert.equal(opts.httpOnly, true);
  const { ids: stored, sig, payload } = decode(val);
  assert.deepEqual(stored, ids.slice(0, 20).map((s) => s.toLowerCase()));
  assert.equal(sig, createHmac('sha256', process.env.HISTORY_COOKIE_KEY ?? 'dev').update(payload).digest('hex'));
});

test('an empty list is accepted (history cleared)', async () => {
  const res = await post({ jobIds: [] });
  assert.equal(res.status, 200);
  assert.deepEqual(decode(res.set[0][1]).ids, []);
});

test('exactly 50 UUIDs is accepted', async () => {
  const res = await post({ jobIds: Array.from({ length: 50 }, (_, i) => uuid(i)) });
  assert.equal(res.status, 200);
});

const REJECT = [
  ['W1 signing-oracle payload', { jobIds: ['anything-at-all', { x: 1 }, '<script>'] }],
  ['one non-UUID string among UUIDs', { jobIds: [uuid(1), 'not-a-uuid'] }],
  ['a UUID with extra characters', { jobIds: [uuid(1) + 'x'] }],
  ['a number', { jobIds: [1] }],
  ['a nested array', { jobIds: [[uuid(1)]] }],
  ['null entry', { jobIds: [null] }],
  ['51 UUIDs', { jobIds: Array.from({ length: 51 }, (_, i) => uuid(i)) }],
  ['20 x 100 KB strings (W1: Set-Cookie > 64 KB)', { jobIds: Array(20).fill('x'.repeat(100_000)) }],
  ['jobIds not an array', { jobIds: uuid(1) }],
  ['missing jobIds', {}],
  ['null body', null],
  ['array body', [uuid(1)]],
  ['string body', 'str'],
];

for (const [label, body] of REJECT) {
  test(`422 and no cookie: ${label}`, async () => {
    const res = await post(body);
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { ok: false });
    assert.equal(res.set.length, 0, 'nothing may be signed');
  });
}
