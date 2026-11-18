// Run: pnpm --filter web test
//
// QA A-11 (track A, 2026-11-18): after a server error ("If you already have an account,
// sign in instead…"), editing the password and submitting showed the browser's
// "Please lengthen this text…" bubble AND the old red error together: the error was
// cleared only when a new request started. Every form error now clears as soon as a
// field it describes changes. REAL LoginForm, happy-dom, real React events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDom } from './helpers/dom.mjs';
import { loadLoginFormComponent } from './helpers/render-login-form.mjs';

const { React, Form } = await loadLoginFormComponent();
function typeInto(input, value) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  set.call(input, value);
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
}
const alerts = (dom) => dom.findAll('[role="alert"]').map((n) => n.textContent).filter((t) => !/Sign-up is unavailable/.test(t));
const SERVER = 'If you already have an account, sign in instead — or wait a minute and try again.';

for (const field of ['input[type="email"]', 'input[autocomplete="new-password"]']) {
  test(`A-11: a server error clears when the person edits ${field}`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 200, json: async () => ({ ok: false, error: SERVER, sign_in: true }) });
    try {
      await withDom(async (dom) => {
        await dom.mount(React.createElement(Form, { initialMode: 'signup' }));
        await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@example.com'); });
        await dom.act(async () => { typeInto(dom.find('input[autocomplete="new-password"]'), 'correct-horse-9'); });
        await dom.act(async () => {
          const form = dom.find('form');
          form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 0));
        });
        assert.deepEqual(alerts(dom), [SERVER], 'harness: the server error is shown first');
        assert.ok(dom.find('[data-testid="signup-sign-in"]'), 'harness: with its Sign in link');
        await dom.act(async () => { typeInto(dom.find(field), 'abc'); });
        assert.deepEqual(alerts(dom), [], 'the stale server error is still on screen after an edit');
        assert.equal(dom.find('[data-testid="signup-sign-in"]'), null, 'its Sign in link is still on screen');
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}
