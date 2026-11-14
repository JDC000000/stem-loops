// LoginForm, MOUNTED AND CLICKED (happy-dom via test/helpers/dom.mjs, real React effects and
// events). login-form.test.mjs renders to static markup and says so: it sees first paint only.
//
// WHY THIS FILE EXISTS. The "New here? Create account" button is the only visible way into
// account creation now that the one-time link no longer is. An adversarial review made it
// `disabled`, and separately pointed its handler at setMode('reset'): both stayed green, because
// the markup of a working button and a dead one is identical in a string match. Every
// assertion below presses the button and reads what the user would then see.
//
// CANNOT COVER (dom.mjs says the same): layout. Nothing here is evidence about tap-target size
// or contrast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDom } from './helpers/dom.mjs';
import { loadLoginFormComponent } from './helpers/render-login-form.mjs';

const { React, Form } = await loadLoginFormComponent();

const mountForm = (dom, props = {}) => dom.mount(React.createElement(Form, props));
const heading = (dom) => dom.find('h1')?.textContent;
const buttonByText = (dom, text) => dom.findAll('button').find((b) => b.textContent === text);
// A missing button is a FAILED ASSERTION, not a TypeError from `undefined.click()`: a crash is not a kill.
const press = (dom, button, label = 'button') => {
  assert.ok(button, `${label} is not on the screen`);
  return dom.act(async () => { button.click(); });
};

test('CANARY: pressing a sibling control changes the heading (so a heading assertion can tell modes apart)', async () => {
  await withDom(async (dom) => {
    await mountForm(dom);
    assert.equal(heading(dom), 'Sign in');
    await press(dom, buttonByText(dom, 'Forgot password?'), 'Forgot password?');
    assert.equal(heading(dom), 'Reset password');
  });
});

test('"New here? Create account" is enabled and pressing it shows the signup form', async () => {
  await withDom(async (dom) => {
    await mountForm(dom);
    const btn = buttonByText(dom, 'New here? Create account');
    assert.ok(btn, 'the button is rendered in sign-in mode');
    assert.equal(btn.hasAttribute('disabled'), false, 'the button has a disabled attribute');
    assert.equal(btn.disabled, false);

    await press(dom, btn);

    // Not Reset password, not still Sign in: the signup form.
    assert.equal(heading(dom), 'Create account');
    const pw = dom.find('input[type="password"]');
    assert.ok(pw, 'a password field is shown');
    assert.equal(pw.getAttribute('autocomplete'), 'new-password');
    assert.equal(pw.getAttribute('minlength'), '10');
    assert.match(dom.find('form').textContent, /At least 10 characters, with a letter and a digit/);
    assert.equal(buttonByText(dom, 'New here? Create account'), undefined, 'the entry button leaves once used');
    assert.ok(buttonByText(dom, 'Already have an account? Sign in'), 'and the way back is offered');
  });
});

test('a visitor bounced from a job can reach the signup form from the sign-in screen', async () => {
  await withDom(async (dom) => {
    await mountForm(dom, { returnTo: '/jobs/abc-123' });
    assert.match(dom.find('h1').parentElement.textContent, /Sign in to open your player\. If you are new, create an account\./);
    await press(dom, buttonByText(dom, 'New here? Create account'), 'New here? Create account');
    assert.equal(heading(dom), 'Create account');
    assert.doesNotMatch(dom.find('h1').parentElement.textContent, /open your player/);
  });
});

test('signup mode and back: the way in and out both work', async () => {
  await withDom(async (dom) => {
    await mountForm(dom);
    await press(dom, buttonByText(dom, 'New here? Create account'), 'New here? Create account');
    await press(dom, buttonByText(dom, 'Already have an account? Sign in'), 'Already have an account? Sign in');
    assert.equal(heading(dom), 'Sign in');
    assert.ok(buttonByText(dom, 'New here? Create account'));
  });
});
