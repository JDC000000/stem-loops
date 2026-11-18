// Slice 2a review S4 — the demo lookups against a REAL Postgres (all migrations applied).
//
// demo-songs.test.mjs checks the SQL TEXT through a fake; a mutant that kept the literal
// `is_demo = true` but widened it (`... OR left(id::text, 8) IN (<catalog prefixes>)`)
// survived it. This file runs the real statements of src/lib/demo-songs.ts on a real server,
// so what is checked is what Postgres returns: an ORDINARY job that shares a demo's 8-hex
// prefix is never served by any demo lookup.
//
// Database: DATABASE_URL (the CI "Tests" job provides one with every migration applied).
// Everything runs in ONE transaction that is rolled back. Without DATABASE_URL the file skips
// locally, and FAILS under CI (CI=true), so it cannot go quietly green there.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import pg from 'pg';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (rel) =>
  ts.transpileModule(readFileSync(join(WEB, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const URL_ = process.env.DATABASE_URL;
if (!URL_ && process.env.CI) {
  test('demo lookups on real Postgres need DATABASE_URL under CI', () => {
    assert.fail('DATABASE_URL is not set in CI: this real-Postgres check would not have run');
  });
}
const skip = URL_ ? false : 'DATABASE_URL not set (runs in CI "Tests")';

const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
// Same 8-hex prefix as Lucky Ticket's prod job (lib/demo-catalog.ts), different rows.
const ORDINARY = `9c5ba587-${rnd().slice(0, 4)}-4${rnd().slice(0, 3)}-8${rnd().slice(0, 3)}-${rnd()}${rnd().slice(0, 4)}`;
const DEMO = `9c5ba587-${rnd().slice(0, 4)}-4${rnd().slice(0, 3)}-9${rnd().slice(0, 3)}-${rnd()}${rnd().slice(0, 4)}`;

let client;
let ds;

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: URL_ });
  await client.connect();
  await client.query('BEGIN');
  // Any demo rows already in this database would muddy "nothing else is served": hide them
  // inside the transaction (rolled back at the end).
  await client.query('UPDATE jobs SET is_demo = false WHERE is_demo');
  globalThis.__pgClient = client;
  const db = dataUrl(`export const db = { query: (t, p) => globalThis.__pgClient.query(t, p) };`);
  const js = toJs('src/lib/demo-songs.ts')
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${dataUrl(toJs('src/lib/retention.ts'))}'`)
    .replace(/from ['"]@\/lib\/demo-catalog['"]/g, `from '${dataUrl(toJs('src/lib/demo-catalog.ts'))}'`);
  ds = await import(dataUrl(js));
});

after(async () => {
  if (!client) return;
  await client.query('ROLLBACK');
  await client.end();
});

beforeEach(() => ds?.clearDemoJobsCache());

const insert = (id, isDemo, createdAgo) =>
  client.query(
    `INSERT INTO jobs (id, loop_length_bars, client_ip_hash, status, youtube_url, is_demo, created_at, title)
     VALUES ($1::uuid, 4, 'pg-test', 'done', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', $2, now() - $3::interval, 'row ' || $1::text)`,
    [id, isDemo, createdAgo],
  );

test('an ORDINARY job sharing a demo prefix is never a demo: list, slug, id and page gate', { skip }, async () => {
  await insert(ORDINARY, false, '1 hour');
  const list = await ds.listDemoJobs();
  assert.deepEqual(list.map((d) => d.id), [], 'an ordinary job was listed as a demo');
  assert.equal(await ds.resolveDemo('lucky-ticket'), null, 'the catalog slug resolved to an ordinary job by prefix');
  assert.equal(await ds.resolveDemo(ORDINARY), null, 'an ordinary job id resolved as a demo');
  assert.equal(await ds.isDemoJob(ORDINARY), false, 'the page gate opened an ordinary job');
});

test('with a real demo of the same prefix, only the demo row is served (the older ordinary row is not)', { skip }, async () => {
  await insert(DEMO, true, '1 minute');
  const list = await ds.listDemoJobs();
  assert.deepEqual(list.map((d) => d.id), [DEMO]);
  assert.equal(list[0].slug, 'lucky-ticket');
  assert.equal((await ds.resolveDemo('lucky-ticket'))?.id, DEMO);
  assert.equal((await ds.resolveDemo(DEMO))?.id, DEMO);
  assert.equal(await ds.resolveDemo(ORDINARY), null);
  assert.equal(await ds.isDemoJob(DEMO), true);
  assert.equal(await ds.isDemoJob(ORDINARY), false);
});
