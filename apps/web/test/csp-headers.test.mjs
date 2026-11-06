// CSP + security-headers contract test — audit §3 M4.
//
// Exercises the exported `buildCsp` / `cspConnectSrcHosts` from
// `apps/web/src/middleware.ts` and the per-response stamping by driving
// `middleware(req)` with a Supabase stub. `next/server` gets a minimal
// in-memory implementation so the request/response cookie plumbing works
// without a running Next.js server.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/middleware.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

function nextServerStub() {
  return dataUrl(`
    class HeaderMap {
      constructor() { this.map = new Map(); }
      get(k) { return this.map.get(k.toLowerCase()) ?? null; }
      set(k, v) { this.map.set(k.toLowerCase(), v); }
      has(k) { return this.map.has(k.toLowerCase()); }
      entries() { return this.map.entries(); }
    }
    class CookieJar {
      constructor() { this.store = new Map(); }
      get(n) { const v = this.store.get(n); return v ? { name: n, value: v } : undefined; }
      getAll() { return [...this.store.entries()].map(([name, value]) => ({ name, value })); }
      set(name, value) { this.store.set(name, value); }
    }
    class NextResponseImpl {
      constructor() {
        this.headers = new HeaderMap();
        this.cookies = new CookieJar();
      }
      static next() { return new NextResponseImpl(); }
    }
    class NextRequestImpl {
      constructor() {
        this.cookies = new CookieJar();
        this.headers = new HeaderMap();
      }
    }
    export const NextResponse = NextResponseImpl;
    export const NextRequest = NextRequestImpl;
  `);
}

function ssrStub({ shouldThrow = false } = {}) {
  return dataUrl(`
    export function createServerClient(_url, _key, { cookies }) {
      // Call setAll to simulate a refresh touching the response cookie jar.
      cookies.setAll?.([{ name: 'sb-access-token', value: 'refreshed', options: {} }]);
      return {
        auth: {
          getUser: async () => {
            if (${shouldThrow}) throw new Error('supabase down');
            return { data: { user: null }, error: null };
          },
        },
      };
    }
  `);
}

