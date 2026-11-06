// Magic link must not create accounts (bug 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMagicLink, MAGIC_LINK_SENT } from '../src/lib/auth/magic-link.ts';

const client = (result) => {
  const calls = [];
  return { calls, auth: { signInWithOtp: async (a) => { calls.push(a); return result; } } };
};

test('passes shouldCreateUser:false so the OTP path cannot bypass signup captcha', async () => {
  const c = client({ error: null });
  const msg = await sendMagicLink(c, 'a@b.co', 'https://x/login');
  assert.equal(msg, MAGIC_LINK_SENT);
  assert.equal(c.calls[0].options.shouldCreateUser, false);
  assert.equal(c.calls[0].options.emailRedirectTo, 'https://x/login');
});

test('known and unknown addresses are indistinguishable to the caller (no enumeration)', async () => {
  const known = await sendMagicLink(client({ error: null }), 'known@b.co', 'u');
  const unknownByCode = await sendMagicLink(
    client({ error: { code: 'otp_disabled', message: 'Signups not allowed for otp' } }), 'new@b.co', 'u');
  const unknownByMessage = await sendMagicLink(
    client({ error: { message: 'Signups not allowed for otp' } }), 'new@b.co', 'u');
  assert.equal(unknownByCode, known);
  assert.equal(unknownByMessage, known);
  assert.match(known, /^If an account exists/);
  assert.doesNotMatch(known, /no account|not found|create/i);
});

test('other errors propagate', async () => {
  const err = { code: 'over_email_send_rate_limit', message: 'rate limited' };
  await assert.rejects(sendMagicLink(client({ error: err }), 'a@b.co', 'u'), (e) => e === err);
});
