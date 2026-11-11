// scripts/lib/smoke_session.mjs — unit tests for the staging smoke test's
// service-role session minting.
//
// Context: `Nightly staging smoke` failed five nights in a row (Nov 7-10 2026)
// at step 3b with Supabase Auth's captcha_failed. The password grant cannot
// work while Supabase Auth captcha protection is enabled (and it should stay
// enabled), so the session is now minted over the Admin API:
//   POST /auth/v1/admin/generate_link -> hashed_token
//   POST /auth/v1/verify              -> access_token / refresh_token
//
// The real end-to-end path CANNOT be exercised from CI or from a dev box
// without the staging service-role key, so everything here drives an injected
// `fetch`. These tests pin the request shapes (paths, method, headers, bodies)
// and every failure mode, including the one that matters most: that no part of
// the service-role key can reach a thrown message or stdout/stderr.
//
// Covered:
//   1.  happy path -> returns the session JSON untouched
//   2.  request shapes: paths, apikey/Authorization on generate_link,
//       apikey-only (no Authorization) on verify, token_hash alone on verify
//   3.  verification_type is echoed back from generate_link (magiclink->signup)
//   4.  missing service-role key -> fails closed, never falls back to password
//   5.  SUPABASE_URL / email missing -> fails closed
//   6.  generate_link non-2xx -> SmokeSessionError naming the step
//   7.  generate_link malformed JSON -> named error, not a raw SyntaxError
//   8.  generate_link 200 without hashed_token -> named error
//   9.  verify non-2xx -> named error
//   10. verify malformed JSON -> named error
//   11. verify 200 without access_token -> named error
//   12. verify 200 with access_token but no refresh_token -> named error
//   13. fetch rejection (network/timeout) -> named error
//   14. LEAK PROOF: a sentinel key echoed back by every response, in the body,
//       in a thrown network error and in a non-JSON body, appears in no thrown
//       message and in nothing written to stdout/stderr
//   15. redactSecret unit behaviour, incl. the short-secret guard

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mintServiceRoleSession, redactSecret, SmokeSessionError } from '../../../scripts/lib/smoke_session.mjs';

const SB = 'https://ylzokjwnsraehmpclnkx.supabase.co';
const EMAIL = 'smoke-test-1762800000000@stemloops.test';
const KEY = 'sb_secret_unit_test_only_not_a_real_key';

const SESSION = {
  access_token: 'eyJhbGciOiJIUzI1NiJ9.header.sig',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 1762803600,
  refresh_token: 'refresh-abc123',
  user: { id: '11111111-1111-1111-1111-111111111111', email: EMAIL },
};

const res = (status, body, { json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (json ? JSON.stringify(body) : String(body)),
});

/** fetch stub that records calls and replays a scripted queue of responses. */
function stubFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? 'null') });
    const next = queue.shift();
    if (typeof next === 'function') return next();
    if (next === undefined) throw new Error(`unexpected extra fetch to ${url}`);
    return next;
  };
  fn.calls = calls;
  return fn;
}

const linkOk = (over = {}) => res(200, {
  id: '11111111-1111-1111-1111-111111111111',
  email: EMAIL,
  action_link: `${SB}/auth/v1/verify?token=hashed-tok&type=magiclink`,
  email_otp: '999999',
  hashed_token: 'hashed-tok',
  verification_type: 'magiclink',
  redirect_to: 'https://stem-loops-staging.vercel.app',
  ...over,
});

const mint = (queue, over = {}) => {
  const fetchImpl = stubFetch(queue);
  return {
    fetchImpl,
    run: () => mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, email: EMAIL, fetchImpl, ...over }),
  };
};

// ---------------------------------------------------------------- 1. happy path
test('happy path returns the GoTrue session JSON unchanged', async () => {
  const { run } = mint([linkOk(), res(200, SESSION)]);
  assert.deepEqual(await run(), SESSION);
});