async function loadMiddleware({ ssrThrows = false } = {}) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]next\/server['"]/g, `from '${nextServerStub()}'`)
    .replace(/from ['"]@supabase\/ssr['"]/g, `from '${ssrStub({ shouldThrow: ssrThrows })}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeReq() {
  const headers = new Map();
  const cookies = new Map();
  return {
    cookies: {
      get: (n) => (cookies.has(n) ? { name: n, value: cookies.get(n) } : undefined),
      getAll: () => [...cookies.entries()].map(([name, value]) => ({ name, value })),
      set: (name, value) => cookies.set(name, value),
    },
    headers: {
      get: (k) => headers.get(k.toLowerCase()) ?? null,
      set: (k, v) => headers.set(k.toLowerCase(), v),
    },
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  delete process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL;
  delete process.env.R2_PUBLIC_HOST;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_DEMO_ASSET_BASE;
});

test('buildCsp includes the required default-src and frame-ancestors tokens', async () => {
  const mod = await loadMiddleware();
  const csp = mod.buildCsp();
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /worker-src blob:/);
  assert.match(csp, /'wasm-unsafe-eval'/);
  assert.match(csp, /connect-src .*https:\/\/\*\.supabase\.co/);
  assert.match(csp, /connect-src .*https:\/\/\*\.r2\.cloudflarestorage\.com/);
  assert.match(csp, /connect-src .*https:\/\/sentry\.io/);
});

// Extract one directive's source list from a CSP string.
const directive = (csp, name) =>
  csp.split('; ').find((d) => d.startsWith(name + ' '))?.split(' ').slice(1) ?? null;

test('buildCsp permits hCaptcha on script-src, frame-src, style-src and connect-src', async () => {
  const csp = (await loadMiddleware()).buildCsp();
  for (const name of ['script-src', 'frame-src', 'style-src', 'connect-src']) {
    const srcs = directive(csp, name);
    assert.ok(srcs, `${name} directive must exist`);
    assert.ok(srcs.includes('https://hcaptcha.com'), `${name} must allow https://hcaptcha.com`);
    assert.ok(srcs.includes('https://*.hcaptcha.com'), `${name} must allow https://*.hcaptcha.com`);
  }
});

test('hCaptcha is scoped: frame-src is hcaptcha-only; no broad wildcards; locked directives unchanged', async () => {
  const csp = (await loadMiddleware()).buildCsp();
  assert.deepEqual(directive(csp, 'frame-src'), ['https://hcaptcha.com', 'https://*.hcaptcha.com']);
  assert.deepEqual(directive(csp, 'default-src'), ["'self'"]);
  assert.deepEqual(directive(csp, 'frame-ancestors'), ["'none'"]);
  assert.deepEqual(directive(csp, 'object-src'), ["'none'"]);
  assert.deepEqual(directive(csp, 'base-uri'), ["'self'"]);
  assert.deepEqual(directive(csp, 'form-action'), ["'self'"]);
  // Existing script-src/style-src tokens are retained, not replaced.
  assert.ok(directive(csp, 'script-src').includes("'wasm-unsafe-eval'"));
  assert.ok(directive(csp, 'script-src').includes("'self'"));
  assert.ok(directive(csp, 'style-src').includes("'self'"));
  // No bare wildcard or scheme-only source in the directives we touched.
  for (const name of ['script-src', 'frame-src', 'style-src', 'connect-src']) {
    for (const src of directive(csp, name)) {
      assert.ok(!['*', 'https:', 'http:'].includes(src), `${name} must not contain ${src}`);
    }
  }
});

test('buildCsp picks up NEXT_PUBLIC_CHORDNET_MODEL_URL host', async () => {
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL = 'https://models.example.com/chordnet-v1.onnx';
  const mod = await loadMiddleware();
  const csp = mod.buildCsp();
  assert.match(csp, /https:\/\/models\.example\.com/);
});

test('buildCsp picks up R2_PUBLIC_HOST', async () => {
  process.env.R2_PUBLIC_HOST = 'pub-abcdef.r2.dev';
  const mod = await loadMiddleware();
  const csp = mod.buildCsp();
  assert.match(csp, /https:\/\/pub-abcdef\.r2\.dev/);
  // Also in media-src.
  assert.match(csp, /media-src .*https:\/\/pub-abcdef\.r2\.dev/);
});

test('buildCsp ignores a malformed NEXT_PUBLIC_CHORDNET_MODEL_URL', async () => {
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL = 'not a url';
  const mod = await loadMiddleware();
  // No throw; the CSP is still constructed.
  assert.ok(typeof mod.buildCsp() === 'string');
});

test('middleware stamps CSP + security headers on the response', async () => {
  const mod = await loadMiddleware();
  const res = await mod.middleware(makeReq());
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(res.headers.get('permissions-policy') ?? '', /interest-cohort=\(\)/);
});

test('middleware stamps security headers even when Supabase env is missing', async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const mod = await loadMiddleware();
  const res = await mod.middleware(makeReq());
  // CSP must still be present — a header-naked fallback is worse than a
  // best-effort session refresh being skipped.
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('middleware stamps security headers even when Supabase getUser throws', async () => {
  const mod = await loadMiddleware({ ssrThrows: true });
  const res = await mod.middleware(makeReq());
  assert.ok(res.headers.get('content-security-policy'));
});

// ── Landing demo origin ─────────────────────────────────────────────────────
// The landing demo fetch()es JSON + audio from DEMO_ASSET_BASE (connect-src), and
// media-src is restricted too. When the policy omitted this host every visitor saw
// "The sample didn't load". Derive the expectation from public-config.ts itself so a
// changed default can't drift from the policy.
const publicConfigSrc = readFileSync(join(WEB, 'src/lib/public-config.ts'), 'utf8');
const defaultDemoBase = publicConfigSrc.match(/DEFAULT_DEMO_ASSET_BASE = '([^']+)'/)?.[1];

test('public-config default demo base is parseable (guard for the tests below)', () => {
  assert.ok(defaultDemoBase, 'DEFAULT_DEMO_ASSET_BASE not found in public-config.ts');
  assert.equal(new URL(defaultDemoBase).protocol, 'https:');
});

test('default demo origin is permitted in connect-src and media-src (what the demo uses)', async () => {
  const csp = (await loadMiddleware()).buildCsp();
  const origin = new URL(defaultDemoBase).origin;
  for (const name of ['connect-src', 'media-src']) {
    assert.ok(directive(csp, name).includes(origin), `${name} must allow ${origin}`);
  }
  // img-src is already `'self' data: https:` (covers the demo host); pin it so narrowing it later
  // without adding the host fails here.
  const img = directive(csp, 'img-src');
  assert.ok(img.includes('https:') || img.includes(origin), 'img-src must cover the demo origin');
});

test('NEXT_PUBLIC_DEMO_ASSET_BASE overrides the demo origin; blank turns it off', async () => {
  process.env.NEXT_PUBLIC_DEMO_ASSET_BASE = 'https://demo-assets.example.org/some/path/';
  let csp = (await loadMiddleware()).buildCsp();
  assert.ok(directive(csp, 'connect-src').includes('https://demo-assets.example.org'));
  assert.ok(directive(csp, 'media-src').includes('https://demo-assets.example.org'));
  assert.ok(!csp.includes(new URL(defaultDemoBase).host), 'default host must not linger when overridden');
  process.env.NEXT_PUBLIC_DEMO_ASSET_BASE = ' ';
  csp = (await loadMiddleware()).buildCsp();
  assert.ok(!csp.includes(new URL(defaultDemoBase).host));
});

// ── Sentry ingest host ──────────────────────────────────────────────────────
test('Sentry ingest host is derived from NEXT_PUBLIC_SENTRY_DSN (non-zero org id)', async () => {
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://abc123publickey@o4507654321098.ingest.de.sentry.io/4507654321099';
  const csp = (await loadMiddleware()).buildCsp();
  const connect = directive(csp, 'connect-src');
  assert.ok(connect.includes('https://o4507654321098.ingest.de.sentry.io'), 'policy must follow the DSN');
  assert.ok(!connect.some((s) => s.includes('abc123publickey')), 'DSN key must not leak into the policy');
  assert.ok(!connect.some((s) => /\/4507654321099/.test(s)), 'origin only, no path');
  assert.ok(!csp.includes('o0.ingest'), 'no placeholder org id');
});

test('Sentry: no wildcard, no placeholder, safe fallback when DSN unset or malformed', async () => {
  for (const dsn of [undefined, '', 'not a dsn', 'http://k@o1.ingest.sentry.io/1']) {
    if (dsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = dsn;
    const connect = directive((await loadMiddleware()).buildCsp(), 'connect-src');
    assert.ok(!connect.some((s) => /\*\.(ingest\.)?(us\.)?sentry\.io|\*\.sentry\.io/.test(s)), `wildcard for dsn=${dsn}`);
    assert.ok(!connect.some((s) => s.startsWith('https://o0.')), `placeholder for dsn=${dsn}`);
    assert.ok(connect.includes('https://sentry.io'), 'fallback kept');
    assert.ok(!connect.some((s) => /\.ingest\./.test(s)), `unusable dsn=${dsn} must add no ingest host`);
  }
});
