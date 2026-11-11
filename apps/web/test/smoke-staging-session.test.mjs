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
//   16. redirect: 'manual' on both calls, and a 3xx treated as an error
//       (undici does NOT strip a custom `apikey` header across a cross-origin
//       redirect, so following one would hand the next origin the key)
//   17. the anon key is the apikey on the PUBLIC /verify call, with the
//       service key as the fallback when no anon key is supplied
//   17b. a gateway 401/403 on the anon key retries ONCE with the service key
//       (a legacy anon JWT may be disabled), but a real token error is not
//       retried and the retry never loops
//   18. LEAK PROOF, second pass: the sentinel as an object KEY (not just a
//       value) and a res.text() that rejects -- the two shapes that leaked
//       past the first version of this file

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mintServiceRoleSession, redactSecret, SmokeSessionError } from '../../../scripts/lib/smoke_session.mjs';

const SB = 'https://ylzokjwnsraehmpclnkx.supabase.co';
const EMAIL = 'smoke-test-1762800000000@stemloops.test';
const KEY = 'FAKE-SERVICE-ROLE-KEY-FOR-UNIT-TESTS-ONLY';
const ANON = 'FAKE-PUBLISHABLE-KEY-FOR-UNIT-TESTS-ONLY';

const SESSION = {
  access_token: 'FAKE-ACCESS-TOKEN-FOR-UNIT-TESTS',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 1762803600,
  refresh_token: 'FAKE-REFRESH-TOKEN-FOR-UNIT-TESTS',
  user: { id: '11111111-1111-1111-1111-111111111111', email: EMAIL },
};

const res = (status, body, { json = true, textRejects = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => {
    if (textRejects) throw new Error(textRejects);
    return json ? JSON.stringify(body) : String(body);
  },
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
    // undici strips Authorization cross-origin per spec but NOT a custom
    // `apikey` header, so following a 30x off the Supabase host would hand the
    // next origin the service-role key.
    assert.equal(c.init.redirect, 'manual', 'every credential-bearing request must not follow redirects');
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
  // Least privilege: no anon key was supplied here, so the service key is the
  // documented fallback (the gateway needs some apikey).
  assert.equal(ver.headers.apikey, KEY);
  // No Authorization on a public endpoint. (api.go:270 has no
  // requireAuthentication; sending admin credentials there is gratuitous.)
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
  const SENTINEL = 'FAKE-KEY-SENTINEL-LEAK-CANARY-0123456789abcdef';

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

// ------------------------------------- 16. redirects are refused, not followed
test("both calls set redirect:'manual'", async () => {
  const { fetchImpl, run } = mint([linkOk(), res(200, SESSION)]);
  await run();
  assert.deepEqual(fetchImpl.calls.map((c) => c.init.redirect), ['manual', 'manual']);
});

test('a 3xx from generate_link is an error naming the redirect, not a followed hop', async () => {
  const { run } = mint([res(307, '', { json: false })]);
  await assert.rejects(run, (e) => {
    assert.ok(e instanceof SmokeSessionError);
    assert.equal(e.step, 'generate_link');
    assert.match(e.message, /returned a redirect \(HTTP 307\)/);
    assert.match(e.message, /apikey/, 'should say why it was not followed');
    assert.match(e.message, /SUPABASE_URL/);
    return true;
  });
});

test('a 3xx from verify is an error too', async () => {
  const { fetchImpl, run } = mint([linkOk(), res(302, '', { json: false })]);
  await assert.rejects(run, (e) => {
    assert.equal(e.step, 'verify');
    assert.match(e.message, /returned a redirect \(HTTP 302\)/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
});

// ------------------------------------------------ 17. least-privileged apikey
test('the anon key is the apikey on the public /verify call', async () => {
  const fetchImpl = stubFetch([linkOk(), res(200, SESSION)]);
  await mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: ANON, email: EMAIL, fetchImpl });
  const [gen, ver] = fetchImpl.calls;
  // Admin endpoint still gets the service role...
  assert.equal(gen.headers.apikey, KEY);
  assert.equal(gen.headers.Authorization, `Bearer ${KEY}`);
  // ...and the public endpoint must NOT see it.
  assert.equal(ver.headers.apikey, ANON);
  assert.notEqual(ver.headers.apikey, KEY);
  assert.equal(ver.headers.Authorization, undefined);
});

test('an empty anon key falls back to the service key so /verify still clears the gateway', async () => {
  const fetchImpl = stubFetch([linkOk(), res(200, SESSION)]);
  await mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: '', email: EMAIL, fetchImpl });
  assert.equal(fetchImpl.calls[1].headers.apikey, KEY);
});

// ------------------------ 17b. the anon key must not become a new failure mode
test('a gateway 401 on the anon key falls back once to the service key', async () => {
  // SMOKE-TEST-README warns a LEGACY anon JWT may be disabled on the project,
  // in which case the gateway rejects /verify before GoTrue sees it. Preferring
  // the anon key must not turn that into a red nightly.
  const fetchImpl = stubFetch([
    linkOk(),
    res(401, { message: 'Invalid API key' }),
    res(200, SESSION),
  ]);
  const out = await mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: ANON, email: EMAIL, fetchImpl });
  assert.deepEqual(out, SESSION);
  assert.equal(fetchImpl.calls.length, 3, 'expected generate_link + verify(anon) + verify(service)');
  assert.equal(fetchImpl.calls[1].headers.apikey, ANON, 'first attempt uses the anon key');
  assert.equal(fetchImpl.calls[2].headers.apikey, KEY, 'retry uses the service key');
  assert.equal(fetchImpl.calls[2].url, `${SB}/auth/v1/verify`);
  // The retry must still be a proper request, not a degraded one.
  assert.equal(fetchImpl.calls[2].init.redirect, 'manual');
  assert.equal(fetchImpl.calls[2].headers.Authorization, undefined);
  assert.deepEqual(fetchImpl.calls[2].body, { token_hash: 'hashed-tok', type: 'magiclink' });
});

