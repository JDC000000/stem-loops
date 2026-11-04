// /account/reset-password API contract tests — V3 Phase 1a.
//
// Covers both halves of the reset flow:
//   • POST /api/auth/reset-password-request
//       - valid email → calls resetPasswordForEmail with redirectTo pointing
//         at /auth/callback?type=recovery&next=/account/reset-password
//       - invalid email → 400 inline error (no Supabase call)
//       - supabase error → still 200 ok:true (anti-enumeration) + Sentry capture
//   • POST /api/auth/reset-password-confirm
//       - short/weak password → 400 inline error
//       - no session (unauth) → 401 + no updateUser call
//       - valid password + session → 200 + updateUser called with the password
//   • Shared validator (password-rules.ts)
//       - the exported min length matches the brief (10)
//       - validatePassword enforces length + letter + digit + trim rules
//       - validateEmail accepts plausible addresses, rejects obvious junk

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQ_SRC = join(WEB, 'src/app/api/auth/reset-password-request/route.ts');
const CFM_SRC = join(WEB, 'src/app/api/auth/reset-password-confirm/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Real password-rules — transpile once, reuse across routes.
const rulesUrl = dataUrl(
  toJs(readFileSync(join(WEB, 'src/lib/auth/password-rules.ts'), 'utf8')),
);

function nextStub() {
  return dataUrl(`
    export class NextResponse {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.headers = new Map(Object.entries(init.headers ?? {}));
      }
      static json(body, init = {}) {
        return new NextResponse(body, init);
      }
    }
  `);
}

function sentryStub() {
  return dataUrl(`
    globalThis.__sentryCaptures = [];
    export function captureException(err, ctx) {
      globalThis.__sentryCaptures.push({
        message: err?.message ?? String(err),
        tags: ctx?.tags,
      });
    }
  `);
}

// Unified supabase stub: scripts both resetPasswordForEmail and updateUser
// return values, and records every call. getUser() returns the scripted user
// (null for unauthenticated-confirm tests).
function supabaseStub({ resetResult = { error: null }, updateResult = { error: null }, user = null } = {}) {
  return dataUrl(`
    globalThis.__supabaseCalls = { resetPasswordForEmail: [], updateUser: [], getUser: 0 };
    export async function createServerClient() {
      return {
        auth: {
          resetPasswordForEmail: async (email, opts) => {
            globalThis.__supabaseCalls.resetPasswordForEmail.push({ email, opts });
            return ${JSON.stringify(resetResult)};
          },
          updateUser: async (attrs) => {
            globalThis.__supabaseCalls.updateUser.push(attrs);
            return ${JSON.stringify(updateResult)};
          },
        },
      };
    }
    export async function getUser() {
      globalThis.__supabaseCalls.getUser += 1;
      return ${JSON.stringify(user)};
    }
  `);
}

async function loadRoute(src, opts) {
  let js = toJs(readFileSync(src, 'utf8'));
  js = js
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabaseStub(opts)}'`)
    .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rulesUrl}'`);
  globalThis.__supabaseCalls = { resetPasswordForEmail: [], updateUser: [], getUser: 0 };
  globalThis.__sentryCaptures = [];
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeReq(url, body) {
  return {
    nextUrl: new URL(url),
    json: async () => body,
  };
}

// ---------- password-rules.ts ----------

test('password-rules: PASSWORD_MIN_LENGTH is 10', async () => {
  const rules = await import(rulesUrl);
  assert.equal(rules.PASSWORD_MIN_LENGTH, 10);
});

test('password-rules: validatePassword enforces all rules', async () => {
  const { validatePassword } = await import(rulesUrl);
  assert.equal(validatePassword(undefined), 'Enter a password.');
  assert.equal(validatePassword(''), 'Enter a password.');
  assert.match(validatePassword('short1a'), /at least 10/);
  assert.match(validatePassword('nolettersnumbers'), /digit/);
  assert.match(validatePassword('1234567890'), /letter/);
  assert.match(validatePassword(' trailingspace1 '), /space/);
  assert.equal(validatePassword('correcthorse1battery'), null);
});

test('password-rules: validateEmail accepts plausible addresses and rejects junk', async () => {
  const { validateEmail } = await import(rulesUrl);
  assert.equal(validateEmail('alice@example.com'), null);
  assert.equal(validateEmail('  bob+tag@stem-loops.co.uk  '), null);
  assert.match(validateEmail(''), /Enter your email/);
  assert.match(validateEmail('nope'), /valid email/);
  assert.match(validateEmail('a@b'), /valid email/);
  assert.match(validateEmail('a @ b.com'), /valid email/);
});

// ---------- /api/auth/reset-password-request ----------