// ------------------------------------------------------------ 2. request shapes
test('request shapes match the verified GoTrue endpoints', async () => {
  const { fetchImpl, run } = mint([linkOk(), res(200, SESSION)]);
  await run();
  assert.equal(fetchImpl.calls.length, 2);

  // Both calls must be abortable: the workflow gives the whole script 300s,
  // so a hung socket must not silently eat the budget.
  for (const c of fetchImpl.calls) {
    assert.ok(c.init.signal instanceof AbortSignal, 'every request must carry an abort signal');
  }

  const [gen, ver] = fetchImpl.calls;

  assert.equal(gen.url, `${SB}/auth/v1/admin/generate_link`);
  assert.equal(gen.init.method, 'POST');
  assert.deepEqual(gen.body, { type: 'magiclink', email: EMAIL });
  // Admin credentials go on this call only.
  assert.equal(gen.headers.apikey, KEY);
  assert.equal(gen.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(gen.headers['Content-Type'], 'application/json');

  assert.equal(ver.url, `${SB}/auth/v1/verify`);
  assert.equal(ver.init.method, 'POST');
  // verify.go:85 — token_hash must travel alone; email/token alongside it is a
  // 400 "Only the token_hash and type should be provided".
  assert.deepEqual(ver.body, { token_hash: 'hashed-tok', type: 'magiclink' });
  assert.equal(ver.headers.apikey, KEY);
  // No Authorization: GoTrue would read an aud claim off it (helpers.go:25).
  assert.equal(ver.headers.Authorization, undefined);
});

// -------------------------------------------------------- 3. verification_type
test('verification_type from generate_link is echoed back to verify', async () => {
  // generate_link rewrites magiclink -> signup when it had to create the user,
  // and stores a ConfirmationToken rather than a RecoveryToken (mail.go:77).
  const { fetchImpl, run } = mint([linkOk({ verification_type: 'signup' }), res(200, SESSION)]);
  await run();
  assert.deepEqual(fetchImpl.calls[1].body, { token_hash: 'hashed-tok', type: 'signup' });
});

test('a missing verification_type falls back to magiclink', async () => {
  const { fetchImpl, run } = mint([linkOk({ verification_type: undefined }), res(200, SESSION)]);
  await run();
  assert.equal(fetchImpl.calls[1].body.type, 'magiclink');
});

// ------------------------------------------------------- 4/5. fails closed
test('a missing service-role key fails closed and makes no request', async () => {
  const fetchImpl = stubFetch([]);
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: SB, serviceKey: '', email: EMAIL, fetchImpl }),
    (e) => {
      assert.ok(e instanceof SmokeSessionError, `expected SmokeSessionError, got ${e?.name}`);
      assert.match(e.message, /SUPABASE_SERVICE_ROLE_KEY is not set/);
      assert.match(e.message, /STAGING_SUPABASE_SERVICE_ROLE_KEY/);
      // It must NOT quietly try the password grant that cannot work.
      assert.doesNotMatch(e.message, /grant_type=password/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0, 'must not hit the network without a key');
});

test('an undefined service-role key fails closed too', async () => {
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: SB, serviceKey: undefined, email: EMAIL, fetchImpl: stubFetch([]) }),
    /SUPABASE_SERVICE_ROLE_KEY is not set/,
  );
});

test('a missing SUPABASE_URL or email fails closed', async () => {
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: '', serviceKey: KEY, email: EMAIL, fetchImpl: stubFetch([]) }),
    /SUPABASE_URL is not set/,
  );
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, email: '', fetchImpl: stubFetch([]) }),
    /no email given/,
  );
});

