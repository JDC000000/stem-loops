// Beta QA 2026-11-26: Sign out (S5) and Send feedback (S4 / G5).
//
//   1. POST /api/auth/signout — same-origin only (CSRF), signs out with scope 'local', retries a
//      network-failed revoke with the captured token (#485), expires every Supabase auth cookie
//      (plain, chunked, code verifier) and the sl-history mirror (#486) even when Supabase fails,
//      leaves other cookies alone, and answers 303 → / (relative). Loaded through the repo's data-URL
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
    globalThis.__so.sentry.push({ message: err?.message ?? String(err), tags: ctx?.tags, extra: ctx?.extra });
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
/** mode: 'ok' | 'error' (signOut returns a retryable network error) | 'api-error' (signOut returns a
 *  non-retryable 400) | 'throws' (createServerClient throws). `admin` scripts what each retry's
 *  POST /logout returns, in order (null = revoked). `token` is what getSession yields (a FAKE
 *  placeholder string, never a real token). */
const SUPABASE = (mode) =>
  dataUrl(`
  const NET = { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' };
  const API = { name: 'AuthApiError', status: 400, message: 'bad request' };
  export async function createServerClient() {
    if (${JSON.stringify(mode)} === 'throws') throw new Error('supabase unreachable');
    const so = globalThis.__so;
    return { auth: {
      getSession: async () => {
        so.getSession += 1;
        return { data: { session: so.token ? { access_token: so.token } : null }, error: null };
      },
      signOut: async (opts) => {
        so.signOut.push(opts);
        const m = ${JSON.stringify(mode)};
        return { error: m === 'error' ? NET : m === 'api-error' ? API : null };
      },
      admin: { signOut: async (jwt, scope) => {
        so.admin.push([jwt, scope]);
        const next = so.adminResults.shift();
        if (next === 'throw') throw new TypeError('fetch failed');
        return { data: null, error: next === undefined ? NET : next };
      } },
    } };
  }
`);

