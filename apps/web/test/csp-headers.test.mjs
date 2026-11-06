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
