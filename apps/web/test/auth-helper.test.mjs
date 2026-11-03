// Auth helper contract test — V3 Phase 1a (TSD §2.1 / V3-U1).
//
// Goal: verify that `getUser()` returns the shape WE claim
// (`AuthenticatedUser = { user_id, email, display_name? }`), not the
// shape of the underlying Supabase `User` (which has ~20 fields:
// `app_metadata`, `aud`, `created_at`, `identities`, `phone`, ...).
// That contract is the whole point of `lib/auth/supabase.ts`: a stable
// surface downstream agents build against regardless of IdP.
//
// How it runs: this is `.mjs` and lives under `apps/web/test/` which is
// a `node --test` directory per `package.json`. We compile the TS source
// in-memory with the already-installed `typescript` dep (same pattern as
// sentry-guard.test.mjs), stubbing the `@supabase/ssr` import with a
// data-URL module, so no real Supabase client is constructed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/lib/auth/supabase.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Minimal stand-in for `createServerClient` — the real SDK's shape
// matters only in that `supabase.auth.getUser()` must return a
// `{ data: { user }, error }` object.
function stubSsrModule(userResult) {
  return dataUrl(`
    export function createBrowserClient() { return { __browser: true }; }
    export function createServerClient(_url, _key, _opts) {
      return {
        auth: {
          getUser: async () => (${JSON.stringify(userResult)}),
        },
      };
    }
  `);
}

function stubNextHeadersModule() {
  return dataUrl(`
    export function cookies() {
      return {
        getAll() { return []; },
        set() {},
      };
    }
  `);
}

// Rewrite the TS source so imports resolve to our stubs (we're running
// outside Next, so `@supabase/ssr` and `next/headers` can't be loaded
// normally and we don't WANT them to be — that's the point of the mock).
async function loadAuthModule({ userResult }) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  const ssrStub = stubSsrModule(userResult);
  const headersStub = stubNextHeadersModule();
  js = js
    .replace(/from ['"]@supabase\/ssr['"]/g, `from '${ssrStub}'`)
    // The server client lazy-imports `next/headers` via a template-like
    // `await import('next/headers')` — rewrite that string too.
    .replace(/import\(['"]next\/headers['"]\)/g, `import('${headersStub}')`);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  // Cache-bust so each test gets a fresh module graph.
  return await import(dataUrl(js) + '#' + Math.random());
}

test('getUser() returns { user_id, email } when supabase returns a user with no display name metadata', async () => {
  const mod = await loadAuthModule({
    userResult: {
      data: {
        user: {
          id: '11111111-1111-1111-1111-111111111111',
          email: 'alice@example.com',
          user_metadata: {},
          app_metadata: { provider: 'email', secret_internal_field: 'leak-me-if-you-can' },
          aud: 'authenticated',
          created_at: '2026-11-03T00:00:00Z',
        },
      },
      error: null,
    },
  });
  const user = await mod.getUser();
  assert.deepEqual(user, {
    user_id: '11111111-1111-1111-1111-111111111111',
    email: 'alice@example.com',
  });
  // Contract: NO Supabase internals in the returned object.
  assert.equal(user.app_metadata, undefined);
  assert.equal(user.aud, undefined);
  assert.equal(user.created_at, undefined);
  assert.equal(user.identities, undefined);
  assert.equal(user.secret_internal_field, undefined);
});

test('getUser() picks display_name from user_metadata.name (Google OAuth shape)', async () => {
  const mod = await loadAuthModule({
    userResult: {
      data: {
        user: {
          id: '22222222-2222-2222-2222-222222222222',
          email: 'bob@example.com',
          user_metadata: { name: 'Bob Smith', avatar_url: 'https://cdn/example.png' },
        },
      },
      error: null,
    },
  });
  const user = await mod.getUser();
  assert.deepEqual(user, {
    user_id: '22222222-2222-2222-2222-222222222222',
    email: 'bob@example.com',
    display_name: 'Bob Smith',
  });
  // avatar_url and other metadata must not leak.
  assert.equal(user.avatar_url, undefined);
  assert.equal(user.user_metadata, undefined);
});

test('getUser() falls back to user_metadata.full_name when name is absent', async () => {
  const mod = await loadAuthModule({
    userResult: {
      data: {
        user: {
          id: '33333333-3333-3333-3333-333333333333',
          email: 'carol@example.com',
          user_metadata: { full_name: 'Carol Danvers' },
        },
      },
      error: null,
    },
  });
  const user = await mod.getUser();
  assert.equal(user.display_name, 'Carol Danvers');
});

test('getUser() returns null when supabase reports an auth error', async () => {
  const mod = await loadAuthModule({
    userResult: {
      data: { user: null },
      error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
    },
  });
  const user = await mod.getUser();
  assert.equal(user, null);
});

test('getUser() returns null when supabase returns no user', async () => {
  const mod = await loadAuthModule({
    userResult: { data: { user: null }, error: null },
  });
  const user = await mod.getUser();
  assert.equal(user, null);
});

test('getUser() returns null when the user has no email (phone-only signup — unsupported in V3)', async () => {
  const mod = await loadAuthModule({
    userResult: {
      data: {
        user: {
          id: '44444444-4444-4444-4444-444444444444',
          email: null,
          phone: '+15555555555',
          user_metadata: {},
        },
      },
      error: null,
    },
  });
  const user = await mod.getUser();
  assert.equal(user, null);
});

test('AuthenticatedUser type keeps the exported shape stable', async () => {
  // This is a type-side contract check. Read the types source and assert
  // the surface hasn't drifted — downstream agents are coding against
  // exactly these three fields.
  const typesSrc = readFileSync(join(WEB, 'src/lib/auth/types.ts'), 'utf8');
  assert.match(typesSrc, /user_id:\s*string/);
  assert.match(typesSrc, /email:\s*string/);
  assert.match(typesSrc, /display_name\?:\s*string/);
  // No Supabase imports leaked into the public types.
  assert.doesNotMatch(typesSrc, /@supabase/);
});