const SESSION_COOKIES = ['sb-abcd-auth-token', 'sb-abcd-auth-token.0', 'sb-abcd-auth-token.1', 'sb-abcd-auth-token-code-verifier'];
// #486: the anonymous history mirror is per-browser, not per-user, so sign-out clears it too.
const CLEARED = [...SESSION_COOKIES, 'sl-history'];
const OTHER_COOKIES = ['sb-abcd-something-else', 'theme', 'sl-history-x'];
const NET = { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' };
const FAKE_TOKEN = 'fake-access-token-for-tests';

async function callRoute({ mode = 'ok', headers = sameOriginHeaders(), adminResults = [], token = FAKE_TOKEN } = {}) {
  const js = toJs(readFileSync(ROUTE_SRC, 'utf8'))
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${NEXT_SERVER}'`)
    .replace(/from ['"]next\/headers['"]/g, `from '${HEADERS}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${SENTRY}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${SUPABASE(mode)}'`);
  assert.doesNotMatch(js, /from ['"](?:@\/|next\/|@sentry|@supabase)/, 'an import was left unstubbed');
  globalThis.__so = {
    jar: new Map([...CLEARED, ...OTHER_COOKIES].map((n) => [n, 'v'])),
    deleted: [], signOut: [], sentry: [], admin: [], adminResults: [...adminResults], token, getSession: 0,
    delays: [],
  };
  const mod = await import(dataUrl(js) + '#' + Math.random());
  assert.equal(mod.GET, undefined, 'sign-out must not answer GET (a link or <img> could trigger it)');
  // The retry backoff runs on setTimeout: record each delay and fire it at once.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { globalThis.__so.delays.push(ms); return realSetTimeout(fn, 0); };
  let res;
  try {
    res = await mod.POST({ headers });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return { mod, res, so: globalThis.__so };
}

test('signout: same-origin POST signs out locally, clears every auth cookie, 303 → /', async () => {
  const { mod, res, so } = await callRoute();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(so.signOut, [{ scope: 'local' }]);
  assert.deepEqual(so.admin, [], 'a revoke that worked is not retried');
  assert.deepEqual(so.sentry, []);
  assert.deepEqual([...so.deleted].sort(), [...CLEARED].sort());
  assert.deepEqual([...so.jar.keys()].sort(), [...OTHER_COOKIES].sort(), 'an unrelated cookie was touched');
  assert.equal(mod.dynamic, 'force-dynamic');
  assert.equal(mod.runtime, 'nodejs');
});

test('signout: the session and sl-history cookies are cleared even when Supabase errors or is unreachable', async () => {
  for (const mode of ['error', 'api-error', 'throws']) {
    const { res, so } = await callRoute({ mode });
    assert.equal(res.status, 303, mode);
    assert.deepEqual([...so.deleted].sort(), [...CLEARED].sort(), mode);
    assert.equal(so.sentry.length, 1, `${mode}: the failure is reported once`);
    assert.equal(so.sentry[0].tags.route, 'api/auth/signout');
    assert.equal(so.sentry[0].tags.revoke, 'failed', `${mode}: tagged so a lingering session can be found`);
  }
});

// #485: supabase-js drops the local session even when POST /logout fails, so a second
// auth.signOut() would find no token and "succeed" without revoking anything. The retry posts
// the access token captured before the first attempt to /logout directly.
test('signout #485: a network failure is retried with the captured token, scope local, with backoff', async () => {
  const { res, so } = await callRoute({ mode: 'error', adminResults: [NET, null] });
  assert.equal(res.status, 303);
  assert.equal(so.getSession, 1);
  assert.deepEqual(so.signOut, [{ scope: 'local' }]);
  assert.deepEqual(so.admin, [[FAKE_TOKEN, 'local'], [FAKE_TOKEN, 'local']]);
  assert.deepEqual(so.delays, [150, 450], 'bounded backoff');
  assert.deepEqual(so.sentry, [], 'a revoke that worked on retry is not an error');
  assert.deepEqual([...so.deleted].sort(), [...CLEARED].sort());
});

test('signout #485: a retry that throws (no HTTP status) is retried again', async () => {
  const { so } = await callRoute({ mode: 'error', adminResults: ['throw', null] });
  assert.equal(so.admin.length, 2);
  assert.deepEqual(so.sentry, [], 'the second retry revoked the session');
});

test('signout #485: retries stop after two; the lasting failure is reported once, without the token', async () => {
  const { res, so } = await callRoute({ mode: 'error', adminResults: [NET, 'throw'] });
  assert.equal(res.status, 303);
  assert.equal(so.admin.length, 2, 'exactly two retries');
  assert.equal(so.sentry.length, 1);
  assert.deepEqual(so.sentry[0].tags, { route: 'api/auth/signout', revoke: 'failed' });
  assert.doesNotMatch(JSON.stringify(so.sentry), new RegExp(FAKE_TOKEN), 'the token reached Sentry');
  assert.deepEqual([...so.deleted].sort(), [...CLEARED].sort());
});

test('signout #485: 401/403/404 on retry means the session is already gone (supabase-js semantics)', async () => {
  for (const status of [401, 403, 404]) {
    const { so } = await callRoute({ mode: 'error', adminResults: [{ name: 'AuthApiError', status, message: 'x' }] });
    assert.equal(so.admin.length, 1, `${status}: no further retry`);
    assert.deepEqual(so.sentry, [], `${status}: not reported`);
  }
});

test('signout #485: a non-retryable error, or no token to retry with, is not retried', async () => {
  const api = await callRoute({ mode: 'api-error' });
  assert.deepEqual(api.so.admin, [], 'a 400 is not retried');
  assert.equal(api.so.sentry.length, 1);
  const noToken = await callRoute({ mode: 'error', token: null });
  assert.deepEqual(noToken.so.admin, [], 'nothing to retry with');
  assert.equal(noToken.so.sentry.length, 1);
  const retry5xx = await callRoute({ mode: 'error', adminResults: [{ name: 'AuthApiError', status: 400, message: 'x' }] });
  assert.equal(retry5xx.so.admin.length, 1, 'a non-retryable answer on retry stops the loop');
  assert.equal(retry5xx.so.sentry.length, 1);
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

test('AccountActions: submitting clears this browser\'s buffered edits, pending link (audit §3 M3) and song history (#486), never cancelling the submit', async () => {
  const { mod } = await renderActions();
  // A real-shaped localStorage: two buffered-edit keys (the current per-user form and the legacy
  // single key, lib name in src/chord/edit-collector.ts), the pending link, and a bystander.
  const store = new Map([
    ['stem-loops-chord-edit-buffer', '[]'],
    ['stem-loops-chord-edit-buffer:u1', '[{"x":1}]'],
    ['sl.pendingLink', '{}'],
    ['stem-loops-history', '[{"id":"x","at":1}]'],
    ['sl.theme', 'dark'],
  ]);
  const localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const prev = globalThis.window;
  globalThis.window = { localStorage };
  try {
    assert.equal(mod.forgetLocalUserState(), undefined, 'a return value could read as preventDefault');
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
  assert.deepEqual([...store.keys()], ['sl.theme'], 'buffered edits, the pending link or the browser history (#486) survived sign-out');
});

test('AccountActions: the Sign out form runs forgetLocalUserState on submit (the M3 clear is wired)', async () => {
  const { mod } = await renderActions();
  // Walk the element the REAL component returns (no DOM needed) and find the one form.
  const forms = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!React.isValidElement(n)) return;
    if (n.type === 'form') forms.push(n);
    walk(n.props?.children);
  })(mod.default());
  assert.equal(forms.length, 1);
  assert.equal(forms[0].props.action, '/api/auth/signout');
  assert.equal(forms[0].props.onSubmit, mod.forgetLocalUserState, 'the sign-out form no longer clears local state');
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
