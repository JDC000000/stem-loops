// verifyHcaptchaToken helper tests — V3-C1. No real network: global fetch is stubbed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = ts.transpileModule(readFileSync(join(WEB, 'src/lib/hcaptcha.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { verifyHcaptchaToken, HCAPTCHA_VERIFY_URL } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

const TEST_SECRET = '0x0000000000000000000000000000000000000000';
const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  process.env.HCAPTCHA_SECRET_KEY = TEST_SECRET;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HCAPTCHA_SECRET_KEY;
});

function stubFetch(impl) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
}
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('happy path: posts form-encoded secret+response and returns success', async () => {
  stubFetch(() => jsonRes({ success: true }));
  const out = await verifyHcaptchaToken('10000000-aaaa-bbbb-cccc-000000000001', '203.0.113.9');
  assert.deepEqual(out, { success: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HCAPTCHA_VERIFY_URL);
  assert.equal(calls[0].url, 'https://hcaptcha.com/siteverify');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('secret'), TEST_SECRET);
  assert.equal(form.get('response'), '10000000-aaaa-bbbb-cccc-000000000001');
  assert.equal(form.get('remoteip'), '203.0.113.9');
});

test('remoteip is omitted when not provided', async () => {
  stubFetch(() => jsonRes({ success: true }));
  await verifyHcaptchaToken('tok');
  assert.equal(new URLSearchParams(calls[0].init.body).has('remoteip'), false);
});

test('failure: hCaptcha rejects token -> success false with error codes', async () => {
  stubFetch(() => jsonRes({ success: false, 'error-codes': ['invalid-input-response'] }));
  const out = await verifyHcaptchaToken('bad');
  assert.equal(out.success, false);
  assert.deepEqual(out.errorCodes, ['invalid-input-response']);
});

test('non-2xx from hCaptcha fails closed', async () => {
  stubFetch(() => jsonRes({}, 503));
  const out = await verifyHcaptchaToken('tok');
  assert.equal(out.success, false);
  assert.deepEqual(out.errorCodes, ['http-503']);
});

test('network error fails closed (does not throw)', async () => {
  stubFetch(() => { throw new Error('ECONNRESET'); });
  const out = await verifyHcaptchaToken('tok');
  assert.equal(out.success, false);
  assert.deepEqual(out.errorCodes, ['network-error']);
});

test('malformed JSON body fails closed', async () => {
  stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }));
  const out = await verifyHcaptchaToken('tok');
  assert.equal(out.success, false);
});

test('missing secret env fails closed without calling the network', async () => {
  delete process.env.HCAPTCHA_SECRET_KEY;
  stubFetch(() => jsonRes({ success: true }));
  const out = await verifyHcaptchaToken('tok');
  assert.equal(out.success, false);
  assert.deepEqual(out.errorCodes, ['missing-secret-env']);
  assert.equal(calls.length, 0);
});

test('empty token fails closed without calling the network', async () => {
  stubFetch(() => jsonRes({ success: true }));
  const out = await verifyHcaptchaToken('');
  assert.equal(out.success, false);
  assert.equal(calls.length, 0);
});
