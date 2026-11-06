// LoginForm rendered output (bugs 1, 2, 4). Real render via react-dom/server;
// see test/helpers/render-login-form.mjs for what this can and cannot cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLoginForm, passwordInput } from './helpers/render-login-form.mjs';

const render = await loadLoginForm();

test('sign-in password input has no minLength (6/7-char legacy passwords must be able to sign in)', () => {
  const input = passwordInput(render({}));
  assert.ok(input, 'password input rendered');
  assert.doesNotMatch(input, /minlength/i);
  assert.match(input, /autoComplete="current-password"/);
});

test('signup password input enforces the server minimum (10)', () => {
  const input = passwordInput(render({ initialMode: 'signup' }));
  assert.match(input, /minLength="10"/);
  assert.match(input, /autoComplete="new-password"/);
});

test('reset mode has no password input', () => {
  assert.equal(passwordInput(render({ initialMode: 'reset' })), null);
});

test('?error=auth_callback_failed renders an actionable alert, not a blank form', () => {
  const html = render({ initialError: 'auth_callback_failed' });
  const alert = html.match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1];
  assert.ok(alert, 'an alert is rendered');
  assert.match(alert, /expired/i);
  assert.match(alert, /new link/i);
  assert.doesNotMatch(alert, /auth_callback_failed/);
});

test('?error=auth_link_expired renders its own message', () => {
  const alert = render({ initialError: 'auth_link_expired' }).match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1];
  assert.match(alert, /has expired/i);
});

test('unrecognised ?error value falls back to generic copy and never echoes the value', () => {
  const html = render({ initialError: '<script>x</script>' });
  const alert = html.match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1];
  assert.ok(alert);
  assert.match(alert, /did not complete/i);
  assert.doesNotMatch(html, /<script>x/);
});

test('no ?error renders no alert', () => {
  assert.doesNotMatch(render({}), /role="alert"/);
});

test('signup form tells the user the rule the server enforces', () => {
  assert.match(render({ initialMode: 'signup' }), /At least 10 characters, with a letter and a digit/);
});
