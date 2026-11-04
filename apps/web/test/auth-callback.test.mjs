// /auth/callback contract test — V3 Phase 1a (auth completeness).
//
// Verifies the server-side PKCE exchange handler:
//   • Happy path: valid ?code → exchangeCodeForSession called → 307 to /account.
//   • Open-redirect defense: ?next=https://evil.com (and // variants) → /account, NOT evil.
//   • Missing code: redirect to /login?error=auth_callback_failed.
//   • Exchange error: redirect to /login?error=auth_callback_failed + Sentry capture.
//   • Method handlers: POST/PUT/PATCH/DELETE/OPTIONS return 405 Allow: GET.
//
// Mocking: transpile route.ts in-memory, stub @supabase/ssr, @/lib/auth/supabase,
// @/lib/auth/return-to (real), @sentry/nextjs, next/server. No real network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/auth/callback/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Real sanitizeReturnTo — transpile it so the route's whitelist logic runs
// for real. Any deviation (e.g. forgotten import) will surface here.
const returnToUrl = dataUrl(
  toJs(readFileSync(join(WEB, 'src/lib/auth/return-to.ts'), 'utf8')),
);

// Supabase stub whose exchangeCodeForSession can be scripted per-test.
function supabaseStub({ exchangeResult = { error: null }, throws = false } = {}) {
  return dataUrl(`
    globalThis.__exchangeCalls = [];
    export async function createServerClient() {
      return {
        auth: {
          exchangeCodeForSession: async (code) => {
            globalThis.__exchangeCalls.push(code);
            if (${JSON.stringify(throws)}) throw new Error('supabase down');
            return ${JSON.stringify(exchangeResult)};
          },
        },
      };
    }
    export async function getUser() { return null; }
  `);
}

function sentryStub() {
  return dataUrl(`
    globalThis.__sentryCaptures = [];
    export function captureException(err, ctx) {
      globalThis.__sentryCaptures.push({
        name: err?.name,
        message: err?.message ?? String(err),
        tags: ctx?.tags,
      });
    }
  `);
}

// Minimal NextResponse / NextRequest shims. The route uses:
//   • NextResponse.redirect(URL)
//   • new NextResponse(null, { status, headers })
//   • request.nextUrl.{origin, searchParams}
function nextStub() {
  return dataUrl(`
    export class NextResponse {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.headers = new Map(Object.entries(init.headers ?? {}));
      }
      static redirect(url) {
        const res = new NextResponse(null, { status: 307 });
        res.headers.set('location', String(url));
        return res;
      }
      static json(body, init = {}) {
        return new NextResponse(body, init);
      }
    }
  `);
}

async function loadRoute(opts = {}) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabaseStub(opts)}'`)
    .replace(/from ['"]@\/lib\/auth\/return-to['"]/g, `from '${returnToUrl}'`);
  globalThis.__exchangeCalls = [];
  globalThis.__sentryCaptures = [];
  return await import(dataUrl(js) + '#' + Math.random());
}

// Build a minimal NextRequest-shaped object. The route only reads
// request.nextUrl, so this is enough.
function makeReq(fullUrl) {
  const u = new URL(fullUrl);
  return { nextUrl: u };
}

test('GET /auth/callback — happy path: valid code → exchange → redirect to /account', async () => {
  const mod = await loadRoute({ exchangeResult: { error: null } });
  const res = await mod.GET(makeReq('https://stem-loops.com/auth/callback?code=abc123'));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'https://stem-loops.com/account');
  assert.deepEqual(globalThis.__exchangeCalls, ['abc123']);
  assert.equal(globalThis.__sentryCaptures.length, 0);
});

test('GET /auth/callback — honours a valid same-origin ?next', async () => {
  const mod = await loadRoute({ exchangeResult: { error: null } });
  const res = await mod.GET(
    makeReq(
      'https://stem-loops.com/auth/callback?code=abc&next=' +
        encodeURIComponent('/account/reset-password'),
    ),
  );
  assert.equal(res.status, 307);
  assert.equal(
    res.headers.get('location'),
    'https://stem-loops.com/account/reset-password',
  );
});

test('GET /auth/callback — open-redirect defense: external ?next → /account', async () => {
  const mod = await loadRoute({ exchangeResult: { error: null } });
  for (const evil of [
    'https://evil.com',
    'http://evil.com',
    '//evil.com',
    '/\\evil.com',
    'evil.com',
    'javascript:alert(1)',
  ]) {
    const res = await mod.GET(
      makeReq(
        'https://stem-loops.com/auth/callback?code=abc&next=' + encodeURIComponent(evil),
      ),
    );
    assert.equal(res.status, 307, `evil=${evil}`);
    const loc = res.headers.get('location');
    assert.equal(loc, 'https://stem-loops.com/account', `evil=${evil}`);
    assert.ok(!loc.includes('evil.com'), `location leaked evil host: ${loc}`);
  }
});

test('GET /auth/callback — missing ?code → /login?error=auth_callback_failed', async () => {
  const mod = await loadRoute({ exchangeResult: { error: null } });
  const res = await mod.GET(makeReq('https://stem-loops.com/auth/callback'));
  assert.equal(res.status, 307);
  assert.equal(
    res.headers.get('location'),
    'https://stem-loops.com/login?error=auth_callback_failed',
  );
  // Must not call exchangeCodeForSession with no code.
  assert.equal(globalThis.__exchangeCalls.length, 0);
});

test('GET /auth/callback — exchange returns error → /login + Sentry capture', async () => {
  const mod = await loadRoute({
    exchangeResult: { error: { name: 'AuthApiError', message: 'code expired' } },
  });
  const res = await mod.GET(makeReq('https://stem-loops.com/auth/callback?code=stale'));
  assert.equal(res.status, 307);
  assert.equal(
    res.headers.get('location'),
    'https://stem-loops.com/login?error=auth_callback_failed',
  );
  assert.deepEqual(globalThis.__exchangeCalls, ['stale']);
  assert.equal(globalThis.__sentryCaptures.length, 1);
  assert.equal(globalThis.__sentryCaptures[0].tags?.route, 'auth/callback');
});

test('GET /auth/callback — exchange throws → /login + Sentry capture', async () => {
  const mod = await loadRoute({ throws: true });
  const res = await mod.GET(makeReq('https://stem-loops.com/auth/callback?code=boom'));
  assert.equal(res.status, 307);
  assert.equal(
    res.headers.get('location'),
    'https://stem-loops.com/login?error=auth_callback_failed',
  );
  assert.equal(globalThis.__sentryCaptures.length, 1);
  assert.equal(globalThis.__sentryCaptures[0].tags?.route, 'auth/callback');
});

test('/auth/callback — non-GET methods return 405 Allow: GET', async () => {
  const mod = await loadRoute();
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const handler = mod[verb];
    assert.equal(typeof handler, 'function', `missing export: ${verb}`);
    const res = await handler();
    assert.equal(res.status, 405, verb);
    assert.equal(res.headers.get('Allow'), 'GET', verb);
  }
});
