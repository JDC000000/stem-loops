// Same-origin (CSRF) guard on state-changing API routes — W1 overnight QA P2,
// 2026-11-12: only DELETE /api/users/me checked Origin. With a valid session
// cookie and `Origin: https://evil.example`, W1 got 201 from POST /api/jobs
// (also with Content-Type: text/plain, a CORS simple request that never
// preflights), 200 from trial/consume, claim-jobs and /api/jobs/:id/loops, and
// reset-password-confirm reached its password check.
//
// Each route is transpiled in memory and EVERY non-builtin import except the
// guard itself is replaced by a tripwire stub that records it was reached.
// So "403 and nothing touched" proves the guard runs first, before auth, the
// body, the DB, quota, trial or credits; "tripwire touched" with a same-origin
// request proves the guard lets real browser requests through. The routes'
// own contract tests (jobs-*, claim-jobs, trial, loops-on-demand,
// reset-password, account-delete) cover the same-origin happy paths end to end.
//
// /api/billing/** is deliberately out of scope (billing code, separate note),
// and /api/billing/webhook must never be guarded: Stripe sends no Origin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(WEB, 'src/lib/same-origin.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const nextStub = dataUrl(`
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = new Map(Object.entries(init.headers ?? {})); }
    static json(body, init = {}) { return { status: init.status ?? 200, body, headers: new Map(Object.entries(init.headers ?? {})) }; }
  }
  export class NextRequest {}
`);

// Every export of a tripwire module records `<module>:<name>` on first touch
// and throws, so a route that gets past the guard stops at its first dependency.
function tripwire(spec, names) {
  const body = names
    .map((n) => {
      const fn = `function ${n === 'default' ? '__d' : n}() { (globalThis.__so ??= []).push(${JSON.stringify(spec + ':' + n)}); throw new Error('tripwire ${spec}:${n}'); }`;
      return n === 'default' ? `${fn}\nexport default __d;` : `export ${fn}`;
    })
    .join('\n');
  return dataUrl(body);
}

const SENTRY_NAMES = ['captureException', 'captureMessage', 'withScope', 'setTag', 'setContext', 'addBreadcrumb'];

async function loadRoute(rel) {
  let js = toJs(readFileSync(join(WEB, 'src/app/api', rel), 'utf8'));
  js = js.replace(/import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"];?/g, (all, clause, spec) => {
    if (spec === 'crypto' || spec.startsWith('node:')) return all;
    if (spec === 'next/server') return `import ${clause} from '${nextStub}';`;
    if (spec === '@/lib/same-origin') return `import ${clause} from '${dataUrl(toJs(readFileSync(HELPER, 'utf8')))}';`;
    let names;
    if (/^\*\s+as\s+/.test(clause)) names = SENTRY_NAMES;
    else if (/^\{/.test(clause)) {
      names = clause
        .replace(/[{}]/g, '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
    } else names = ['default'];
    return `import ${clause} from '${tripwire(spec, names)}';`;
  });
  return await import(dataUrl(js) + '#' + Math.random());
}

const HOST = 'stem-loops.com';
const SAME = { origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' };
const req = (headers, body = {}) => ({
  headers: new Headers(headers),
  json: async () => body,
  text: async () => JSON.stringify(body),
  nextUrl: new URL(`https://${HOST}/api/x`),
  url: `https://${HOST}/api/x`,
});

const JOB_ID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const ROUTES = [
  { name: 'POST /api/jobs', rel: 'jobs/route.ts', call: (m, r) => m.POST(r) },
  { name: 'POST /api/users/me/trial/consume', rel: 'users/me/trial/consume/route.ts', call: (m, r) => m.POST(r) },
  { name: 'POST /api/users/me/claim-jobs', rel: 'users/me/claim-jobs/route.ts', call: (m, r) => m.POST(r) },
  { name: 'POST /api/jobs/:id/loops', rel: 'jobs/[id]/loops/route.ts', call: (m, r) => m.POST(r, { params: { id: JOB_ID } }) },
  { name: 'POST /api/auth/reset-password-confirm', rel: 'auth/reset-password-confirm/route.ts', call: (m, r) => m.POST(r) },
  { name: 'DELETE /api/users/me', rel: 'users/me/route.ts', call: (m, r) => m.DELETE(r) },
];

