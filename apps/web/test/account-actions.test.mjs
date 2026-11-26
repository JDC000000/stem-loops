// Beta QA 2026-11-26: Sign out (S5) and Send feedback (S4 / G5).
//
//   1. POST /api/auth/signout — same-origin only (CSRF), signs out with scope 'local', expires
//      every Supabase auth cookie (plain, chunked, code verifier) even when Supabase fails, leaves
//      other cookies alone, and answers 303 → / (relative). Loaded through the repo's data-URL
//      transpile with the REAL same-origin guard (test/helpers/same-origin.mjs).
//   2. AccountActions — rendered with the real component: a mailto with the beta subject, and a
//      POST form to the route. Its row wraps and every control is >= 44px (phone: no overflow).
//   3. Placement — /account renders it (signed-in only: the page redirects signed-out visitors),
//      the top bar is unchanged (A4: still Play · Songs · Account on a phone, no Sign out or
//      feedback item, signed in or out), and /help carries the feedback link (rendered).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE, sameOriginHeaders } from './helpers/same-origin.mjs';
import { compile, navigationStub, authStub, toMarkup } from './helpers/render-chrome.mjs';
import { renderPage } from './helpers/render-landing-page.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_SRC = join(WEB, 'src/app/api/auth/signout/route.ts');
const FEEDBACK = 'mailto:joncartwright00@gmail.com?subject=stem-loops%20beta%20feedback';

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// ── 1. The route ─────────────────────────────────────────────────────────────

const NEXT_SERVER = dataUrl(`
  export class NextResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = new Map(Object.entries(init.headers ?? {}));
    }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }
`);
const SENTRY = dataUrl(`
  export function captureException(err, ctx) {
    globalThis.__so.sentry.push({ message: err?.message ?? String(err), tags: ctx?.tags });
  }
`);
const HEADERS = dataUrl(`
  export function cookies() {
    const jar = globalThis.__so.jar;
    return {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      delete: (name) => { globalThis.__so.deleted.push(name); jar.delete(name); },
    };
  }
`);
/** mode: 'ok' | 'error' (signOut returns an error) | 'throws' (createServerClient throws). */
const SUPABASE = (mode) =>
  dataUrl(`
  export async function createServerClient() {
    if (${JSON.stringify(mode)} === 'throws') throw new Error('supabase unreachable');
    return { auth: { signOut: async (opts) => {
      globalThis.__so.signOut.push(opts);
      return ${JSON.stringify(mode)} === 'error' ? { error: { message: 'revoke failed' } } : { error: null };
    } } };
  }
`);

const SESSION_COOKIES = ['sb-abcd-auth-token', 'sb-abcd-auth-token.0', 'sb-abcd-auth-token.1', 'sb-abcd-auth-token-code-verifier'];
const OTHER_COOKIES = ['sl-history', 'sb-abcd-something-else', 'theme'];