// --------------------------------------------------- 6-8. generate_link errors
test('generate_link non-2xx names the step, status and body', async () => {
  const { fetchImpl, run } = mint([
    res(401, { code: 401, msg: 'Invalid API key' }),
    res(200, SESSION),
  ]);
  await assert.rejects(run, (e) => {
    assert.ok(e instanceof SmokeSessionError);
    assert.equal(e.step, 'generate_link');
    assert.match(e.message, /^generate_link: /);
    assert.match(e.message, /HTTP 401/);
    assert.match(e.message, /Invalid API key/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1, 'must not call verify after generate_link failed');
});

test('generate_link malformed JSON is reported, not thrown raw', async () => {
  const { run } = mint([res(200, '<html>502 Bad Gateway</html>', { json: false })]);
  await assert.rejects(run, (e) => {
    assert.ok(e instanceof SmokeSessionError, `expected SmokeSessionError, got ${e?.name}`);
    assert.equal(e.step, 'generate_link');
    assert.match(e.message, /non-JSON body/);
    assert.match(e.message, /502 Bad Gateway/);
    return true;
  });
});

test('generate_link 200 without hashed_token is reported', async () => {
  const { fetchImpl, run } = mint([linkOk({ hashed_token: undefined }), res(200, SESSION)]);
  await assert.rejects(run, (e) => {
    assert.equal(e.step, 'generate_link');
    assert.match(e.message, /no usable "hashed_token"/);
    assert.match(e.message, /verification_type/, 'should list the keys it did get');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

// --------------------------------------------------------- 9-12. verify errors
test('verify non-2xx names the step, status and body', async () => {
  const { run } = mint([linkOk(), res(403, { error_code: 'otp_expired', msg: 'Token has expired' })]);
  await assert.rejects(run, (e) => {
    assert.equal(e.step, 'verify');
    assert.match(e.message, /^verify: /);
    assert.match(e.message, /HTTP 403/);
    assert.match(e.message, /otp_expired/);
    return true;
  });
});

test('verify malformed JSON is reported, not thrown raw', async () => {
  const { run } = mint([linkOk(), res(200, 'not json at all', { json: false })]);
  await assert.rejects(run, (e) => {
    assert.ok(e instanceof SmokeSessionError, `expected SmokeSessionError, got ${e?.name}`);
    assert.equal(e.step, 'verify');
    assert.match(e.message, /non-JSON body/);
    return true;
  });
});

test('verify 200 without access_token is reported', async () => {
  // GoTrue's single-confirmation shape, and anything else token-less.
  const { run } = mint([linkOk(), res(200, { msg: 'Confirmation link accepted...', code: '200' })]);
  await assert.rejects(run, (e) => {
    assert.equal(e.step, 'verify');
    assert.match(e.message, /no "access_token"/);
    assert.match(e.message, /type=magiclink/);
    return true;
  });
});

test('verify 200 with access_token but no refresh_token is reported', async () => {
  const { run } = mint([linkOk(), res(200, { ...SESSION, refresh_token: undefined })]);
  await assert.rejects(run, (e) => {
    assert.equal(e.step, 'verify');
    assert.match(e.message, /no "refresh_token"/);
    return true;
  });
});

// --------------------------------------------------------- 13. fetch rejection
test('a fetch rejection (network / timeout) is reported with its step', async () => {
  const { run } = mint([() => { throw new Error('The operation was aborted due to timeout'); }]);
  await assert.rejects(run, (e) => {
    assert.ok(e instanceof SmokeSessionError);
    assert.equal(e.step, 'generate_link');
    assert.match(e.message, /request failed/);
    assert.match(e.message, /aborted due to timeout/);
    return true;
  });
});

// ------------------------------------------------------------- 14. LEAK PROOF
test('no part of the service-role key can reach a thrown message or any log line', async () => {
  const SENTINEL = 'sb_secret_SENTINEL_LEAK_CANARY_0123456789abcdef';

  // Every hostile shape at once: the key echoed inside a JSON error body, a
  // non-JSON body, and a thrown network error message (fetch implementations
  // do put the request URL/headers into some error messages).
  const hostile = [
    () => res(400, { msg: `rejected apikey=${SENTINEL}`, hint: SENTINEL }),
    () => res(502, `upstream refused Authorization: Bearer ${SENTINEL}`, { json: false }),
    () => { throw new Error(`connect ECONNREFUSED while sending apikey ${SENTINEL}`); },
    // key leaks out of a *successful* generate_link into the verify failure
    () => res(200, { hashed_token: 'tok', verification_type: 'magiclink', debug: SENTINEL }),
  ];

  const logged = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));

  const thrown = [];
  try {
    for (const first of hostile) {
      // once as the generate_link response, once with generate_link OK and
      // the hostile response coming back from verify
      for (const queue of [[first], [linkOk(), first]]) {
        try {
          await mintServiceRoleSession({
            sbUrl: SB, serviceKey: SENTINEL, email: EMAIL, fetchImpl: stubFetch(queue),
          });
        } catch (e) {
          thrown.push(String(e?.message ?? ''), String(e?.stack ?? ''));
        }
      }
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }

  assert.ok(thrown.length >= 6, `expected several failures to inspect, got ${thrown.length / 2}`);

  for (const text of thrown) {
    assert.doesNotMatch(text, new RegExp(SENTINEL), `sentinel leaked into: ${text.slice(0, 300)}`);
    // Also assert on a distinctive fragment, so a partial echo cannot pass.
    assert.ok(!text.includes('SENTINEL_LEAK_CANARY'), `sentinel fragment leaked into: ${text.slice(0, 300)}`);
  }
  for (const line of logged) {
    assert.ok(!line.includes('SENTINEL_LEAK_CANARY'), `sentinel leaked into a log line: ${line.slice(0, 300)}`);
  }
  // Sanity: at least one of those messages did quote the response body, so the
  // assertions above are exercising real redaction and not an empty string.
  assert.ok(
    thrown.some((t) => t.includes('[REDACTED]')),
    'expected at least one message to show the redaction marker in place of the key',
  );
});

test('the session module cannot log anything, and the broken password grant is gone', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

  // The module holds the service-role key in a local. The cheapest structural
  // guarantee that it cannot print it is that it does not print at all: the
  // caller owns all output.
  const mod = readFileSync(join(root, 'scripts/lib/smoke_session.mjs'), 'utf8');
  const code = mod.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /console\s*\./, 'smoke_session.mjs must not write to the console');
  assert.doesNotMatch(code, /process\s*\.\s*(stdout|stderr)/, 'smoke_session.mjs must not write to stdout/stderr');
  // It must not read the key itself either -- the caller injects it, so there
  // is exactly one place the key enters the program.
  assert.doesNotMatch(code, /process\s*\.\s*env/, 'smoke_session.mjs must take the key as an argument');

  // Regression guard: step 3b must not drift back to the captcha-gated grant.
  const smoke = readFileSync(join(root, 'scripts/smoke_staging.mjs'), 'utf8');
  const smokeCode = smoke.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(smokeCode, /grant_type=password/, 'the password grant cannot work with Supabase Auth captcha on');
  assert.match(smoke, /mintServiceRoleSession/);
  // And the key must enter the script in exactly one way.
  const reads = [...smoke.matchAll(/SUPABASE_SERVICE_ROLE_KEY/g)].length;
  const envReads = [...smoke.matchAll(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/g)].length;
  assert.equal(envReads, 1, 'expected exactly one process.env read of the service-role key');
  assert.ok(reads >= envReads);
});

// ----------------------------------------------------------- 15. redactSecret
test('redactSecret removes every occurrence', () => {
  assert.equal(redactSecret('a KEY b KEY c', 'KEY_LONG_ENOUGH'), 'a KEY b KEY c');
  assert.equal(redactSecret('a SUPER_SECRET_VALUE b SUPER_SECRET_VALUE', 'SUPER_SECRET_VALUE'), 'a [REDACTED] b [REDACTED]');
});

test('redactSecret ignores secrets too short to redact safely', () => {
  // A 1-2 char "secret" would otherwise shred the whole message.
  assert.equal(redactSecret('status 400 code 4', '4'), 'status 400 code 4');
  assert.equal(redactSecret('abcdefg x', 'abcdefg'), 'abcdefg x');
  assert.equal(redactSecret('abcdefgh x', 'abcdefgh'), '[REDACTED] x');
});

test('redactSecret tolerates nullish input', () => {
  assert.equal(redactSecret(undefined, 'a_long_enough_secret'), '');
  assert.equal(redactSecret(null, 'a_long_enough_secret'), '');
  assert.equal(redactSecret('x', undefined), 'x');
});
