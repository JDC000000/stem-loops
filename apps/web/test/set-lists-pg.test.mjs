// Set lists (#322; Phase B, B2) against a REAL Postgres with migration 044 applied: the
// routes (real module graph, real SQL; only getUser, Sentry, the demo limiter and next/server
// stubbed) and the schema's own guarantees — FK SET NULL / CASCADE, the case-insensitive
// unique, the deferred position unique, the tombstone trigger, RLS and grants, and a 50-item
// reorder under real concurrency.
//
// Skips locally without a LOCAL DATABASE_URL and FAILS under CI=true (a skipped gate is not a
// pass). Never point it at a shared database: it INSERTs into auth.users and jobs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

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

let pool;
let lists, one, songs, demo, demoSongs;
if (!skip) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DB_URL, max: 12 });
  globalThis.__slPool = pool;
  const DEMO_MSG = readFileSync(join(WEB, 'src/lib/demo-rate.ts'), 'utf8').match(/DEMO_RATE_LIMIT_MSG = "([^"]+)"/)[1];
  const graph = buildModuleGraph({
    name: 'set-lists-pg',
    entries: ['app/api/set-lists/route.ts', 'app/api/set-lists/[id]/route.ts', 'app/api/set-lists/[id]/songs/route.ts', 'app/api/set-lists/demo/route.ts', 'lib/demo-songs.ts'],
    overrides: {
      'lib/db.ts': `export const db = {
        query: (t, p) => globalThis.__slPool.query(t, p),
        tx: async (fn) => { const c = await globalThis.__slPool.connect();
          try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
          catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } },
      };`,
      'lib/auth/supabase.ts': 'export const getUser = async () => globalThis.__slUser ?? null; export const deleteAuthUser = async () => {};',
      'lib/demo-rate.ts': `export const DEMO_RATE_LIMIT_MSG = ${JSON.stringify(DEMO_MSG)}; export async function demoReadAllowed() { return true; }`,
    },
    packages: {
      '@sentry/nextjs': 'export const captureException = () => {}; export const captureMessage = () => {};',
      'next/server': `export class NextResponse { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
          static json(body, init = {}) { return { status: init.status ?? 200, body }; } }
        export class NextRequest {}`,
    },
  });
  lists = await import(graph.url('app/api/set-lists/route.ts'));
  one = await import(graph.url('app/api/set-lists/[id]/route.ts'));
  songs = await import(graph.url('app/api/set-lists/[id]/songs/route.ts'));
  demo = await import(graph.url('app/api/set-lists/demo/route.ts'));
  demoSongs = await import(graph.url('lib/demo-songs.ts'));
}

const EMAIL_PREFIX = 'test-web-set-lists-';
const made = { jobs: [] };
async function cleanup() {
  const like = `(SELECT id FROM public.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
  await pool.query(`DELETE FROM public.set_lists WHERE user_id IN ${like}`);
  await pool.query(`DELETE FROM public.jobs WHERE user_id IN ${like} OR id = ANY($1::uuid[])`, [made.jobs]);
  await pool.query(`DELETE FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'`);
}
after(async () => {
  if (pool) {
    await cleanup();
    await pool.end();
  }
});