async function callRoute({ mode = 'ok', headers = sameOriginHeaders() } = {}) {
  const js = toJs(readFileSync(ROUTE_SRC, 'utf8'))
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${NEXT_SERVER}'`)
    .replace(/from ['"]next\/headers['"]/g, `from '${HEADERS}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${SENTRY}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${SUPABASE(mode)}'`);
  assert.doesNotMatch(js, /from ['"](?:@\/|next\/|@sentry|@supabase)/, 'an import was left unstubbed');
  globalThis.__so = {
    jar: new Map([...SESSION_COOKIES, ...OTHER_COOKIES].map((n) => [n, 'v'])),
    deleted: [], signOut: [], sentry: [],
  };
  const mod = await import(dataUrl(js) + '#' + Math.random());
  assert.equal(mod.GET, undefined, 'sign-out must not answer GET (a link or <img> could trigger it)');
  const res = await mod.POST({ headers });
  return { mod, res, so: globalThis.__so };
}

test('signout: same-origin POST signs out locally, clears every auth cookie, 303 → /', async () => {
  const { mod, res, so } = await callRoute();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(so.signOut, [{ scope: 'local' }]);
  assert.deepEqual([...so.deleted].sort(), [...SESSION_COOKIES].sort());
  assert.deepEqual([...so.jar.keys()].sort(), [...OTHER_COOKIES].sort(), 'a non-auth cookie was touched');
  assert.equal(mod.dynamic, 'force-dynamic');
  assert.equal(mod.runtime, 'nodejs');
});

test('signout: the session cookie is cleared even when Supabase errors or is unreachable', async () => {
  for (const mode of ['error', 'throws']) {
    const { res, so } = await callRoute({ mode });
    assert.equal(res.status, 303, mode);
    assert.deepEqual([...so.deleted].sort(), [...SESSION_COOKIES].sort(), mode);
    assert.equal(so.sentry.length, 1, `${mode}: the failure is reported`);
    assert.equal(so.sentry[0].tags.route, 'api/auth/signout');
  }
});

test('signout: CSRF — cross-origin, null, missing Origin or Host are refused and nothing is cleared', async () => {
  const cases = [
    { origin: 'https://evil.example', host: 'stem-loops.com' },
    { origin: 'null', host: 'stem-loops.com' },
    { host: 'stem-loops.com' },
    { origin: 'https://stem-loops.com' },
    { origin: 'not a url', host: 'stem-loops.com' },
  ];
  for (const h of cases) {
    const { res, so } = await callRoute({ headers: new Map(Object.entries(h)) });
    assert.equal(res.status, 403, JSON.stringify(h));
    assert.equal(res.body.error_code, 'BAD_ORIGIN');
    assert.deepEqual(so.signOut, [], `${JSON.stringify(h)}: signOut ran`);
    assert.deepEqual(so.deleted, [], `${JSON.stringify(h)}: a cookie was cleared`);
  }
});

// ── 2. The component ─────────────────────────────────────────────────────────

async function renderActions() {
  const [url] = compile(['components/AccountActions.tsx']);
  const mod = await import(`${url}?${Math.random()}`);
  return { mod, html: await toMarkup(React.createElement(mod.default)) };
}

test('AccountActions: Send feedback is a mailto with the beta subject; Sign out POSTs to the route', async () => {
  const { html } = await renderActions();
  const a = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1].replace(/&amp;/g, '&'), m[2]]);
  assert.deepEqual(a, [[FEEDBACK, 'Send feedback']]);
  const form = html.match(/<form\b[^>]*>/)?.[0] ?? '';
  assert.match(form, /method="post"/);
  assert.match(form, /action="\/api\/auth\/signout"/);
  assert.match(html, /<button type="submit"[^>]*>Sign out<\/button>/);
});

test('AccountActions (phone): the row wraps and every control is a >= 44px target', async () => {
  const { html } = await renderActions();
  const sectionStyle = html.match(/<section\b[^>]*data-testid="account-actions"[^>]*>/)?.[0] ?? html.match(/<section\b[^>]*>/)[0];
  assert.match(sectionStyle, /display:flex/);
  assert.match(sectionStyle, /flex-wrap:wrap/, 'without wrap the two controls can overflow a 320px screen');
  const link = html.match(/<a\b[^>]*>/)[0];
  const button = html.match(/<button\b[^>]*>/)[0];
  for (const [name, el] of [['link', link], ['button', button]]) {
    assert.match(el, /min-height:var\(--h-control\)/, `${name} height`);
    assert.match(el, /min-width:var\(--h-control\)/, `${name} width`);
    assert.doesNotMatch(el, /white-space:nowrap|width:100%/, `${name} cannot shrink or forces a full row`);
  }
  const tokens = readFileSync(join(WEB, 'src/styles/design-tokens.css'), 'utf8');
  assert.match(tokens, /--h-control:\s*44px/);
});

test('AccountActions: submitting clears this browser\'s pending link and never cancels the submit', async () => {
  const { mod } = await renderActions();
  const removed = [];
  const prev = globalThis.window;
  globalThis.window = { localStorage: { removeItem: (k) => removed.push(k), getItem: () => null, setItem() {}, key: () => null, length: 0 } };
  try {
    assert.equal(mod.forgetLocalUserState(), undefined, 'a return value could read as preventDefault');
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
  assert.ok(removed.includes('sl.pendingLink'), `pending link not cleared: ${removed.join(',')}`);
});

// ── 3. Placement ─────────────────────────────────────────────────────────────

test('/account renders AccountActions, and only for a signed-in user (the page redirects first)', () => {
  const src = readFileSync(join(WEB, 'src/app/account/page.tsx'), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}|\/\/[^\n]*/g, '');
  assert.match(src, /^import AccountActions from '@\/components\/AccountActions';$/m);
  const redirectAt = src.indexOf("if (!user) redirect('/login?return_to=/account')");
  const renderAt = src.indexOf('<AccountActions />');
  assert.ok(redirectAt > 0 && renderAt > redirectAt, 'AccountActions must render after the signed-in check');
});

test('the top bar is unchanged: no Sign out or feedback item, signed in or out (A4 phone bar holds)', async () => {
  for (const user of [null, { user_id: 'u', email: 'a@b.c' }]) {
    const [url] = compile(['components/chrome/SignedInChrome.tsx'], {
      'next/navigation': navigationStub('/account'),
      '@/lib/auth/supabase': authStub(user),
    });
    const mod = await import(`${url}?${Math.random()}`);
    const html = await toMarkup(await mod.default());
    assert.doesNotMatch(html, /Sign out|Send feedback|mailto:|\/api\/auth\/signout/);
  }
});

test('/help carries the Send feedback mailto (rendered)', async () => {
  const { html } = await renderPage('app/(landing)/help/page.tsx');
  const hrefs = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>Send feedback<\/a>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.deepEqual(hrefs, [FEEDBACK]);
  assert.match(html, /<h2>Feedback<\/h2>/);
});
