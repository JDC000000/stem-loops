// Magic link must not create accounts (bug 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMagicLink, MAGIC_LINK_SENT, MAGIC_LINK_NO_ACCOUNT } from '../src/lib/auth/magic-link.ts';

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

test('unknown address (otp_disabled) -> tells the user to create an account', async () => {
  const c = client({ error: { code: 'otp_disabled', message: 'Signups not allowed for otp' } });
  assert.equal(await sendMagicLink(c, 'new@b.co', 'u'), MAGIC_LINK_NO_ACCOUNT);
});

test('older Supabase error without a code is recognised by message', async () => {
  const c = client({ error: { message: 'Signups not allowed for otp' } });
  assert.equal(await sendMagicLink(c, 'new@b.co', 'u'), MAGIC_LINK_NO_ACCOUNT);
});

test('other errors propagate', async () => {
  const err = { code: 'over_email_send_rate_limit', message: 'rate limited' };
  await assert.rejects(sendMagicLink(client({ error: err }), 'a@b.co', 'u'), (e) => e === err);
});