const HOST = 'stem-loops.com';
const req = (body, url = `https://${HOST}/api/set-lists`) => ({
  headers: new Headers({ origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' }),
  json: async () => body,
  nextUrl: new URL(url),
  url,
});
const ctx = (id) => ({ params: { id } });
const as = (u) => { globalThis.__slUser = u; };

async function user() {
  const id = randomUUID();
  const email = `${EMAIL_PREFIX}${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]);
  return { user_id: id, email };
}
async function job(owner, { url = null, status = 'done', isDemo = false, title = 'A song' } = {}) {
  const id = randomUUID();
  made.jobs.push(id);
  await pool.query(
    `INSERT INTO jobs (id, youtube_url, input_kind, upload_r2_key, requested_stems, loop_length_bars, status,
                       client_ip_hash, client_fingerprint, user_id, title, is_demo)
     VALUES ($1, $2, $3, $4, ARRAY['drums'], 4, $5, 'b2-set-lists', '', $6, $7, $8)`,
    [id, url, url ? 'youtube' : 'upload', url ? null : `uploads/${id}`, status, owner?.user_id ?? null, title, isDemo],
  );
  return id;
}
async function newList(u, name) {
  as(u);
  const r = await lists.POST(req({ name }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.list.id;
}
async function add(u, listId, jobId) {
  as(u);
  return songs.POST(req({ job_id: jobId }), ctx(listId));
}
async function items(u, listId) {
  as(u);
  const r = await one.GET(req(undefined), ctx(listId));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.list.items;
}
const count = async (sql, p) => Number((await pool.query(sql, p)).rows[0].n);

// ── schema ─────────────────────────────────────────────────────────────────

test('DB: RLS on, anon/authenticated hold nothing, the trigger function is not executable by them', { skip }, async () => {
  for (const t of ['set_lists', 'set_list_songs']) {
    const r = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`]);
    assert.equal(r.rows[0].relrowsecurity, true, t);
    for (const role of ['anon', 'authenticated']) {
      const exists = (await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount > 0;
      if (!exists) continue;
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const g = await pool.query(`SELECT has_table_privilege($1, $2, $3) AS g`, [role, `public.${t}`, priv]);
        assert.equal(g.rows[0].g, false, `${role} ${priv} ${t}`);
      }
      const f = await pool.query(`SELECT has_function_privilege($1, 'public.delete_set_lists_for_tombstoned_user()', 'EXECUTE') AS g`, [role]);
      assert.equal(f.rows[0].g, false, `${role} EXECUTE`);
    }
  }
});

test('DB: the position unique is deferrable and initially deferred', { skip }, async () => {
  const r = await pool.query(`SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'set_list_songs_position_key'`);
  assert.deepEqual(r.rows, [{ condeferrable: true, condeferred: true }]);
});

test('DB: names are unique per user case-insensitively (index), but not across users', { skip }, async () => {
  const a = await user();
  const b = await user();
  await pool.query(`INSERT INTO public.set_lists (user_id, name) VALUES ($1, 'JAMS')`, [a.user_id]);
  await assert.rejects(pool.query(`INSERT INTO public.set_lists (user_id, name) VALUES ($1, 'jams')`, [a.user_id]), { code: '23505' });
  await pool.query(`INSERT INTO public.set_lists (user_id, name) VALUES ($1, 'jams')`, [b.user_id]);
  await assert.rejects(pool.query(`INSERT INTO public.set_lists (user_id, name) VALUES ($1, ' padded')`, [a.user_id]), { code: '23514' });
  // And through the route: 409 NAME_TAKEN.
  as(a);
  const r = await lists.POST(req({ name: 'Jams' }));
  assert.deepEqual([r.status, r.body.error_code], [409, 'NAME_TAKEN']);
});

// ── AC 2 ───────────────────────────────────────────────────────────────────

