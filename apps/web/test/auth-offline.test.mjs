// Run: pnpm --filter web test
//
// QA A-08 (track A, 2026-11-18): signing in while the auth host was unreachable showed the
// alert "Failed to fetch" — LoginForm rendered `e.message` from fetch()/supabase-js as is.
// Sign-in, sign-up and both reset flows now route every thrown error through ONE copy map
// (lib/auth/login-errors.ts authErrorMessage): offline gets a plain line, provider text is
// never shown, and the app's own copy passes through.
//
// HARNESS: the REAL LoginForm (test/helpers/render-login-form.mjs, happy-dom, real React
// events) with a scriptable Supabase stub, and the REAL ResetPasswordRequestForm with its
// imports mapped to the real modules. What is asserted is the alert a user reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { withDom } from './helpers/dom.mjs';
import { loadLoginFormComponent } from './helpers/render-login-form.mjs';
import {
  AUTH_OFFLINE,
  AUTH_BAD_CREDENTIALS,
  AUTH_GENERIC,
  appCopyError,
  authErrorMessage,
  isNetworkError,
} from '../src/lib/auth/login-errors.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

const { React, Form } = await loadLoginFormComponent();

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'auth-offline-'));
const put = (name, code) => { writeFileSync(join(dir, name), code); return './' + name; };
const errorsMod = put('login-errors.mjs', toJs(read('src/lib/auth/login-errors.ts')));
const stylesMod = put('form-styles.mjs', toJs(read('src/lib/ui/form-styles.ts')));
const rulesMod = put('password-rules.mjs', toJs(read('src/lib/auth/password-rules.ts')));
put('ResetPasswordRequestForm.mjs', toJs(read('src/components/ResetPasswordRequestForm.tsx'))
  .replace(/from ['"]@\/lib\/auth\/login-errors['"]/g, `from '${errorsMod}'`)
  .replace(/from ['"]@\/lib\/ui\/form-styles['"]/g, `from '${stylesMod}'`)
  .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rulesMod}'`));
const ResetRequest = (await import(pathToFileURL(join(dir, 'ResetPasswordRequestForm.mjs')).href)).default;

// What each browser's fetch() rejects with when the network is down, and supabase-js's wrapper.
const OFFLINE_ERRORS = [
  () => new TypeError('Failed to fetch'), // Chromium
  () => new TypeError('NetworkError when attempting to fetch resource.'), // Firefox
  () => new TypeError('Load failed'), // Safari
  () => Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }), // supabase-js
];

// ── the copy map ──────────────────────────────────────────────────────────────
test('authErrorMessage: every browser\'s offline error reads the offline line, never the raw message', () => {
  for (const make of OFFLINE_ERRORS) {
    const e = make();
    assert.equal(isNetworkError(e), true, `${e.name}: ${e.message} not seen as offline`);
    assert.equal(authErrorMessage(e), AUTH_OFFLINE);
  }
  assert.match(AUTH_OFFLINE, /couldn.t reach stem-loops\. Check your connection and try again\./);
});

test('authErrorMessage: provider text is never shown; known codes get plain copy; our own copy passes', () => {
  assert.equal(authErrorMessage({ name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }), AUTH_BAD_CREDENTIALS);
  assert.equal(authErrorMessage({ name: 'AuthApiError', status: 500, message: 'Database error querying schema' }), AUTH_GENERIC);
  assert.equal(authErrorMessage(new Error('Database error querying schema'), 'Sign-in did not complete.'), 'Sign-in did not complete.');
  assert.equal(authErrorMessage(appCopyError('If you already have an account, sign in instead.')), 'If you already have an account, sign in instead.');
  assert.equal(authErrorMessage(new TypeError("Cannot read properties of undefined (reading 'error')")), AUTH_GENERIC, 'a code bug is not "offline"');
  assert.equal(authErrorMessage(undefined), AUTH_GENERIC);
});

// ── the forms ─────────────────────────────────────────────────────────────────
function typeInto(input, value) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  set.call(input, value);
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
}
const alertText = (dom) => dom.findAll('[role="alert"]').map((n) => n.textContent).join(' | ');
const submit = (dom) => dom.act(async () => {
  const form = dom.find('form');
  form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
});

for (const [i, make] of OFFLINE_ERRORS.entries()) {
  test(`A-08 sign-in offline (#${i}): the alert is the offline line, not "${make().message}"`, async () => {
    // Either shape: supabase-js returning { error } or the call itself rejecting.
    for (const shape of ['returned', 'thrown']) {
      globalThis.__loginStub = { password: async () => { if (shape === 'thrown') throw make(); return { data: null, error: make() }; } };
      try {
        await withDom(async (dom) => {
          await dom.mount(React.createElement(Form, {}));
          await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@example.com'); });
          await dom.act(async () => { typeInto(dom.find('input[autocomplete="current-password"]'), 'whatever-1'); });
          await submit(dom);
          const text = alertText(dom);
          assert.equal(text, AUTH_OFFLINE, `${shape}: alert reads "${text}"`);
          assert.doesNotMatch(text, /Failed to fetch|NetworkError|Load failed/);
        });
      } finally {
        delete globalThis.__loginStub;
      }
    }
  });
}

test('A-08 sign-up offline: POST /api/auth/signup rejecting shows the offline line', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, { initialMode: 'signup' }));
      await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@example.com'); });
      await dom.act(async () => { typeInto(dom.find('input[autocomplete="new-password"]'), 'correct-horse-9'); });
      await submit(dom);
      const text = alertText(dom).split(' | ').filter((t) => !/Sign-up is unavailable/.test(t)).join(' | ');
      assert.equal(text, AUTH_OFFLINE, `alert reads "${text}"`);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('A-08 reset (sign-in page) offline: resetPasswordForEmail failing shows the offline line', async () => {
  globalThis.__loginStub = { reset: async () => ({ data: null, error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }) }) };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, { initialMode: 'reset' }));
      await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@example.com'); });
      await submit(dom);
      assert.equal(alertText(dom), AUTH_OFFLINE);
    });
  } finally {
    delete globalThis.__loginStub;
  }
});

test('A-08 reset (/account/reset-password request form) offline: shows the offline line, not the generic failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(ResetRequest));
      await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@example.com'); });
      await submit(dom);
      assert.equal(alertText(dom), AUTH_OFFLINE);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('A-08: a wrong password still reads a plain line, never the provider\'s', async () => {
  globalThis.__loginStub = { password: async () => ({ data: null, error: { name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } }) };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, {}));
      await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@example.com'); });
      await submit(dom);
      assert.equal(alertText(dom), AUTH_BAD_CREDENTIALS);
    });
  } finally {
    delete globalThis.__loginStub;
  }
});
