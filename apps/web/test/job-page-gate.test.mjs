// /jobs/[id] — the sign-in gate (Story 1.5).
//
// WHY THIS FILE EXISTS. Review mutated `src/app/jobs/[id]/page.tsx` by deleting
// the `redirect(...)` line outright — the product's entire front door — and ALL
// 939 tests plus `tsc --noEmit` stayed green. Zero tests referenced the page or
// `JobView`, and production has zero registered users, so nothing had ever
// exercised the gate in any environment. A launch blocker whose auth can be
// deleted silently is not gated; it is decorated.
//
// These tests EXECUTE the page rather than grepping it. Same mechanism as
// test/play-mixer.test.mjs: transpile into node_modules/.cache (so bare `react`
// resolves — a `data:` URL module cannot resolve bare specifiers, which is why
// the stub idiom in test/trial.test.mjs is not reusable for a module that
// returns JSX) and point the three runtime imports at stubs. No DB, no network,
// no Supabase.
//
// `redirect()` throws in real Next — that is how it aborts the render — so the
// stub throws too, and the assertions check both the throw and the URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_SRC = join(WEB, 'src/app/jobs/[id]/page.tsx');
const JOBVIEW_SRC = join(WEB, 'src/app/jobs/[id]/JobView.tsx');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'job-page-gate-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

/** Records every redirect target, and throws the way Next's own redirect does. */
const navMod = put(
  'next-navigation.mjs',
  `export function redirect(url) {
     globalThis.__redirects.push(url);
     const e = new Error('NEXT_REDIRECT');
     e.digest = 'NEXT_REDIRECT';
     throw e;
   }`,
);

const jobViewMod = put(
  'JobView.mjs',
  `import { createElement } from 'react';
   export default function JobView(props) {
     globalThis.__jobViewProps = props;
     return createElement('div', { 'data-testid': 'job-view', 'data-id': String(props.id) });
   }`,
);

let loadSeq = 0;

/** Load the real page module with its three runtime imports stubbed. */
async function loadPage(user) {
  globalThis.__redirects = [];
  globalThis.__getUserCalls = 0;
  globalThis.__jobViewProps = null;

  const authMod = put(
    `auth-${loadSeq}.mjs`,
    `export const getUser = async () => { globalThis.__getUserCalls++; return ${JSON.stringify(user)}; };`,
  );
  const js = toJs(readFileSync(PAGE_SRC, 'utf8'))
    .replace(/from ['"]next\/navigation['"]/g, `from '${navMod}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authMod}'`)
    .replace(/from ['"]\.\/JobView['"]/g, `from '${jobViewMod}'`);

  const name = `page-${loadSeq++}.mjs`;
  writeFileSync(join(dir, name), js);
  return import(pathToFileURL(join(dir, name)).href);
}

const SIGNED_IN = { user_id: 'u-1', email: 'jon@example.com', display_name: 'Jon' };

/** Source with comments and strings-in-comments removed, so prose cannot pass or fail a test. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ═══ the gate itself ═════════════════════════════════════════════════════════

test('a signed-OUT visitor is redirected and never reaches the job body', async () => {
  const mod = await loadPage(null);
  await assert.rejects(
    () => mod.default({ params: { id: 'abc-123' } }),
    (e) => e.digest === 'NEXT_REDIRECT',
    'the page rendered for a signed-out visitor instead of redirecting',
  );
  assert.equal(globalThis.__getUserCalls, 1, 'the session was never checked');
  assert.equal(globalThis.__redirects.length, 1);
  assert.equal(globalThis.__jobViewProps, null, 'the job body was constructed anyway');
});

test('the redirect goes to /login and carries this job as return_to', async () => {
  const mod = await loadPage(null);
  await mod.default({ params: { id: 'abc-123' } }).catch(() => {});
  const [url] = globalThis.__redirects;
  assert.ok(url.startsWith('/login?return_to='), `expected a /login redirect, got ${url}`);
  // Encoded, unlike the static precedents in /account and /trial, because this
  // is the first dynamic return_to in the app.
  assert.equal(url, '/login?return_to=%2Fjobs%2Fabc-123');
  assert.equal(new URL(url, 'https://x.test').searchParams.get('return_to'), '/jobs/abc-123');
});

test('a hostile job id cannot smuggle an open redirect through return_to', async () => {
  // The id reaches the URL, so it is encoded at the point of use. Paired with
  // sanitizeReturnTo (which rejects anything not starting with a single "/"),
  // neither "//evil.com" nor a scheme can survive the round trip.
  for (const hostile of ['//evil.com', '/\\evil.com', 'https://evil.com', '../../etc']) {
    const mod = await loadPage(null);
    await mod.default({ params: { id: hostile } }).catch(() => {});
    const [url] = globalThis.__redirects;
    const returnTo = new URL(url, 'https://x.test').searchParams.get('return_to');
    assert.ok(url.startsWith('/login?return_to='), `${hostile} escaped the login path: ${url}`);
    assert.ok(returnTo.startsWith('/jobs/'), `${hostile} escaped the /jobs/ prefix: ${returnTo}`);
    assert.ok(!/^https?:/i.test(returnTo), `${hostile} produced an absolute URL`);
  }
});

test('a signed-IN visitor is NOT redirected and gets the job body for this id', async () => {
  const mod = await loadPage(SIGNED_IN);
  const el = await mod.default({ params: { id: 'abc-123' } });
  assert.equal(globalThis.__redirects.length, 0, 'a signed-in user was redirected');
  assert.equal(globalThis.__getUserCalls, 1);
  assert.ok(el, 'the page rendered nothing for a signed-in user');
  assert.equal(el.props.id, 'abc-123', 'the job id did not reach the body');
});

// ═══ the gate cannot be defeated by configuration ════════════════════════════

test('the page is force-dynamic, so the gate is not cached away', async () => {
  // A statically rendered page would run `getUser()` once at build time and
  // serve that answer to everyone. /account and /trial both set this for the
  // same reason.
  const mod = await loadPage(SIGNED_IN);
  assert.equal(mod.dynamic, 'force-dynamic');
});

test('the job page is not indexable', async () => {
  const mod = await loadPage(SIGNED_IN);
  assert.equal(mod.metadata?.robots?.index, false);
});

test('the gate lives in the Server Component, not the client body', async () => {
  // JobView is a 'use client' module: anything it did with `getUser` would run
  // in the browser and be bypassable. The gate must stay on the server side of
  // the boundary, so the client body must not reach for auth at all.
  const jobView = codeOnly(readFileSync(JOBVIEW_SRC, 'utf8'));
  assert.match(jobView, /'use client';/, 'JobView stopped being a client component');
  assert.doesNotMatch(jobView, /lib\/auth/, 'the client body imported the auth module');
  assert.doesNotMatch(jobView, /getUser\s*\(/, 'the client body called getUser');
  const page = codeOnly(readFileSync(PAGE_SRC, 'utf8'));
  assert.doesNotMatch(page, /'use client'/, 'the gated page became a client component');
});
