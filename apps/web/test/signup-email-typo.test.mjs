// Run: pnpm --filter web test
//
// QA A-09 (track A, 2026-11-18): sign-up accepted `jon@gmial.com` and sent a confirmation
// email that bounced. The form now WARNS — "Did you mean jon@gmail.com?" with a one-tap fix —
// and never blocks: the address as typed is still sent. The fixture below is the typo list
// the finding named plus the common neighbours; every entry must get a suggestion, and real
// domains that sit one letter away (email.com, ymail.com, hotmail.co.uk) must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDom } from './helpers/dom.mjs';
import { loadLoginFormComponent } from './helpers/render-login-form.mjs';
import { suggestEmailFix, validateSignupEmail } from '../src/lib/auth/password-rules.ts';

const OBSERVED = [
  ['jon@gmial.com', 'jon@gmail.com'],
  ['jon@gmail.con', 'jon@gmail.com'],
  ['jon@gmail.c', 'jon@gmail.com'],
  ['jon@gmai.com', 'jon@gmail.com'],
  ['jon@hotmial.com', 'jon@hotmail.com'],
  ['jon@yaho.com', 'jon@yahoo.com'],
  ['jon@outlok.com', 'jon@outlook.com'],
  ['Jon.Cart+tag@GMIAL.COM', 'Jon.Cart+tag@gmail.com'],
  ['  jon@gamil.com ', 'jon@gmail.com'],
  ['jon@icloud.con', 'jon@icloud.com'],
];
const REAL = ['jon@outlook.co', 'jon@gmail.co', 'jon@hotmail.co', 'jon@icloud.co', 'jon@gmail.com', 'jon@email.com', 'jon@ymail.com', 'jon@hotmail.co.uk', 'jon@yahoo.co.jp', 'jon@outlook.de', 'jon@example.test', 'jon@mail.gmial.com.au', 'not-an-email', '', null];

test('A-09: every observed provider typo gets a "did you mean" fix, keeping the local part as typed', () => {
  for (const [typed, want] of OBSERVED) assert.equal(suggestEmailFix(typed), want, typed);
});

// Review of #301, F-6: the bare `.co` forms are a real TLD and are never flagged.
test('A-09: real domains (the bare .co forms included) and non-addresses get no suggestion', () => {
  for (const ok of REAL) assert.equal(suggestEmailFix(ok), null, String(ok));
});

test('A-09: a typo is a warning, not a block: validateSignupEmail still accepts it', () => {
  for (const [typed] of OBSERVED) assert.equal(validateSignupEmail(typed), null, typed);
});

// ── the form ──────────────────────────────────────────────────────────────────
const { React, Form } = await loadLoginFormComponent();
function typeInto(input, value) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  set.call(input, value);
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
}
const blur = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.FocusEvent('focusout', { bubbles: true }));

test('A-09 sign-up form: leaving the field on jon@gmial.com shows "Did you mean jon@gmail.com?"; one tap fixes it', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Form, { initialMode: 'signup' }));
    const email = dom.find('input[type="email"]');
    await dom.act(async () => { typeInto(email, 'jon@gmial.com'); });
    assert.equal(dom.find('[data-testid="email-typo"]'), null, 'no hint while still typing');
    await dom.act(async () => { blur(email); });
    const hint = dom.find('[data-testid="email-typo"]');
    assert.ok(hint, 'no "did you mean" hint after leaving the field');
    assert.equal(hint.textContent.replace(/\s+/g, ' ').trim(), 'Did you mean jon@gmail.com?');
    assert.equal(email.getAttribute('aria-describedby'), 'email-typo', 'the hint is tied to the field');
    await dom.act(async () => { dom.find('[data-testid="email-typo-fix"]').click(); });
    assert.equal(dom.find('input[type="email"]').value, 'jon@gmail.com', 'the fix did not replace the address');
    assert.equal(dom.find('[data-testid="email-typo"]'), null, 'the hint stays after the fix');
  });
});

test('A-09 sign-up form: the typo does NOT block the submit (the address as typed is sent)', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, needs_confirmation: true }) };
  };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, { initialMode: 'signup' }));
      await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'jon@gmial.com'); });
      await dom.act(async () => { typeInto(dom.find('input[autocomplete="new-password"]'), 'correct-horse-9'); });
      await dom.act(async () => {
        const form = dom.find('form');
        form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert.equal(sent.length, 1, 'the typo blocked the sign-up');
      assert.equal(sent[0].body.email, 'jon@gmial.com', 'the address was changed without the person choosing the fix');
      assert.ok(dom.find('[data-testid="email-typo"]'), 'the hint still shows after the submit');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('A-09: sign-in mode never shows the hint (an existing account is not second-guessed)', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Form, {}));
    const email = dom.find('input[type="email"]');
    await dom.act(async () => { typeInto(email, 'jon@gmial.com'); });
    await dom.act(async () => { blur(email); });
    assert.equal(dom.find('[data-testid="email-typo"]'), null);
  });
});