test("DB AC 2: B gets 404 on every route for A's list; B cannot add A's job; A can add a demo job", { skip }, async () => {
  const a = await user();
  const b = await user();
  const id = await newList(a, 'JAMS');
  const aj = await job(a, { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
  assert.equal((await add(a, id, aj)).status, 201);
  const item = (await items(a, id))[0].item_id;
  as(b);
  const r = [
    await one.GET(req(undefined), ctx(id)), await one.PATCH(req({ name: 'x' }), ctx(id)), await one.DELETE(req(undefined), ctx(id)),
    await songs.POST(req({ job_id: await job(b) }), ctx(id)), await songs.PUT(req({ order: [item] }), ctx(id)),
    await songs.DELETE(req({ item_id: item }), ctx(id)),
  ];
  assert.deepEqual(r.map((x) => x.status), [404, 404, 404, 404, 404, 404]);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_list_songs WHERE set_list_id = $1`, [id]), 1);
  assert.equal((await pool.query(`SELECT name FROM public.set_lists WHERE id = $1`, [id])).rows[0].name, 'JAMS');
  const bl = await newList(b, 'Mine');
  const r2 = await add(b, bl, aj);
  assert.deepEqual([r2.status, r2.body.error_code], [404, 'JOB_NOT_FOUND']);
  // In flight, not done: a committed done demo row would show up in lib/demo-songs' list,
  // which demo-songs-pg.test.mjs (running in parallel) asserts is exactly its own row.
  const dj = await job(null, { isDemo: true, title: 'Offline', status: 'queued' });
  assert.equal((await add(b, bl, dj)).status, 201);
  assert.equal((await pool.query(`SELECT source FROM public.set_list_songs WHERE set_list_id = $1`, [bl])).rows[0].source, 'demo');
});

// ── AC 3 ───────────────────────────────────────────────────────────────────

test('DB AC 3: a song in two lists; deleting a list leaves jobs (the library) unchanged', { skip }, async () => {
  const a = await user();
  const j = await job(a, { url: 'https://www.youtube.com/watch?v=ccccccccccc' });
  const l1 = await newList(a, 'One');
  const l2 = await newList(a, 'Two');
  assert.equal((await add(a, l1, j)).status, 201);
  assert.equal((await add(a, l2, j)).status, 201);
  const jobsBefore = await count(`SELECT count(*) AS n FROM jobs WHERE user_id = $1`, [a.user_id]);
  as(a);
  assert.equal((await one.DELETE(req(undefined), ctx(l1))).status, 204);
  assert.equal(await count(`SELECT count(*) AS n FROM jobs WHERE user_id = $1`, [a.user_id]), jobsBefore);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_list_songs WHERE set_list_id = $1`, [l1]), 0);
  assert.equal((await items(a, l2)).length, 1);
});

// ── AC 4 ───────────────────────────────────────────────────────────────────

test('DB AC 4: a 50-item reorder is atomic under concurrency (10 simultaneous reorders + adds)', { skip }, async () => {
  const a = await user();
  const id = await newList(a, 'Fifty');
  for (let i = 0; i < 50; i += 1) assert.equal((await add(a, id, await job(a))).status, 201);
  const base = (await items(a, id)).map((x) => x.item_id);
  // A swap of every position in one statement needs the DEFERRED unique.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE public.set_list_songs SET position = 49 - position WHERE set_list_id = $1`, [id]);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
  const h = (x, k) => createHash('sha256').update(`${k}:${x}`).digest('hex');
  const shuffles = Array.from({ length: 10 }, (_, k) => [...base].sort((x, y) => h(x, k).localeCompare(h(y, k))));
  assert.equal(new Set(shuffles.map((o) => o.join())).size, 10, 'ten different orders');
  const extra = await job(a);
  as(a);
  const results = await Promise.all([
    ...shuffles.map((order) => songs.PUT(req({ order }), ctx(id))),
    songs.POST(req({ job_id: extra }), ctx(id)),
  ]);
  for (const r of results) assert.ok([200, 201, 409].includes(r.status), JSON.stringify(r.body));
  const rows = (await pool.query(`SELECT item_id::text AS item_id, position FROM public.set_list_songs WHERE set_list_id = $1 ORDER BY position`, [id])).rows;
  assert.equal(rows.length, 51, 'the concurrent add landed exactly once');
  assert.deepEqual(rows.map((r) => r.position), [...Array(51).keys()], 'positions are 0..n-1, no gap, no duplicate');
  const final = rows.map((r) => r.item_id).filter((x) => base.includes(x));
  const winners = results.slice(0, 10).map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
  assert.ok(winners.length >= 1, 'at least one reorder applied');
  assert.ok(winners.some((i) => JSON.stringify(shuffles[i]) === JSON.stringify(final)), 'the final order is exactly one reorder, never a mix');
});

