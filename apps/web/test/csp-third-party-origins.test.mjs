// CSP vs the origins the app really talks to (issue #141, item 1) - a PROPERTY test.
//
// csp-headers.test.mjs asserts which tokens appear in the CSP string. It cannot notice that the
// URL R2 actually signs lives on a host the CSP does not cover, which is how a CSP that blocks
// 100% of uploads/downloads would stay green. This file mints REAL presigned URLs with the real
// lib/r2.ts and asks, with a host-source matcher implementing CSP3 matching, whether the real
// middleware CSP lets the browser use them. It does not edit or duplicate csp-headers.test.mjs
// (hCaptcha token presence, demo origin and DSN-derived Sentry are covered there).
//
//   * presigned GET (download, play.chords.json)  -> fetch/audio => connect-src AND media-src
//   * presigned PUT (browser uploads the source)  -> fetch/XHR   => connect-src
//   * hCaptcha's real script/iframe/XHR/style URLs -> script-src / frame-src / connect-src / style-src
// Stripe is intentionally not asserted: checkout is a top-level navigation to the Stripe-hosted
// page (BillingButton sets window.location.href) and no Stripe script is loaded, so CSP does not
// govern it.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';

const toJs = (file) =>
  ts.transpileModule(readFileSync(join(WEB, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const bare = (spec) => new URL(import.meta.resolve(spec)).href;

/** CSP3 host-source match for an absolute URL against one source expression. */
function sourceAllows(source, urlStr) {
  const url = new URL(urlStr);
  if (source === "'self'" || source.startsWith("'")) return false; // keywords never match a remote URL
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^/:]+|[^/:*]+)(?::(\*|\d+))?$/i.exec(source);
  if (!m) return false;
  const [, scheme, host, port] = m;
  if (scheme && scheme.toLowerCase() + ':' !== url.protocol) return false;
  if (!scheme && url.protocol !== 'https:') return false;
  if (port && port !== '*' && port !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false;
  if (!port && url.port) return false;
  const h = url.hostname.toLowerCase();
  if (host === '*') return true;
  if (host.startsWith('*.')) return h.endsWith(host.slice(1).toLowerCase()) && h.length > host.length - 1;
  return h === host.toLowerCase();
}
const allowed = (csp, directive, url) => (csp[directive] ?? []).some((s) => sourceAllows(s, url));

function parseCsp(str) {
  const out = {};
  for (const d of str.split('; ')) {
    const [name, ...srcs] = d.split(' ');
    out[name] = srcs;
  }
  return out;
}

let csp; let r2;
before(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
  for (const k of ['R2_PUBLIC_HOST', 'NEXT_PUBLIC_SENTRY_DSN', 'NEXT_PUBLIC_DEMO_ASSET_BASE', 'NEXT_PUBLIC_CHORDNET_MODEL_URL', 'MINIO_ENDPOINT']) {
    delete process.env[k];
  }
  process.env.R2_ACCOUNT_ID = 'acct123abc';
  process.env.R2_BUCKET_NAME = 'stem-loops-prod';
  process.env.R2_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
  process.env.R2_SECRET_ACCESS_KEY = 'secret-secret-secret-secret';

  const next = dataUrl(`export const NextResponse = class {}; export const NextRequest = class {};`);
  const ssr = dataUrl(`export const createServerClient = () => ({});`);
  const mw = toJs('src/middleware.ts')
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`)
    .replace(/from ['"]@supabase\/ssr['"]/g, `from '${ssr}'`);
  const mod = await import(dataUrl(mw) + '#' + Math.random());
  csp = parseCsp(mod.buildCsp());

  const retention = dataUrl(toJs('src/lib/retention.ts'));
  const r2js = toJs('src/lib/r2.ts')
    .replace(/from ['"]@aws-sdk\/client-s3['"]/, `from '${bare('@aws-sdk/client-s3')}'`)
    .replace(/from ['"]@aws-sdk\/s3-request-presigner['"]/, `from '${bare('@aws-sdk/s3-request-presigner')}'`)
    .replace(/from ['"]@\/lib\/retention['"]/, `from '${retention}'`);
  r2 = await import(dataUrl(r2js) + '#' + Math.random());
});

test('matcher sanity: wildcard is single-label-or-more suffix, never the bare parent, never http', () => {
  assert.equal(sourceAllows('https://*.example.com', 'https://a.example.com/x'), true);
  assert.equal(sourceAllows('https://*.example.com', 'https://example.com/x'), false);
  assert.equal(sourceAllows('https://*.example.com', 'http://a.example.com/x'), false);
  assert.equal(sourceAllows('https://*.example.com', 'https://a.example.com.evil.test/x'), false);
  assert.equal(sourceAllows("'self'", 'https://a.example.com/x'), false);
});

test('a presigned R2 download URL is usable by fetch (connect-src) and by <audio> (media-src)', async () => {
  const url = await r2.mintSignedUrl('jobs/abc/stems/vocals.wav', 'vocals.wav', 600);
  assert.match(url, /X-Amz-Signature=/);
  assert.equal(allowed(csp, 'connect-src', url), true, `connect-src blocks ${new URL(url).origin}`);
  assert.equal(allowed(csp, 'media-src', url), true, `media-src blocks ${new URL(url).origin}`);
});

test('the play.chords.json signed URL is fetchable (connect-src)', async () => {
  const url = await r2.mintPlayChordsSignedUrl('11111111-2222-4333-8444-555555555555');
  assert.equal(allowed(csp, 'connect-src', url), true, `connect-src blocks ${new URL(url).origin}`);
});

test('the browser-direct upload (presigned PUT) is allowed by connect-src', async () => {
  const url = await r2.presignPut('jobs/abc/input.mp3', 'audio/mpeg', 1234);
  assert.match(url, /X-Amz-Signature=/);
  assert.equal(allowed(csp, 'connect-src', url), true, `connect-src blocks ${new URL(url).origin}`);
});

test('hCaptcha real endpoints are allowed on the directive that governs each', () => {
  assert.equal(allowed(csp, 'script-src', 'https://js.hcaptcha.com/1/api.js'), true, 'script-src');
  assert.equal(allowed(csp, 'frame-src', 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'), true, 'frame-src');
  assert.equal(allowed(csp, 'connect-src', 'https://api.hcaptcha.com/checksiteconfig'), true, 'connect-src');
  assert.equal(allowed(csp, 'style-src', 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.css'), true, 'style-src');
});

test('negative control: an unrelated origin is blocked on every directive', () => {
  for (const d of ['script-src', 'frame-src', 'connect-src', 'style-src', 'media-src']) {
    assert.equal(allowed(csp, d, 'https://evil.example.net/x'), false, d);
  }
});
