// #494 item 4 against a REAL Postgres: the REAL lib/admission.ts counters on upload_rate_events
// and the REAL lib/jobs/stem-artifacts.ts probe (only R2 stubbed). The paste probe and the
// player's GET /api/jobs/:id/stems no longer share one per-IP budget:
//   (a) the player's budget used up (checkStemListRate refuses) → the probe still lists R2 and
//       answers false for an encode-failed job (it used to answer null → reuse the broken job);
//   (b) the probe's budget used up → the probe answers null (reuse, never a new charge) while
//       the player's budget is untouched (it used to 429 the stems GET).
// Skips locally without a LOCAL DATABASE_URL and FAILS under CI=true.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { buildModuleGraph } from './helpers/module-graph.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(WEB, 'package.json'));

const DB_URL = process.env.DATABASE_URL;
let skip = false;
if (!DB_URL) skip = 'DATABASE_URL not set';
else {
  const host = new URL(DB_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', ''].includes(host)) skip = `DATABASE_URL host ${host} is not local`;
}
if (skip && process.env.CI) throw new Error(`CI=true but ${skip}`);

let pool, adm, sa;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 4 });
  globalThis.__ppPool = pool;
  process.env.STEM_LIST_RATE_LIMIT = '3';
  process.env.PASTE_PROBE_RATE_LIMIT = '2';
  const graph = buildModuleGraph({
    name: 'paste-probe-rate-pg',
    entries: ['lib/admission.ts', 'lib/jobs/stem-artifacts.ts'],
    overrides: {
      'lib/db.ts': `export const db = {
        query: (t, p) => globalThis.__ppPool.query(t, p),
        tx: async (fn) => { const c = await globalThis.__ppPool.connect();
          try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
          catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } } };`,
      'lib/r2.ts': `export const r2 = { send: async (cmd) => { (globalThis.__ppLists ??= []).push(cmd.input.Prefix);
        return { Contents: (globalThis.__ppKeys ?? []).map((Key) => ({ Key })), IsTruncated: false }; } };`,
    },
  });
  adm = await import(graph.url('lib/admission.ts'));
  sa = await import(graph.url('lib/jobs/stem-artifacts.ts'));
}
after(async () => {
  if (pool) {
    await pool.query(`DELETE FROM upload_rate_events WHERE client_ip_hash LIKE 'stems:pp-%' OR client_ip_hash LIKE 'paste-probe:pp-%'`);
    await pool.end();
  }
});

const JOB = randomUUID();
const ENCODE_FAILED = [`${JOB}/_stems/dl/drums.wav`, `${JOB}/drums/4bar_verse_0001.wav`];
const rows = async (key) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM upload_rate_events WHERE client_ip_hash = $1', [key])).rows[0].n;

test('(a) the player used up its stems budget → the probe still answers (false for an encode failure)', { skip }, async () => {
  const ip = `pp-${randomUUID()}`;
  for (let i = 0; i < 3; i++) assert.equal((await adm.checkStemListRate(ip)).allowed, true);
  assert.equal((await adm.checkStemListRate(ip)).allowed, false, 'the player budget is spent');
  globalThis.__ppKeys = ENCODE_FAILED;
  globalThis.__ppLists = [];
  assert.equal(await sa.hasPlayableStems(JOB, () => ip), false, 'not null: the encode failure is seen');
  assert.deepEqual(globalThis.__ppLists, [`${JOB}/`]);
  assert.equal(await rows(`stems:${ip}`), 3, 'the probe wrote no player-budget row');
  assert.equal(await rows(`paste-probe:${ip}`), 1);
});

test('(b) the probe used up its own budget → null (reuse), and the player budget is untouched', { skip }, async () => {
  const ip = `pp-${randomUUID()}`;
  globalThis.__ppKeys = ENCODE_FAILED;
  globalThis.__ppLists = [];
  assert.equal(await sa.hasPlayableStems(JOB, () => ip), false);
  assert.equal(await sa.hasPlayableStems(JOB, () => ip), false);
  assert.equal(await sa.hasPlayableStems(JOB, () => ip), null, 'third probe in the minute: could not tell');
  assert.equal(globalThis.__ppLists.length, 2, 'a refused probe lists nothing (cost bound: 2 lists/min/IP here)');
  assert.equal(await rows(`paste-probe:${ip}`), 2);
  assert.equal(await rows(`stems:${ip}`), 0);
  for (let i = 0; i < 3; i++) assert.equal((await adm.checkStemListRate(ip)).allowed, true, 'the stems GET still admitted');
});