// ── AC 5 ───────────────────────────────────────────────────────────────────

test('DB AC 5: the sweep deleting a link job leaves the item ("Audio expired"); a re-paste plays the new job', { skip }, async () => {
  const a = await user();
  const url = 'https://www.youtube.com/watch?v=ddddddddddd';
  const j1 = await job(a, { url, title: 'Wonderwall' });
  const id = await newList(a, 'Expiry');
  await add(a, id, j1);
  await pool.query(`DELETE FROM jobs WHERE id = $1`, [j1]); // the retention sweep's delete
  const row = (await pool.query(`SELECT job_id, title FROM public.set_list_songs WHERE set_list_id = $1`, [id])).rows[0];
  assert.deepEqual(row, { job_id: null, title: 'Wonderwall' }, 'ON DELETE SET NULL kept the item');
  let it = (await items(a, id))[0];
  assert.deepEqual([it.state, it.job_id], ['expired', null]);
  const j2 = await job(a, { url });
  it = (await items(a, id))[0];
  assert.deepEqual([it.state, it.job_id], ['ready', j2]);
  // Upload: gone is gone.
  const up = await job(a);
  await add(a, id, up);
  await pool.query(`DELETE FROM jobs WHERE id = $1`, [up]);
  assert.equal((await items(a, id))[1].state, 'unavailable');
});

// ── AC 6 ───────────────────────────────────────────────────────────────────

