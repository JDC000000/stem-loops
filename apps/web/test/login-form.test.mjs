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

// Front door. The one-time link is sent with shouldCreateUser:false, so it only works for an
// account that already exists. The form must say so, and must not say it per-address.
//
// These assert the EXACT rendered sentence, not a substring. The first version matched
// /already (?:have|created)|existing account/ within 600 chars of the button; an adversarial
// review replaced the note with "the one-time link creates one for you" and it stayed green.
// Interaction (clicking the buttons) is in login-form-interaction.test.mjs.
const strip = (html) => html.replace(/<!-- -->/g, ''); // React's SSR text-node separators
const noteAfterLink = (html) => {
  const m = strip(html).match(/Email me a one-time link<\/button><p[^>]*>(.*?)<\/p>/);
  assert.ok(m, 'the one-time-link button is followed by a note');
  return m[1];
};
const LINK_NOTE = 'The one-time link signs you in to an account you already have. It does not create one.';
const INVERSIONS = [/\bcreates\b/i, /\bno need\b/i, /\b(?:do not|don't|does not|doesn't) have to\b/i, /\bwhether or not\b/i];

test('the one-time-link note says it is for an existing account, in every mode', () => {
  assert.equal(noteAfterLink(render({})), `${LINK_NOTE} New here? Use Create account.`);
  // The "Use Create account" pointer only makes sense where Create account is a thing to use.
  assert.equal(noteAfterLink(render({ initialMode: 'signup' })), LINK_NOTE);
  assert.equal(noteAfterLink(render({ initialMode: 'reset' })), LINK_NOTE);
});

test('the one-time-link note never says the link creates an account', () => {
  for (const mode of ['signin', 'signup', 'reset']) {
    const note = noteAfterLink(render({ initialMode: mode }));
    for (const re of INVERSIONS) assert.doesNotMatch(note, re, `${mode}: ${re}`);
  }
  // Canary: the ban list still bites on the wording it exists for.
  const inverted = 'The one-time link signs you in if you already have an account, and otherwise creates one for you.';
  assert.ok(INVERSIONS.some((re) => re.test(inverted)), 'ban list no longer matches the known inversion');
});

const createButton = (html) =>
  strip(html).match(/<button type="button"([^>]*)>New here\? Create an account<\/button>/);

test('sign-in mode offers Create account as a full-width button that is not disabled', () => {
  const m = createButton(render({}));
  assert.ok(m, 'the "New here? Create an account" button is rendered');
  assert.match(m[1], /width:100%/);
  // A disabled button renders identically to a live one at first paint except for this attribute.
  assert.doesNotMatch(m[1], /\bdisabled\b/i, 'the Create-account button is disabled');
});

test('the Create-account button exists in sign-in mode only', () => {
  assert.equal(createButton(render({ initialMode: 'signup' })), null);
  assert.equal(createButton(render({ initialMode: 'reset' })), null);
});

test('a visitor bounced from a job is pointed at both paths; a bare /login is not', () => {
  assert.match(render({ returnTo: '/jobs/abc-123' }), /Sign in to open your player\. If you are new, create an account\./);
  assert.doesNotMatch(render({}), /open your player/);
  for (const returnTo of ['/pricing', '/account', '/history', '/jobs', '/login']) {
    assert.doesNotMatch(render({ returnTo }), /open your player/, returnTo);
  }
});

test('the job line is a sign-in-mode line: it does not sit under the Create account / Reset password heading', () => {
  // L5: with the `mode === 'signin'` gate removed the line rendered under "Create account".
  for (const initialMode of ['signup', 'reset']) {
    assert.doesNotMatch(render({ returnTo: '/jobs/abc-123', initialMode }), /open your player/, initialMode);
  }
});

test('no job line beside an error: "if you are new, create an account" must not sit next to "your account was created"', () => {
  const html = render({ returnTo: '/jobs/abc-123', initialError: 'auth_signup_link_failed' });
  assert.doesNotMatch(html, /If you are new/);
  assert.match(html, /role="alert"/);
});

test('?error=auth_signup_link_failed: points at password sign-in, with Forgot password as the fallback, and asks for no new link', () => {
  const alert = render({ initialError: 'auth_signup_link_failed' }).match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1];
  assert.ok(alert, 'an alert is rendered');
  assert.match(alert, /account was created/i);
  assert.match(alert, /sign in with the email and password you chose/i);
  assert.match(alert, /Forgot password\?/);
  // There is no control that sends a new confirmation link; the old copy told these users to ask for one.
  assert.doesNotMatch(alert, /request a new link|new one/i);
  assert.doesNotMatch(alert, /auth_signup_link_failed/);
});