const REFUSED = [
  ['foreign Origin', { origin: 'https://evil.example', host: HOST }],
  ['foreign Origin, text/plain (CORS simple request)', { origin: 'https://evil.example', host: HOST, 'content-type': 'text/plain' }],
  ['look-alike Origin', { origin: `https://${HOST}.evil.example`, host: HOST }],
  ['Origin: null', { origin: 'null', host: HOST }],
  ['missing Origin', { host: HOST }],
  ['malformed Origin', { origin: 'not a url', host: HOST }],
];

const codeOf = (res) => res?.body?.code ?? res?.body?.error_code;

for (const r of ROUTES) {
  for (const [label, headers] of REFUSED) {
    test(`${r.name} — ${label} → 403 BAD_ORIGIN, nothing behind the guard touched`, async () => {
      globalThis.__so = [];
      const mod = await loadRoute(r.rel);
      let res;
      try {
        res = await r.call(mod, req(headers));
      } catch (e) {
        res = { status: 'threw', body: String(e) };
      }
      assert.equal(res.status, 403, `got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(codeOf(res), 'BAD_ORIGIN');
      assert.deepEqual(globalThis.__so, [], 'the guard must run before auth, body, DB, quota, trial or credits');
    });
  }

  test(`${r.name} — same-origin request passes the guard (default port on Host tolerated)`, async () => {
    for (const headers of [SAME, { ...SAME, host: `${HOST}:443` }]) {
      globalThis.__so = [];
      const mod = await loadRoute(r.rel);
      let res;
      try {
        res = await r.call(mod, req(headers));
      } catch {
        res = null; // a tripwire threw: the handler ran past the guard
      }
      assert.notEqual(codeOf(res), 'BAD_ORIGIN');
      assert.ok(globalThis.__so.length > 0, 'handler should reach its first dependency');
    }
  });
}

test('crossOriginRefusal — rule table', async () => {
  assert.ok(existsSync(HELPER), 'src/lib/same-origin.ts is missing');
  const { crossOriginRefusal } = await import(dataUrl(toJs(readFileSync(HELPER, 'utf8'))));
  const h = (o) => ({ headers: new Headers(o) });
  assert.equal(crossOriginRefusal(h({ origin: 'https://stem-loops.com', host: 'stem-loops.com' })), null);
  assert.equal(crossOriginRefusal(h({ origin: 'http://127.0.0.1:3101', host: '127.0.0.1:3101' })), null);
  assert.equal(crossOriginRefusal(h({ origin: 'https://stem-loops.com', host: 'Stem-Loops.com:443' })), null);
  assert.equal(crossOriginRefusal(h({ origin: 'http://127.0.0.1:3101', host: '127.0.0.1:3102' })), 'Cross-origin request refused.');
  assert.equal(crossOriginRefusal(h({ origin: 'http://stem-loops.com', host: 'stem-loops.com' })), null, 'scheme is not compared, same as users/me');
  assert.equal(crossOriginRefusal(h({ host: 'stem-loops.com' })), 'Cross-origin or non-browser request refused.');
  assert.equal(crossOriginRefusal(h({ origin: 'https://stem-loops.com' })), 'Cross-origin or non-browser request refused.');
  assert.equal(crossOriginRefusal(h({ origin: '::', host: 'stem-loops.com' })), 'Malformed Origin header.');
  assert.equal(crossOriginRefusal(undefined), 'Cross-origin or non-browser request refused.');
  assert.equal(crossOriginRefusal({}), 'Cross-origin or non-browser request refused.');
});

test('billing routes are NOT guarded by this change (webhook must accept Stripe, which sends no Origin)', () => {
  for (const rel of ['billing/webhook/route.ts', 'billing/checkout/route.ts', 'billing/portal/route.ts']) {
    const p = join(WEB, 'src/app/api', rel);
    if (!existsSync(p)) continue;
    assert.doesNotMatch(readFileSync(p, 'utf8'), /same-origin/, `${rel} must not import the guard`);
  }
});