test('DB AC 6: the Demo set never errors, with or without its songs, and is never a row', { skip }, async () => {
  demoSongs.clearDemoJobsCache();
  as(null);
  const r = await demo.GET(req(undefined));
  assert.equal(r.status, 200);
  assert.equal(r.body.list.items.length, 3);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_lists WHERE lower(name) = 'demo set' AND user_id IS NULL`), 0);
});

/** Run `fn` with the routes' db on ONE client inside a transaction that is rolled back, so
 *  rows it writes (demo rows, a temporary role) are never visible to parallel test files. */
async function inRolledBackTx(fn) {
  const c = await pool.connect();
  const real = globalThis.__slPool;
  try {
    await c.query('BEGIN');
    globalThis.__slPool = { query: (t, p) => c.query(t, p) };
    return await fn(c);
  } finally {
    globalThis.__slPool = real;
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
const PREFIX = { 'im-asking-you': '32f99278', offline: '3d43d743', 'lucky-ticket': '9c5ba587' };
const withPrefix = (p) => `${p}-${randomUUID().slice(9)}`;

test('DB AC 6: with the demo songs in the database, the Demo set plays all three, in #322 order — and still does after their owner is deleted', { skip }, async () => {
  await inRolledBackTx(async (c) => {
    const owner = randomUUID();
    await c.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [owner, `${EMAIL_PREFIX}demo-${owner.slice(0, 8)}@example.test`]);
    // Inserted in catalog order (Lucky Ticket first), not the set's order.
    for (const slug of ['lucky-ticket', 'im-asking-you', 'offline']) {
      await c.query(
        `INSERT INTO jobs (id, youtube_url, input_kind, upload_r2_key, requested_stems, loop_length_bars, status,
                           client_ip_hash, client_fingerprint, user_id, title, is_demo)
         VALUES ($1, NULL, 'upload', 'uploads/demo', ARRAY['drums'], 4, 'done', 'b2-set-lists', '', $2, $3, true)`,
        [withPrefix(PREFIX[slug]), owner, slug],
      );
    }
    const read = async () => {
      demoSongs.clearDemoJobsCache();
      as(null);
      const r = await demo.GET(req(undefined));
      assert.equal(r.status, 200);
      return r.body.list.items;
    };
    const check = (items) => {
      assert.deepEqual(items.map((x) => [x.title, x.state]), [['I’m Asking You', 'ready'], ['Offline', 'ready'], ['Lucky Ticket', 'ready']]);
      assert.deepEqual(items.map((x) => x.job_id.slice(0, 8)), ['32f99278', '3d43d743', '9c5ba587']);
    };
    check(await read());
    // The owner goes (outside the app's guarded path): jobs.user_id is SET NULL, is_demo stays.
    await c.query('DELETE FROM auth.users WHERE id = $1', [owner]);
    check(await read());
  });
  demoSongs.clearDemoJobsCache();
});

// ── AC 9 ───────────────────────────────────────────────────────────────────

test('DB AC 9: deleting the users row leaves 0 lists (FK cascade)', { skip }, async () => {
  const a = await user();
  const id = await newList(a, 'Gone');
  await add(a, id, await job(a));
  await pool.query(`DELETE FROM jobs WHERE user_id = $1`, [a.user_id]);
  await pool.query(`DELETE FROM auth.users WHERE id = $1`, [a.user_id]);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_lists WHERE user_id = $1`, [a.user_id]), 0);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_list_songs WHERE set_list_id = $1`, [id]), 0);
});

test('DB AC 9: the tombstone alone (users.deleted_at) leaves 0 lists (backstop trigger)', { skip }, async () => {
  const a = await user();
  const b = await user();
  await newList(a, 'One');
  await newList(a, 'Two');
  const keep = await newList(b, 'Kept');
  await pool.query(`UPDATE public.users SET deleted_at = now() WHERE id = $1`, [a.user_id]);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_lists WHERE user_id = $1`, [a.user_id]), 0);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_lists WHERE id = $1`, [keep]), 1, "another user's list is untouched");
});

test('DB AC 9: the backstop works whichever role tombstones — one with UPDATE on users and NO rights on set_lists (SECURITY DEFINER)', { skip }, async () => {
  await inRolledBackTx(async (c) => {
    const uid = randomUUID();
    await c.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [uid, `${EMAIL_PREFIX}tomb-${uid.slice(0, 8)}@example.test`]);
    await c.query(`INSERT INTO public.set_lists (user_id, name) VALUES ($1, 'One'), ($1, 'Two')`, [uid]);
    const role = `b2_tomb_${randomUUID().slice(0, 8)}`;
    await c.query(`CREATE ROLE ${role} NOLOGIN`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await c.query(`GRANT SELECT, UPDATE (deleted_at) ON public.users TO ${role}`);
    await c.query(`CREATE POLICY ${role}_all ON public.users FOR ALL TO ${role} USING (true) WITH CHECK (true)`);
    const g = await c.query(`SELECT has_table_privilege($1, 'public.set_lists', 'DELETE') AS d`, [role]);
    assert.equal(g.rows[0].d, false, 'the tombstoning role holds no DELETE on set_lists');
    await c.query(`SET LOCAL ROLE ${role}`);
    const u = await c.query(`UPDATE public.users SET deleted_at = now() WHERE id = $1`, [uid]);
    await c.query('RESET ROLE');
    assert.equal(u.rowCount, 1);
    assert.equal(Number((await c.query(`SELECT count(*) AS n FROM public.set_lists WHERE user_id = $1`, [uid])).rows[0].n), 0);
  });
});

// ── limits ─────────────────────────────────────────────────────────────────

test('DB: the 50-list limit holds under concurrent creates', { skip }, async () => {
  const a = await user();
  for (let i = 0; i < 45; i += 1) await pool.query(`INSERT INTO public.set_lists (user_id, name) VALUES ($1, $2)`, [a.user_id, `pre ${i}`]);
  as(a);
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => lists.POST(req({ name: `race ${i}` }))));
  assert.equal(rs.filter((r) => r.status === 201).length, 5);
  assert.equal(rs.filter((r) => r.status === 409).length, 5);
  assert.equal(await count(`SELECT count(*) AS n FROM public.set_lists WHERE user_id = $1`, [a.user_id]), 50);
});
