// SL-B10a follow-up: regression tests for the request-header scrubs in src/lib/sentry-options.ts.
// Actual behaviour: secret headers are DROPPED (key removed), not replaced with "[Filtered]".
// Dependency-free (node:test + the existing `typescript` devDependency), same loading pattern as sentry-guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = ts.transpileModule(readFileSync(join(WEB, 'src/lib/sentry-options.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { scrubEvent, beforeSend, beforeSendTransaction } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

const headersAfter = (headers, scrub = scrubEvent) => scrub({ request: { url: 'https://stem-loops.com/', headers: { ...headers } } }).request.headers;
const hasKey = (h, name) => Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());

test('x-vercel-sc-* headers are dropped from request.headers', () => {
  const h = headersAfter({
    'x-vercel-sc-headers': '{"x-secret":"SCSECRET"}',
    'x-vercel-sc-host': 'internal.vercel.app',
    'x-vercel-sc-basepath': '/internal',
    'user-agent': 'UA',
  });
  assert.deepEqual(h, { 'user-agent': 'UA' });
  assert.ok(!JSON.stringify(h).includes('SCSECRET'));
});

test('x-vercel-sc-* match is case-insensitive', () => {
  const h = headersAfter({ 'X-Vercel-SC-Headers': 'SCSECRET', 'X-VERCEL-SC-HOST': 'internal', 'user-agent': 'UA' });
  assert.deepEqual(h, { 'user-agent': 'UA' });
});

test('Authorization: Bearer <token> is not forwarded (header dropped, token absent)', () => {
  const h = headersAfter({ authorization: 'Bearer TOKEN123.abc', 'content-type': 'application/json' });
  assert.ok(!hasKey(h, 'authorization'));
  assert.ok(!JSON.stringify(h).includes('TOKEN123'));
  assert.deepEqual(h, { 'content-type': 'application/json' });
});

test('authorization / proxy-authorization are dropped in any case', () => {
  for (const name of ['Authorization', 'AUTHORIZATION', 'authorization', 'Proxy-Authorization']) {
    const h = headersAfter({ [name]: 'Bearer TOKEN123', 'user-agent': 'UA' });
    assert.ok(!hasKey(h, name), `${name} kept`);
    assert.ok(!JSON.stringify(h).includes('TOKEN123'), `${name} value leaked`);
  }
});

test('SL-B10a: a bearer credential in an unknown custom header is dropped by value', () => {
  const h = headersAfter({ 'x-custom-auth': 'Bearer CUSTOMTOKEN', 'X-Another': 'bearer   LOWERTOKEN', 'user-agent': 'UA' });
  assert.deepEqual(h, { 'user-agent': 'UA' });
});

test('Basic auth in Authorization is also dropped (key-based, not value-based)', () => {
  const h = headersAfter({ Authorization: 'Basic dXNlcjpwYXNz', 'user-agent': 'UA' });
  assert.deepEqual(h, { 'user-agent': 'UA' });
});

test('benign headers (content-type, user-agent, accept) pass through unchanged', () => {
  const input = { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)', accept: 'text/html', 'x-matched-path': '/api/jobs/[id]' };
  assert.deepEqual(headersAfter(input), input);
});

test('mixed event: secrets removed, benign headers intact', () => {
  const h = headersAfter({
    'X-Vercel-SC-Headers': 'SCSECRET',
    Authorization: 'Bearer TOKEN123',
    'Content-Type': 'application/json',
    'User-Agent': 'UA',
  });
  assert.deepEqual(h, { 'Content-Type': 'application/json', 'User-Agent': 'UA' });
});

test('beforeSend and beforeSendTransaction apply the same header scrub', () => {
  for (const hook of [beforeSend, beforeSendTransaction]) {
    const h = headersAfter({ 'x-vercel-sc-headers': 'SCSECRET', authorization: 'Bearer TOKEN123', 'user-agent': 'UA' }, hook);
    assert.deepEqual(h, { 'user-agent': 'UA' });
  }
});
