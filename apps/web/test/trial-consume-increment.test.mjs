// consumeTrialInTx (lib/trial.ts) spends EXACTLY one trial song per call.
//
// Why this file exists: the mutant `SET songs_used = songs_used + 1` → `+ 2`
// survived the whole apps/web suite (qa-findings; re-confirmed by the W2
// overnight mutation run on 602d0ce: 1543 tests, 0 failures with the mutant
// in place). Every route test stubs lib/trial.ts out, and the worker's
// tests/test_trial_grants.py asserts against its OWN copy of the SQL, so it
// cannot see a change to trial.ts. Nothing pinned the increment.
//
// Instrument: the real trial.ts runs; only the database is replaced by a fake
// that INTERPRETS the UPDATE it issues. The increment, the cap guard's
// operator and literal are all READ OUT OF THE STATEMENT, not reimplemented,
// so mutating any of them in trial.ts changes what the fake does. The
// trial_grants CHECK (songs_used BETWEEN 0 AND 3, migration 013) is enforced,
// as Postgres would. An unrecognised statement throws.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const USER = '22222222-2222-2222-2222-222222222222';
const DAY = 24 * 3600 * 1000;

const cmp = (op, a, b) =>
  op === '<=' ? a <= b : op === '<' ? a < b : op === '>=' ? a >= b : op === '>' ? a > b : a === b;

function fakeClient(state) {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/pg_advisory_xact_lock/.test(s)) {
        state.locks.push(params);
        return { rows: [{}], rowCount: 1 };
      }
      if (/^UPDATE public\.trial_grants/.test(s)) {
        const inc = /SET songs_used = songs_used \+ (\d+)/.exec(s);
        const cap = /AND songs_used\s*(<=|<|>=|>|=)\s*(\d+)/.exec(s);
        const exp = /AND expires_at\s*(<=|<|>=|>)\s*now\(\)/.exec(s);
        if (!inc || !cap || !exp) throw new Error('fake db: unrecognised trial UPDATE: ' + s.slice(0, 160));
        const row = state.rows[params[0]];
        if (!row) return { rows: [], rowCount: 0 };
        if (!cmp(cap[1], row.songs_used, Number(cap[2]))) return { rows: [], rowCount: 0 };
        if (!cmp(exp[1], Date.parse(row.expires_at), Date.now())) return { rows: [], rowCount: 0 };
        const next = row.songs_used + Number(inc[1]);
        if (next < 0 || next > 3) {
          throw new Error('new row for relation "trial_grants" violates check constraint "trial_grants_songs_used_check"');
        }
        row.songs_used = next;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/^SELECT user_id, granted_at, songs_used, expires_at FROM public\.trial_grants/.test(s)) {
        const row = state.rows[params[0]];
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error('fake db: unrecognised SQL: ' + s.slice(0, 120));
    },
  };
}

const dbStub = dataUrl(`export const db = { query: async () => { throw new Error('use the tx client'); },
  tx: async (fn) => fn(globalThis.__trialClient) };`);
const trial = await import(
  dataUrl(
    toJs(readFileSync(join(WEB, 'src', 'lib', 'trial.ts'), 'utf8')).replace(
      /from ['"]@\/lib\/db['"]/g,
      `from '${dbStub}'`,
    ),
  )
);

let state;
const seed = (songsUsed, expiresInMs = 7 * DAY) => {
  state = {
    locks: [],
    rows: {
      [USER]: {
        user_id: USER,
        granted_at: new Date().toISOString(),
        songs_used: songsUsed,
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      },
    },
  };
  globalThis.__trialClient = fakeClient(state);
};
beforeEach(() => seed(0));

test('one consume spends exactly one song: songs_used 0 -> 1, 2 remaining', async () => {
  const r = await trial.consumeTrialInTx(globalThis.__trialClient, USER);
  assert.deepEqual({ ok: r.ok, songs_remaining: r.songs_remaining }, { ok: true, songs_remaining: 2 });
  assert.equal(state.rows[USER].songs_used, 1);
});

test('a fresh trial serves exactly TRIAL_SONG_CAP (3) songs, then refuses as exhausted', async () => {
  const out = [];
  for (let i = 0; i < 4; i++) out.push(await trial.consumeTrial(USER));
  assert.deepEqual(
    out.map((r) => (r.ok ? `ok:${r.songs_remaining}` : `no:${r.reason}`)),
    ['ok:2', 'ok:1', 'ok:0', 'no:exhausted'],
  );
  assert.equal(state.rows[USER].songs_used, 3);
});

test('the last song is served: songs_used 2 -> 3', async () => {
  seed(2);
  const r = await trial.consumeTrialInTx(globalThis.__trialClient, USER);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(state.rows[USER].songs_used, 3);
});

test('every consume takes the per-user trial_consume lock first', async () => {
  await trial.consumeTrial(USER);
  assert.deepEqual(state.locks, [['trial_consume', USER]]);
});
