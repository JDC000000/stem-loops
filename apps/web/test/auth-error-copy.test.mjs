// Every error code /auth/callback can emit must have login-page copy (bug 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGIN_ERROR_COPY, loginErrorMessage, LOGIN_ERROR_FALLBACK } from '../src/lib/auth/login-errors.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every ?error= code in the callback route has copy', () => {
  const src = readFileSync(join(WEB, 'src/app/auth/callback/route.ts'), 'utf8');
  const emitted = [...src.matchAll(/\/login\?error=([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 1, 'found emitted codes');
  for (const code of new Set(emitted)) {
    assert.ok(LOGIN_ERROR_COPY[code], `no LOGIN_ERROR_COPY entry for "${code}"`);
  }
});

test('loginErrorMessage: null for none, copy for known, fallback for unknown', () => {
  assert.equal(loginErrorMessage(undefined), null);
  assert.equal(loginErrorMessage(''), null);
  assert.equal(loginErrorMessage('auth_link_expired'), LOGIN_ERROR_COPY.auth_link_expired);
  assert.equal(loginErrorMessage('nope'), LOGIN_ERROR_FALLBACK);
  assert.equal(loginErrorMessage('toString'), LOGIN_ERROR_FALLBACK);
});