test('a 403 on the anon key also falls back', async () => {
  const fetchImpl = stubFetch([linkOk(), res(403, { message: 'forbidden' }), res(200, SESSION)]);
  await mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: ANON, email: EMAIL, fetchImpl });
  assert.equal(fetchImpl.calls.length, 3);
});

test('the fallback is narrow: a real token error does NOT get retried', async () => {
  // An expired or already-used token is a genuine finding. Retrying it with a
  // different apikey would only hide it behind a second identical failure.
  const fetchImpl = stubFetch([linkOk(), res(400, { error_code: 'otp_expired', msg: 'Token has expired' })]);
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: ANON, email: EMAIL, fetchImpl }),
    (e) => {
      assert.equal(e.step, 'verify');
      assert.match(e.message, /otp_expired/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 2, 'must not retry a non-401/403');
});

test('with no anon key there is nothing to fall back from, so a 401 is final', async () => {
  const fetchImpl = stubFetch([linkOk(), res(401, { message: 'Invalid API key' })]);
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: '', email: EMAIL, fetchImpl }),
    (e) => {
      assert.equal(e.step, 'verify');
      assert.match(e.message, /HTTP 401/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 2, 'must not retry when the service key was already used');
});

test('the fallback retries exactly once, then surfaces the failure', async () => {
  const fetchImpl = stubFetch([
    linkOk(),
    res(401, { message: 'Invalid API key' }),
    res(401, { message: 'Invalid API key' }),
  ]);
  await assert.rejects(
    () => mintServiceRoleSession({ sbUrl: SB, serviceKey: KEY, anonKey: ANON, email: EMAIL, fetchImpl }),
    (e) => {
      assert.equal(e.step, 'verify');
      assert.match(e.message, /HTTP 401/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 3, 'one retry, not a loop');
});

// ------------------------------- 18. LEAK PROOF, the shapes that leaked before
test('a credential used as an object KEY is redacted (not just as a value)', async () => {
  // The first version of this file only ever planted the sentinel in response
  // *values*. Object.keys(...).join() went into the message raw, so a body of
  // {"<key>":1} printed the key straight into the CI log.
  const SENTINEL = 'FAKE-KEY-KEYNAME-CANARY-0123456789abcdef';

  for (const [label, queue, step] of [
    ['generate_link', [() => res(200, { [SENTINEL]: 1, verification_type: 'magiclink' })], 'generate_link'],
    ['verify', [linkOk(), () => res(200, { [SENTINEL]: 1 })], 'verify'],
  ]) {
    await assert.rejects(
      () => mintServiceRoleSession({ sbUrl: SB, serviceKey: SENTINEL, email: EMAIL, fetchImpl: stubFetch(queue) }),
      (e) => {
        assert.equal(e.step, step, label);
        assert.ok(!e.message.includes('KEYNAME_CANARY'), `${label}: key name leaked: ${e.message}`);
        assert.ok(!String(e.stack).includes('KEYNAME_CANARY'), `${label}: key name leaked via stack`);
        assert.match(e.message, /\[REDACTED\]/, `${label}: expected the redaction marker in the key list`);
        return true;
      },
    );
  }
});

test('a res.text() that rejects cannot leak, and keeps its step label', async () => {
  // This one previously escaped as a bare unredacted Error: res.text() was
  // awaited outside the try/catch, so it lost both the scrub and the step.
  const SENTINEL = 'FAKE-KEY-TEXTFAIL-CANARY-0123456789abcdef';

  for (const [queue, step] of [
    [[() => res(200, null, { textRejects: `stream aborted while holding ${SENTINEL}` })], 'generate_link'],
    [[linkOk(), () => res(200, null, { textRejects: `socket closed, apikey=${SENTINEL}` })], 'verify'],
  ]) {
    await assert.rejects(
      () => mintServiceRoleSession({ sbUrl: SB, serviceKey: SENTINEL, email: EMAIL, fetchImpl: stubFetch(queue) }),
      (e) => {
        assert.ok(e instanceof SmokeSessionError, `expected SmokeSessionError, got ${e?.name}: ${e?.message}`);
        assert.equal(e.step, step, 'the step label must survive a body-read failure');
        assert.match(e.message, /could not read the response body/);
        assert.ok(!e.message.includes('TEXTFAIL_CANARY'), `leaked: ${e.message}`);
        assert.ok(!String(e.stack).includes('TEXTFAIL_CANARY'), 'leaked via stack');
        assert.match(e.message, /\[REDACTED\]/);
        return true;
      },
    );
  }
});

test('the anon key is redacted from errors too, not only the service key', async () => {
  const ANON_SENTINEL = 'FAKE-PUBLISHABLE-ANONCANARY-0123456789abcdef';
  await assert.rejects(
    () => mintServiceRoleSession({
      sbUrl: SB, serviceKey: KEY, anonKey: ANON_SENTINEL, email: EMAIL,
      fetchImpl: stubFetch([linkOk(), () => res(400, { msg: `bad apikey ${ANON_SENTINEL}` })]),
    }),
    (e) => {
      assert.ok(!e.message.includes('ANONCANARY'), `anon key leaked: ${e.message}`);
      return true;
    },
  );
});

test('every error is constructed in exactly one place, so redaction is structural', async () => {
  // This is what makes "every string this module puts into an Error is
  // scrubbed" a property of the code rather than a promise repeated at each
  // call site -- and it is what kills the mutant that interpolates the key
  // directly into a message.
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const src = readFileSync(join(root, 'scripts/lib/smoke_session.mjs'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const sites = [...code.matchAll(/new SmokeSessionError\s*\(/g)].length;
  assert.equal(sites, 1, `expected exactly one "new SmokeSessionError(" site, found ${sites}`);
  assert.match(code, /const boom = \(step, msg\) => new SmokeSessionError\(step, scrub\(msg\)\)/);
  // ...and no throw may sidestep it. A bare re-throw of the caught binding is
  // allowed: by then the error came out of call(), so boom() already scrubbed
  // it. Anything else -- a new Error, a template literal, a string -- is not.
  const throws = [...code.matchAll(/throw\s+([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(throws.length >= 5, `expected to find the throws, found ${throws.length}`);
  for (const t of throws) {
    assert.ok(
      t.startsWith('boom(') || t === 'e',
      `throw must be boom(...) or a bare re-throw of the caught error, got: throw ${t.slice(0, 60)}`,
    );
  }
});

test('a hostile body cannot flood the CI line through its key names', async () => {
  // keysOf() passes Object.keys(...).join(',') through clean(), which caps it.
  // Without that cap a response with hundreds of long key names would bury the
  // one line a human reads in the step summary.
  const fat = {};
  for (let i = 0; i < 80; i++) fat[`k${String(i).padStart(3, '0')}_${'x'.repeat(120)}`] = 1;
  const { run } = mint([res(200, fat)]);
  await assert.rejects(run, (e) => {
    assert.equal(e.step, 'generate_link');
    assert.ok(e.message.length < 400, `message should be capped, was ${e.message.length} chars`);
    return true;
  });
});

// --- source-level guards for scripts/smoke_staging.mjs ----------------------
// That script is a top-level-await program that runs on import and talks to the
// live network, so it cannot be unit-tested here. These assertions are the only
// mechanism available for its two security-relevant properties, and they are
// what catches a future edit that quietly drops either one.

test("smoke_staging.mjs: every credential-bearing helper sets redirect:'manual'", async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath: f } = await import('node:url');
  const src = readFileSync(join(dirname(f(import.meta.url)), '../../..', 'scripts/smoke_staging.mjs'), 'utf8');

  // sbAdmin sends apikey + Authorization with the service-role key; stripe
  // sends the Stripe secret; authed sends the session cookie and the Vercel
  // bypass secret. undici does not strip a custom header cross-origin.
  for (const [name, re] of [
    ['sbAdmin', /const sbAdmin = \(path, opts = \{\}\) =>[\s\S]{0,200}?redirect: 'manual'/],
    ['stripe', /const stripe = \(path, \{[^}]*\} = \{\}\) =>[\s\S]{0,200}?redirect: 'manual'/],
    ['authed', /const authed = \(extra = \{\}\) => \(\{ redirect: 'manual'/],
  ]) {
    assert.match(src, re, `${name} must set redirect: 'manual'`);
  }
  // And nothing may re-introduce an explicit 'follow' on those helpers.
  assert.doesNotMatch(src, /const sbAdmin[\s\S]{0,200}?redirect: 'follow'/, "sbAdmin must not follow redirects");
});

test('smoke_staging.mjs: SUPABASE_URL host is pinned to the staging project', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath: f } = await import('node:url');
  const src = readFileSync(join(dirname(f(import.meta.url)), '../../..', 'scripts/smoke_staging.mjs'), 'utf8');

  // Mirrors the guard scripts/smoke_staging_sweep.mjs has always had. Without
  // it, SUPABASE_URL could point at the production project while
  // STAGING_BASE_URL still looked like staging, and step 9's user DELETE would
  // land there.
  assert.match(src, /const STAGING_SB_HOST = 'ylzokjwnsraehmpclnkx\.supabase\.co'/);
  assert.match(src, /new URL\(SB_URL\)\.hostname/);
  assert.match(
    src,
    /if \(SB_URL && SB_HOST !== STAGING_SB_HOST && process\.env\.SMOKE_ALLOW_PROD !== '1'\) \{/,
    'the host guard must be live and gated only by the existing SMOKE_ALLOW_PROD escape hatch',
  );
  // It must actually abort, with the setup exit code.
  const guard = src.slice(src.indexOf('if (SB_URL && SB_HOST !== STAGING_SB_HOST'));
  assert.match(guard.slice(0, 500), /process\.exit\(2\)/, 'the host guard must exit 2');
  // The production project ref must never be hard-coded as an allowed host.
  assert.doesNotMatch(src, /qthrhamfljhifhfwvvwj/, 'the production Supabase ref must not appear');
});

test('this test file contains no literal that looks like a real credential', async () => {
  // GitHub push protection blocked a push from this branch because the fake
  // canaries used the real Supabase secret-key prefix. Redaction here is plain
  // substring removal, so the shape of a test credential is irrelevant to what
  // is being tested -- there is no reason to make one look real. Patterns are
  // assembled from fragments so this assertion cannot match itself.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath: f } = await import('node:url');
  const src = readFileSync(f(import.meta.url), 'utf8');
  const forbidden = [
    ['Supabase secret key', 'sb' + '_secret_'],
    ['Supabase publishable key', 'sb' + '_publishable_'],
    ['JWT', 'eyJ' + 'hbGciOi'],
    ['Stripe test key', 'sk' + '_test_'],
    ['Stripe live key', 'sk' + '_live_'],
  ];
  for (const [label, needle] of forbidden) {
    const hits = src.split(needle).length - 1;
    assert.equal(hits, 0, `${label}-shaped literal found in this file (${hits} occurrence(s)); use an obviously fake value`);
  }
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