test('reset-password-request: valid email → calls resetPasswordForEmail with the right redirectTo', async () => {
  const mod = await loadRoute(REQ_SRC, { resetResult: { error: null } });
  const res = await mod.POST(
    makeReq('https://stem-loops.com/api/auth/reset-password-request', {
      email: 'alice@example.com',
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(globalThis.__supabaseCalls.resetPasswordForEmail.length, 1);
  const [call] = globalThis.__supabaseCalls.resetPasswordForEmail;
  assert.equal(call.email, 'alice@example.com');
  // redirectTo must point at the callback with type=recovery and next
  // pointing at /account/reset-password. The URL constructor leaves "/"
  // unescaped inside the query string; that's fine — the callback route
  // runs sanitizeReturnTo on the eventual `?next=` regardless.
  const target = new URL(call.opts.redirectTo);
  assert.equal(target.origin, 'https://stem-loops.com');
  assert.equal(target.pathname, '/auth/callback');
  assert.equal(target.searchParams.get('type'), 'recovery');
  assert.equal(target.searchParams.get('next'), '/account/reset-password');
});

test('reset-password-request: invalid email → 400 inline error, no Supabase call', async () => {
  const mod = await loadRoute(REQ_SRC);
  for (const bad of ['', 'nope', null, undefined, 'a@b']) {
    const res = await mod.POST(
      makeReq('https://stem-loops.com/api/auth/reset-password-request', { email: bad }),
    );
    assert.equal(res.status, 400, `bad=${bad}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error_code, 'RESET_INVALID_EMAIL');
    assert.equal(typeof res.body.message, 'string');
  }
  assert.equal(globalThis.__supabaseCalls.resetPasswordForEmail.length, 0);
});

test('reset-password-request: supabase error → still 200 ok:true + Sentry capture (anti-enumeration)', async () => {
  const mod = await loadRoute(REQ_SRC, {
    resetResult: { error: { name: 'AuthApiError', message: 'rate limit exceeded' } },
  });
  const res = await mod.POST(
    makeReq('https://stem-loops.com/api/auth/reset-password-request', {
      email: 'alice@example.com',
    }),
  );
  // Must NOT leak the Supabase error to the client.
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(globalThis.__sentryCaptures.length, 1);
  assert.equal(
    globalThis.__sentryCaptures[0].tags?.route,
    'api/auth/reset-password-request',
  );
});

test('reset-password-request: malformed JSON body → 400 (not 500)', async () => {
  const mod = await loadRoute(REQ_SRC);
  const req = {
    nextUrl: new URL('https://stem-loops.com/api/auth/reset-password-request'),
    json: async () => { throw new SyntaxError('bad json'); },
  };
  const res = await mod.POST(req);
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'RESET_INVALID_EMAIL');
});

// ---------- /api/auth/reset-password-confirm ----------

test('reset-password-confirm: short password → 400 inline error, no updateUser', async () => {
  const mod = await loadRoute(CFM_SRC, {
    user: { user_id: 'u1', email: 'alice@example.com' },
  });
  const res = await mod.POST(
    makeReq('https://stem-loops.com/api/auth/reset-password-confirm', {
      password: 'short',
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'RESET_INVALID_PASSWORD');
  assert.match(res.body.message, /at least 10/);
  assert.equal(globalThis.__supabaseCalls.updateUser.length, 0);
});

test('reset-password-confirm: password missing letter or digit → 400', async () => {
  const mod = await loadRoute(CFM_SRC, {
    user: { user_id: 'u1', email: 'alice@example.com' },
  });
  for (const bad of ['alllettersnotenoughchars', '1234567890123']) {
    const res = await mod.POST(
      makeReq('https://stem-loops.com/api/auth/reset-password-confirm', { password: bad }),
    );
    assert.equal(res.status, 400, `bad=${bad}`);
    assert.equal(res.body.error_code, 'RESET_INVALID_PASSWORD');
  }
});

test('reset-password-confirm: no session → 401, no updateUser call', async () => {
  const mod = await loadRoute(CFM_SRC, { user: null });
  const res = await mod.POST(
    makeReq('https://stem-loops.com/api/auth/reset-password-confirm', {
      password: 'correcthorse1battery',
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(res.body.error_code, 'UNAUTHENTICATED');
  assert.equal(globalThis.__supabaseCalls.updateUser.length, 0);
});

test('reset-password-confirm: valid password + session → 200 + updateUser called', async () => {
  const mod = await loadRoute(CFM_SRC, {
    user: { user_id: 'u1', email: 'alice@example.com' },
    updateResult: { error: null },
  });
  const res = await mod.POST(
    makeReq('https://stem-loops.com/api/auth/reset-password-confirm', {
      password: 'correcthorse1battery',
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(globalThis.__supabaseCalls.updateUser, [
    { password: 'correcthorse1battery' },
  ]);
});

test('reset-password-confirm: supabase updateUser error → 400 + Sentry capture (no raw message leaked)', async () => {
  const mod = await loadRoute(CFM_SRC, {
    user: { user_id: 'u1', email: 'alice@example.com' },
    updateResult: { error: { name: 'AuthApiError', message: 'password previously compromised in a data breach' } },
  });
  const res = await mod.POST(
    makeReq('https://stem-loops.com/api/auth/reset-password-confirm', {
      password: 'correcthorse1battery',
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'RESET_INVALID_PASSWORD');
  assert.ok(!/breach/i.test(res.body.message), 'leaked raw supabase error to the client');
  assert.equal(globalThis.__sentryCaptures.length, 1);
  assert.equal(
    globalThis.__sentryCaptures[0].tags?.route,
    'api/auth/reset-password-confirm',
  );
});
