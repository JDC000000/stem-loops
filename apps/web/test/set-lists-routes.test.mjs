// Set-list routes (#322; Phase B, B2): app/api/set-lists/** through lib/set-lists-server.ts,
// loaded from the REAL module graph. Stubbed: the DB pool (an in-memory fake below), getUser,
// the demo read limiter, Sentry and next/server. Everything else is the real code.
//
// THE FAKE DB honours an ownership predicate ONLY when the SQL actually carries it: e.g. the
// list lookup filters by owner only if the statement says `user_id = $2`. A statement that
// lost its owner filter therefore behaves the way Postgres would — it finds another user's
// row — and the cross-user tests go red. That is what makes these tests able to fail.
// Postgres-only behaviour (the case-insensitive index, the deferred unique, FK SET NULL /
// CASCADE, the tombstone trigger, real concurrency) is in set-lists-pg.test.mjs (CI only)
// and the migration's shape in set-lists.test.mjs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { buildModuleGraph } from './helpers/module-graph.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const DEMO_MSG = read('src/lib/demo-rate.ts').match(/DEMO_RATE_LIMIT_MSG = "([^"]+)"/)[1];

const graph = buildModuleGraph({
  name: 'set-lists-routes',
  entries: [
    'app/api/set-lists/route.ts',
    'app/api/set-lists/[id]/route.ts',
    'app/api/set-lists/[id]/songs/route.ts',
    'app/api/set-lists/demo/route.ts',
    'lib/demo-songs.ts',
  ],
  overrides: {
    'lib/db.ts': `export const db = {
      query: (t, p) => globalThis.__fake.query(t, p),
      tx: async (fn) => globalThis.__fake.tx(fn),
    };`,
    'lib/auth/supabase.ts': `export const getUser = async () => { (globalThis.__touched ??= []).push('getUser'); return globalThis.__user ?? null; };
      export const deleteAuthUser = async () => {};`,
    'lib/demo-rate.ts': `export const DEMO_RATE_LIMIT_MSG = ${JSON.stringify(DEMO_MSG)};
      export async function demoReadAllowed(req) { globalThis.__demoRate = (globalThis.__demoRate ?? 0) + 1; return globalThis.__demoAllowed !== false; }`,
  },
  packages: {
    '@sentry/nextjs': 'export const captureException = () => {}; export const captureMessage = () => {};',
    'next/server': `export class NextResponse {
        constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = new Map(Object.entries(init.headers ?? {})); }
        static json(body, init = {}) { return { status: init.status ?? 200, body, headers: new Map(Object.entries(init.headers ?? {})) }; }
      }
      export class NextRequest {}`,
  },
});

const lists = await import(graph.url('app/api/set-lists/route.ts'));
const one = await import(graph.url('app/api/set-lists/[id]/route.ts'));
const songs = await import(graph.url('app/api/set-lists/[id]/songs/route.ts'));
const demo = await import(graph.url('app/api/set-lists/demo/route.ts'));
const demoSongs = await import(graph.url('lib/demo-songs.ts'));

// ═══ the fake database ═══════════════════════════════════════════════════════

const IN_FLIGHT = ['queued', 'downloading', 'separating', 'extracting', 'uploading'];
let clock = 0;
const tick = () => new Date(Date.UTC(2026, 10, 22, 0, 0, ++clock)).toISOString();

function makeFake() {
  const st = { lists: [], songs: [], jobs: [], unhandled: [], statements: [] };
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const jobById = (id) => st.jobs.find((j) => j.id === id);
  const listOf = (id) => st.songs.filter((s) => s.set_list_id === id).sort((a, b) => a.position - b.position);
  const uniqueErr = (constraint) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });

  function query(text, p = []) {
    const q = norm(text);
    st.statements.push(q);
    const R = (rows) => ({ rows, rowCount: rows.length });

    if (/pg_advisory_xact_lock/.test(q)) return R([]);

    // listSetLists
    if (/^SELECT l\.id::text AS id, l\.name, l\.updated_at/.test(q)) {
      const owned = /WHERE l\.user_id = \$1::uuid/.test(q);
      const job = p[1] ? jobById(p[1]) : null;
      const jobUrlOwned = /j\.id = \$2::uuid AND j\.user_id = \$1::uuid/.test(q);
      const url = job && (!jobUrlOwned || job.user_id === p[0]) ? job.youtube_url : null;
      const rows = st.lists
        .filter((l) => !owned || l.user_id === p[0])
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
        .map((l) => ({
          id: l.id, name: l.name, updated_at: l.updated_at,
          song_count: listOf(l.id).length,
          has_job: p[1] == null ? null : listOf(l.id).some((s) => s.job_id === p[1] || (s.source === 'link' && url && s.youtube_url === url)),
        }));
      return R(rows);
    }
    if (/^SELECT count\(\*\)::int AS n FROM public\.set_lists/.test(q)) {
      const owned = /WHERE user_id = \$1::uuid/.test(q);
      return R([{ n: st.lists.filter((l) => !owned || l.user_id === p[0]).length }]);
    }
    if (/^INSERT INTO public\.set_lists/.test(q)) {
      if (st.lists.some((l) => l.user_id === p[0] && l.name.toLowerCase() === p[1].toLowerCase())) throw uniqueErr('set_lists_user_name_key');
      const l = { id: randomUUID(), user_id: p[0], name: p[1], updated_at: tick() };
      st.lists.push(l);
      return R([{ id: l.id, name: l.name, updated_at: l.updated_at }]);
    }
    if (/^UPDATE public\.set_lists SET name = \$3/.test(q)) {
      const owned = /user_id = \$2::uuid/.test(q);
      const hit = st.lists.filter((l) => l.id === p[0] && (!owned || l.user_id === p[1]));
      for (const l of hit) {
        if (st.lists.some((o) => o !== l && o.user_id === l.user_id && o.name.toLowerCase() === p[2].toLowerCase())) throw uniqueErr('set_lists_user_name_key');
        l.name = p[2];
        l.updated_at = tick();
      }
      return R(hit.map(() => ({})));
    }
    if (/^DELETE FROM public\.set_lists WHERE/.test(q)) {
      const owned = /user_id = \$2::uuid/.test(q);
      const hit = st.lists.filter((l) => l.id === p[0] && (!owned || l.user_id === p[1]));
      st.lists = st.lists.filter((l) => !hit.includes(l));
      st.songs = st.songs.filter((s) => !hit.some((l) => l.id === s.set_list_id)); // FK cascade
      return R(hit.map(() => ({})));
    }
    if (/^SELECT id::text AS id, name FROM public\.set_lists WHERE id = \$1::uuid/.test(q)) {
      const owned = /user_id = \$2::uuid/.test(q);
      return R(st.lists.filter((l) => l.id === p[0] && (!owned || l.user_id === p[1])).map((l) => ({ id: l.id, name: l.name })));
    }
    if (/^SELECT 1 FROM public\.set_lists WHERE id = \$1::uuid.*FOR UPDATE$/.test(q)) {
      const owned = /user_id = \$2::uuid/.test(q);
      return R(st.lists.filter((l) => l.id === p[0] && (!owned || l.user_id === p[1])).map(() => ({ '?column?': 1 })));
    }
    if (/FROM public\.set_list_songs s LEFT JOIN LATERAL/.test(q)) {
      const linkOwned = /WHEN 'link' THEN jobs\.user_id = \$2::uuid AND jobs\.youtube_url = s\.youtube_url/.test(q);
      const uploadOwned = /WHEN 'upload' THEN jobs\.id = s\.job_id AND jobs\.user_id = \$2::uuid/.test(q);
      const demoOnly = /ELSE jobs\.id = s\.job_id AND jobs\.is_demo/.test(q);
      const rows = listOf(p[0]).map((s) => {
        const cands = st.jobs.filter((j) => {
          if (s.source === 'link') return (!linkOwned || j.user_id === p[1]) && j.youtube_url === s.youtube_url;
          if (s.source === 'upload') return j.id === s.job_id && (!uploadOwned || j.user_id === p[1]);
          return j.id === s.job_id && (!demoOnly || j.is_demo);
        }).filter((j) => (j.status === 'done' && j.retained) || p[2].includes(j.status))
          .sort((a, b) => b.created_at - a.created_at);
        const live = cands[0] ?? null;
        return { item_id: s.item_id, position: s.position, source: s.source, title: s.title, live_id: live?.id ?? null, live_status: live?.status ?? null };
      });
      return R(rows);
    }
    // lib/demo-songs.ts readDemoJobs
    if (/FROM jobs WHERE is_demo = true AND status = 'done'/.test(q)) {
      return R(st.jobs.filter((j) => j.is_demo && j.status === 'done' && j.retained).sort((a, b) => a.created_at - b.created_at)
        .map((j) => ({ id: j.id, title: j.title, bpm: 100, musical_key: 'A major' })));
    }
    if (/^SELECT jobs\.id::text AS id, jobs\.is_demo/.test(q)) {
      const guarded = /AND \(jobs\.user_id = \$2::uuid OR jobs\.is_demo = true\)/.test(q);
      const live = /AND \(jobs\.status = 'done' OR jobs\.status = ANY\(\$3::text\[\]\)\)/.test(q);
      return R(st.jobs.filter((j) => j.id === p[0] && j.retained && (!guarded || j.user_id === p[1] || j.is_demo === true)
          && (!live || j.status === 'done' || p[2].includes(j.status)))
        .map((j) => ({ id: j.id, is_demo: j.is_demo, youtube_url: j.youtube_url, video_id: null, title: j.title, original_filename: null })));
    }
    if (/^SELECT item_id::text AS item_id FROM public\.set_list_songs WHERE set_list_id = \$1::uuid AND \(job_id/.test(q)) {
      return R(listOf(p[0]).filter((s) => s.job_id === p[1] || (p[2] != null && s.youtube_url === p[2])).map((s) => ({ item_id: s.item_id })));
    }
    if (/^SELECT count\(\*\)::int AS n FROM public\.set_list_songs/.test(q)) return R([{ n: listOf(p[0]).length }]);
    if (/^INSERT INTO public\.set_list_songs/.test(q)) {
      const [set_list_id, job_id, source, youtube_url, , title, position] = p;
      if (listOf(set_list_id).some((s) => s.job_id === job_id)) throw uniqueErr('set_list_songs_job_key');
      if (youtube_url && listOf(set_list_id).some((s) => s.youtube_url === youtube_url)) throw uniqueErr('set_list_songs_url_key');
      const s = { item_id: randomUUID(), set_list_id, job_id, source, youtube_url, title, position };
      st.songs.push(s);
      return R([{ item_id: s.item_id }]);
    }
    if (/^UPDATE public\.set_lists SET updated_at = now\(\) WHERE id = \$1::uuid$/.test(q)) {
      for (const l of st.lists.filter((x) => x.id === p[0])) l.updated_at = tick();
      return R([]);
    }
    if (/^DELETE FROM public\.set_list_songs WHERE set_list_id = \$1::uuid AND item_id = \$2::uuid/.test(q)) {
      const hit = listOf(p[0]).filter((s) => s.item_id === p[1]);
      st.songs = st.songs.filter((s) => !hit.includes(s));
      return R(hit.map((s) => ({ position: s.position })));
    }
    if (/^DELETE FROM public\.set_list_songs WHERE set_list_id = \$1::uuid AND \(job_id = \$2::uuid/.test(q)) {
      const owned = /j\.id = \$2::uuid AND j\.user_id = \$3::uuid/.test(q);
      const job = jobById(p[1]);
      const url = job && (!owned || job.user_id === p[2]) ? job.youtube_url : null;
      const hit = listOf(p[0]).filter((s) => s.job_id === p[1] || (s.source === 'link' && url && s.youtube_url === url));
      st.songs = st.songs.filter((s) => !hit.includes(s));
      return R(hit.map((s) => ({ position: s.position })));
    }
    if (/^UPDATE public\.set_list_songs s SET position = o\.rn - 1/.test(q)) {
      listOf(p[0]).forEach((s, i) => { s.position = i; });
      return R([]);
    }
    if (/^SELECT item_id::text AS item_id FROM public\.set_list_songs WHERE set_list_id = \$1::uuid$/.test(q)) {
      return R(listOf(p[0]).map((s) => ({ item_id: s.item_id })));
    }
    if (/FROM unnest\(\$2::uuid\[\]\) WITH ORDINALITY/.test(q)) {
      p[1].forEach((id, i) => { const s = st.songs.find((x) => x.set_list_id === p[0] && x.item_id === id); if (s) s.position = i; });
      return R([]);
    }
    st.unhandled.push(q);
    throw new Error(`fake db: unhandled statement: ${q.slice(0, 160)}`);
  }
  return { st, query: async (t, p) => query(t, p), tx: async (fn) => fn({ query: async (t, p) => query(t, p) }) };
}

// ═══ requests ════════════════════════════════════════════════════════════════

const HOST = 'stem-loops.com';
const SAME = { origin: `https://${HOST}`, host: HOST, 'content-type': 'application/json' };
const req = (body, { headers = SAME, url = `https://${HOST}/api/set-lists` } = {}) => ({
  headers: new Headers(headers),
  json: async () => (body === undefined ? (() => { throw new SyntaxError('no body'); })() : body),
  nextUrl: new URL(url),
  url,
});
const A = { user_id: '11111111-1111-4111-8111-111111111111', email: 'a@example.test' };
const B = { user_id: '22222222-2222-4222-8222-222222222222', email: 'b@example.test' };
const as = (u) => { globalThis.__user = u; };
const ctx = (id) => ({ params: { id } });

let fake;
let n = 0;
function job(owner, over = {}) {
  const j = { id: randomUUID(), user_id: owner?.user_id ?? null, is_demo: false, status: 'done', retained: true, youtube_url: null, title: `Song ${++n}`, created_at: ++clock, ...over };
  fake.st.jobs.push(j);
  return j;
}
const linkJob = (owner, v = 'dQw4w9WgXcQ', over = {}) => job(owner, { youtube_url: `https://www.youtube.com/watch?v=${v}`, ...over });

async function create(u, name) {
  as(u);
  const r = await lists.POST(req({ name }));
  return r;
}
async function newList(u, name = 'JAMS') {
  const r = await create(u, name);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.list.id;
}
async function add(u, listId, jobId) {
  as(u);
  return songs.POST(req({ job_id: jobId }), ctx(listId));
}
async function detail(u, listId) {
  as(u);
  return one.GET(req(undefined), ctx(listId));
}

beforeEach(() => {
  fake = makeFake();
  globalThis.__fake = fake;
  globalThis.__user = null;
  globalThis.__touched = [];
  globalThis.__demoAllowed = true;
  globalThis.__demoRate = 0;
  demoSongs.clearDemoJobsCache();
});

// ═══ AC 1: every plan, no plan gate ══════════════════════════════════════════

const walk = (d) => readdirSync(d).flatMap((x) => { const p = join(d, x); return statSync(p).isDirectory() ? walk(p) : [p]; });
const SET_LIST_CODE = [
  ...walk(join(SRC, 'app/api/set-lists')),
  ...walk(join(SRC, 'app/sets')),
  ...walk(join(SRC, 'components/setlists')),
  join(SRC, 'lib/set-lists.ts'),
  join(SRC, 'lib/set-lists-server.ts'),
].filter((p) => /\.(tsx?)$/.test(p));

test('AC 1: no set-list route or module imports or calls enforceEntitlement, or reads the plan', () => {
  assert.ok(SET_LIST_CODE.length >= 10, `walked ${SET_LIST_CODE.length} files`);
  for (const f of SET_LIST_CODE) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(WEB, f);
    assert.doesNotMatch(src, /enforceEntitlement/, `${rel} gates on the plan`);
    assert.doesNotMatch(src, /@\/lib\/billing|getEntitlementSnapshot|plan_code|entitlements/, `${rel} reads billing state`);
  }
});

test('AC 1: the same flow succeeds for any signed-in account (create, add, read, reorder, remove, rename, delete)', async () => {
  for (const u of [A, B, { user_id: randomUUID(), email: 'c@example.test' }]) {
    const id = await newList(u, 'JAMS');
    const j1 = linkJob(u, 'aaaaaaaaaaa');
    const j2 = job(u);
    assert.equal((await add(u, id, j1.id)).status, 201);
    assert.equal((await add(u, id, j2.id)).status, 201);
    const d = await detail(u, id);
    assert.equal(d.status, 200);
    const order = d.body.list.items.map((x) => x.item_id).reverse();
    as(u);
    assert.equal((await songs.PUT(req({ order }), ctx(id))).status, 200);
    as(u);
    assert.equal((await songs.DELETE(req({ item_id: order[0] }), ctx(id))).status, 200);
    as(u);
    assert.equal((await one.PATCH(req({ name: 'Friday gig' }), ctx(id))).status, 200);
    as(u);
    assert.equal((await one.DELETE(req(undefined), ctx(id))).status, 204);
  }
  assert.deepEqual(fake.st.unhandled, []);
});

// ═══ auth and CSRF ═══════════════════════════════════════════════════════════

test('signed out: every user route is 401 and reads nothing', async () => {
  as(null);
  const id = randomUUID();
  const res = [
    await lists.GET(req(undefined)), await lists.POST(req({ name: 'x' })),
    await one.GET(req(undefined), ctx(id)), await one.PATCH(req({ name: 'x' }), ctx(id)), await one.DELETE(req(undefined), ctx(id)),
    await songs.POST(req({ job_id: id }), ctx(id)), await songs.DELETE(req({ item_id: id }), ctx(id)), await songs.PUT(req({ order: [] }), ctx(id)),
  ];
  assert.deepEqual(res.map((r) => r.status), [401, 401, 401, 401, 401, 401, 401, 401]);
  assert.deepEqual(fake.st.statements, []);
});

test('writes refuse a cross-origin request with 403 BAD_ORIGIN before the session or the DB', async () => {
  as(A);
  const evil = { headers: { origin: 'https://evil.example', host: HOST, 'content-type': 'text/plain' } };
  const id = randomUUID();
  for (const r of [
    await lists.POST(req({ name: 'x' }, evil)), await one.PATCH(req({ name: 'x' }, evil), ctx(id)), await one.DELETE(req(undefined, evil), ctx(id)),
    await songs.POST(req({ job_id: id }, evil), ctx(id)), await songs.DELETE(req({ item_id: id }, evil), ctx(id)), await songs.PUT(req({ order: [] }, evil), ctx(id)),
  ]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error_code, 'BAD_ORIGIN');
  }
  assert.deepEqual(globalThis.__touched, []);
  assert.deepEqual(fake.st.statements, []);
});

// ═══ AC 2: owner-only ════════════════════════════════════════════════════════

test("AC 2: B cannot read, rename, delete, add to, reorder or take from A's list (404), and A's list is unchanged", async () => {
  const id = await newList(A, 'JAMS');
  const aj = job(A);
  await add(A, id, aj.id);
  const snap = () => JSON.stringify({ lists: fake.st.lists, songs: fake.st.songs, jobs: fake.st.jobs });
  const before = snap();
  const item = fake.st.songs[0].item_id;
  const bj = job(B);
  const r = [
    await detail(B, id),
    (as(B), await one.PATCH(req({ name: 'Mine now' }), ctx(id))),
    (as(B), await one.DELETE(req(undefined), ctx(id))),
    await add(B, id, bj.id),
    (as(B), await songs.PUT(req({ order: [item] }), ctx(id))),
    (as(B), await songs.DELETE(req({ item_id: item }), ctx(id))),
    (as(B), await songs.DELETE(req({ job_id: aj.id }), ctx(id))),
  ];
  assert.deepEqual(r.map((x) => x.status), [404, 404, 404, 404, 404, 404, 404]);
  for (const x of r) assert.equal(x.body.error_code, 'NOT_FOUND');
  fake.st.jobs.pop(); // B's job, made after the snapshot
  assert.equal(snap(), before, "A's list changed");
  as(B);
  const mine = await lists.GET(req(undefined));
  assert.deepEqual(mine.body.lists, [], "A's list is not in B's index");
});

test("AC 2: A cannot add B's song to A's own list (404 JOB_NOT_FOUND), but CAN add a demo song", async () => {
  const id = await newList(A);
  const theirs = job(B);
  const r = await add(A, id, theirs.id);
  assert.equal(r.status, 404);
  assert.equal(r.body.error_code, 'JOB_NOT_FOUND');
  assert.equal(fake.st.songs.length, 0);
  const demoSong = job({ user_id: 'demo-owner' }, { is_demo: true, title: 'Offline' });
  const ok = await add(A, id, demoSong.id);
  assert.equal(ok.status, 201);
  assert.equal(fake.st.songs[0].source, 'demo');
});

test('a failed job cannot be added (404); a job still in flight can, and shows "Processing" (D-a)', async () => {
  const id = await newList(A);
  const failed = job(A, { status: 'failed' });
  const r = await add(A, id, failed.id);
  assert.deepEqual([r.status, r.body.error_code], [404, 'JOB_NOT_FOUND']);
  assert.equal(fake.st.songs.length, 0);
  const busy = job(A, { status: 'separating' });
  assert.equal((await add(A, id, busy.id)).status, 201);
  assert.deepEqual((await detail(A, id)).body.list.items.map((x) => [x.state, x.job_id]), [['processing', busy.id]]);
});

test('an expired song (not retained) cannot be added', async () => {
  const id = await newList(A);
  const gone = job(A, { retained: false });
  assert.equal((await add(A, id, gone.id)).status, 404);
});

// ═══ AC 3: many lists per song; deleting a list never deletes songs ══════════

test('AC 3: one song in two lists; deleting a list removes its items only, never a job', async () => {
  const l1 = await newList(A, 'JAMS');
  const l2 = await newList(A, 'Gig');
  const j = linkJob(A);
  assert.equal((await add(A, l1, j.id)).status, 201);
  assert.equal((await add(A, l2, j.id)).status, 201);
  assert.equal((await add(A, l1, j.id)).status, 200, 'adding it again is a no-op (200)');
  as(A);
  const idx = await lists.GET(req(undefined, { url: `https://${HOST}/api/set-lists?job=${j.id}` }));
  assert.deepEqual(idx.body.lists.map((l) => [l.name, l.song_count, l.has_job]).sort(), [['Gig', 1, true], ['JAMS', 1, true]]);
  const jobsBefore = fake.st.jobs.length;
  as(A);
  assert.equal((await one.DELETE(req(undefined), ctx(l1))).status, 204);
  assert.equal(fake.st.jobs.length, jobsBefore);
  assert.equal((await detail(A, l2)).body.list.items.length, 1);
  assert.ok(!fake.st.statements.some((s) => /DELETE FROM (public\.)?jobs/i.test(s)), 'a set-list route deleted a job');
});

test('AC 3: the list page says deleting a list never deletes songs, beside the delete control and in the confirm', () => {
  const src = read('src/components/setlists/SetListView.tsx');
  assert.equal((src.match(/\{DELETE_LIST_NOTE\}/g) ?? []).length, 2);
});

// ═══ AC 4: reorder ═══════════════════════════════════════════════════════════

test('AC 4: a reorder sets exactly the order sent; a stale or partial order is refused 409 and changes nothing', async () => {
  const id = await newList(A);
  for (let i = 0; i < 50; i += 1) await add(A, id, job(A).id);
  const items = (await detail(A, id)).body.list.items.map((x) => x.item_id);
  const want = [...items].reverse();
  as(A);
  assert.equal((await songs.PUT(req({ order: want }), ctx(id))).status, 200);
  assert.deepEqual((await detail(A, id)).body.list.items.map((x) => x.item_id), want);
  const positions = (await detail(A, id)).body.list.items.map((x) => x.position);
  assert.deepEqual(positions, [...Array(50).keys()]);
  for (const bad of [want.slice(1), [...want, want[0]].slice(1).concat(want[1]), [...want.slice(1), randomUUID()]]) {
    as(A);
    const r = await songs.PUT(req({ order: bad }), ctx(id));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error_code, 'STALE_ORDER');
  }
  assert.deepEqual((await detail(A, id)).body.list.items.map((x) => x.item_id), want);
});

test('removing an item closes the gap (positions stay 0..n-1)', async () => {
  const id = await newList(A);
  for (let i = 0; i < 4; i += 1) await add(A, id, job(A).id);
  const items = (await detail(A, id)).body.list.items;
  as(A);
  await songs.DELETE(req({ item_id: items[1].item_id }), ctx(id));
  assert.deepEqual((await detail(A, id)).body.list.items.map((x) => x.position), [0, 1, 2]);
});

// ═══ AC 5: expired / unavailable / revived ═══════════════════════════════════

test('AC 5: a swept link job stays as "Audio expired"; re-pasting the URL plays the NEW job with no list edit', async () => {
  const id = await newList(A);
  const old = linkJob(A, 'bbbbbbbbbbb', { title: 'Wonderwall' });
  await add(A, id, old.id);
  // The sweep deletes the job row: ON DELETE SET NULL on the item.
  fake.st.jobs = fake.st.jobs.filter((j) => j !== old);
  fake.st.songs[0].job_id = null;
  let it = (await detail(A, id)).body.list.items[0];
  assert.deepEqual([it.state, it.job_id, it.title], ['expired', null, 'Wonderwall']);
  const again = linkJob(A, 'bbbbbbbbbbb', { status: 'separating' });
  it = (await detail(A, id)).body.list.items[0];
  assert.deepEqual([it.state, it.job_id], ['processing', again.id]);
  again.status = 'done';
  it = (await detail(A, id)).body.list.items[0];
  assert.deepEqual([it.state, it.job_id], ['ready', again.id]);
  // Someone else pasting the same URL does not revive A's item.
  fake.st.jobs = fake.st.jobs.filter((j) => j !== again);
  linkJob(B, 'bbbbbbbbbbb');
  assert.equal((await detail(A, id)).body.list.items[0].state, 'expired');
});

test('AC 5: upload and demo items are "Unavailable" once their job is gone (they resolve by job_id only)', async () => {
  const id = await newList(A);
  const up = job(A, { title: 'my-take.wav' });
  const dm = job({ user_id: 'demo-owner' }, { is_demo: true });
  await add(A, id, up.id);
  await add(A, id, dm.id);
  // Same title/URL-less upload re-made: still unavailable (no URL to follow).
  for (const j of [up, dm]) fake.st.jobs = fake.st.jobs.filter((x) => x !== j);
  for (const s of fake.st.songs) s.job_id = null;
  job(A, { title: 'my-take.wav' });
  const items = (await detail(A, id)).body.list.items;
  assert.deepEqual(items.map((x) => [x.source, x.state, x.job_id]), [['upload', 'unavailable', null], ['demo', 'unavailable', null]]);
});

test("AC 5: an upload item never plays another user's job, and a demo item only an is_demo row", async () => {
  const id = await newList(A);
  const up = job(A);
  await add(A, id, up.id);
  up.user_id = B.user_id; // (cannot happen in prod; proves the owner predicate is there)
  assert.equal((await detail(A, id)).body.list.items[0].state, 'unavailable');
  const dm = job({ user_id: 'demo-owner' }, { is_demo: true });
  await add(A, id, dm.id);
  dm.is_demo = false;
  assert.equal((await detail(A, id)).body.list.items[1].state, 'unavailable');
});

// ═══ AC 6: the Demo set ══════════════════════════════════════════════════════

function seedDemos(slugsPresent = ['im-asking-you', 'offline', 'lucky-ticket']) {
  const prefix = { 'lucky-ticket': '9c5ba587', 'im-asking-you': '32f99278', offline: '3d43d743' };
  // Created in catalog order Lucky Ticket, I'm Asking You, Offline (not the set's order).
  for (const slug of ['lucky-ticket', 'im-asking-you', 'offline']) {
    if (!slugsPresent.includes(slug)) continue;
    job({ user_id: 'demo-owner' }, { id: `${prefix[slug]}-0000-4000-8000-000000000000`, is_demo: true });
  }
}

test('AC 6: GET /api/set-lists/demo works signed out: the 3 songs in #322 order, read-only, no session read', async () => {
  seedDemos();
  as(null);
  const r = await demo.GET(req(undefined));
  assert.equal(r.status, 200);
  assert.equal(r.body.list.name, 'Demo set');
  assert.equal(r.body.list.is_demo, true);
  assert.deepEqual(r.body.list.items.map((x) => [x.title, x.state]), [['I’m Asking You', 'ready'], ['Offline', 'ready'], ['Lucky Ticket', 'ready']]);
  assert.deepEqual(r.body.list.items.map((x) => x.job_id.slice(0, 8)), ['32f99278', '3d43d743', '9c5ba587']);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(globalThis.__touched, [], 'the Demo set does not need a session');
  assert.ok(fake.st.statements.every((s) => /^SELECT/.test(s)), 'the Demo set wrote something');
});

test('AC 6: gated by demoReadAllowed — refused with 429 and DEMO_RATE_LIMIT_MSG, before any read', async () => {
  seedDemos();
  globalThis.__demoAllowed = false;
  const r = await demo.GET(req(undefined));
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error_code: 'RATE_LIMITED', message: DEMO_MSG });
  assert.equal(globalThis.__demoRate, 1);
  assert.deepEqual(fake.st.statements, []);
});

test('AC 6: when its songs are gone the Demo set shows "unavailable" rows and never errors', async () => {
  seedDemos(['offline']);
  let r = await demo.GET(req(undefined));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.list.items.map((x) => [x.title, x.state, x.job_id === null]), [
    ['I’m Asking You', 'unavailable', true], ['Offline', 'ready', false], ['Lucky Ticket', 'unavailable', true],
  ]);
  fake.st.jobs = [];
  demoSongs.clearDemoJobsCache();
  r = await demo.GET(req(undefined));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.list.items.map((x) => x.state), ['unavailable', 'unavailable', 'unavailable']);
});

test('AC 6: the demo route is read-only — it exports GET only (Next answers POST/PATCH/PUT/DELETE with 405)', () => {
  const handlers = Object.keys(demo).filter((k) => /^[A-Z]+$/.test(k)).sort();
  assert.deepEqual(handlers, ['GET']);
  assert.doesNotMatch(read('src/app/api/set-lists/demo/route.ts'), /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)|export\s+(const|\{)[^;]*\b(POST|PUT|PATCH|DELETE)\b/);
});

test('AC 6: writes aimed at the Demo set through /demo/songs are 405; nothing is written', async () => {
  // /api/set-lists/demo itself is the static GET-only route (Next 405s PATCH/DELETE there), so
  // :id never receives `demo`; if it ever did, `demo` is not a uuid: 404, nothing read.
  as(A);
  const r = [
    await songs.POST(req({ job_id: randomUUID() }), ctx('demo')),
    await songs.DELETE(req({ item_id: randomUUID() }), ctx('demo')),
    await songs.PUT(req({ order: [] }), ctx('demo')),
  ];
  assert.deepEqual(r.map((x) => [x.status, x.body.error_code]), Array(3).fill([405, 'DEMO_SET_READ_ONLY']));
  as(A);
  assert.equal((await one.PATCH(req({ name: 'x' }), ctx('demo'))).status, 404);
  as(A);
  assert.equal((await one.DELETE(req(undefined), ctx('demo'))).status, 404);
  assert.deepEqual(fake.st.statements, []);
});

// ═══ names and limits ════════════════════════════════════════════════════════

test('names: 400 for empty / too long, 409 NAME_TAKEN for a case-insensitive duplicate (create and rename)', async () => {
  assert.equal((await create(A, '   ')).status, 400);
  assert.equal((await create(A, 'x'.repeat(61))).status, 400);
  assert.equal((await create(A, 'x'.repeat(60))).status, 201);
  await newList(A, 'JAMS');
  const dup = await create(A, 'jams');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error_code, 'NAME_TAKEN');
  assert.equal((await create(B, 'jams')).status, 201, 'names are unique per user, not globally');
  const g = await newList(A, 'Gig');
  as(A);
  const r = await one.PATCH(req({ name: 'Jams' }), ctx(g));
  assert.deepEqual([r.status, r.body.error_code], [409, 'NAME_TAKEN']);
});

test('limit: the 50th list is made, the 51st is refused 409 SET_LIST_LIMIT', async () => {
  for (let i = 1; i <= 49; i += 1) await newList(A, `L${i}`);
  assert.equal((await create(A, 'L50')).status, 201);
  const r = await create(A, 'L51');
  assert.deepEqual([r.status, r.body.error_code], [409, 'SET_LIST_LIMIT']);
  assert.equal(fake.st.lists.filter((l) => l.user_id === A.user_id).length, 50);
  assert.equal((await create(B, 'L1')).status, 201, "another user's count is separate");
});

test('limit: the 200th song goes in, the 201st is refused 409 SET_LIST_FULL', async () => {
  const id = await newList(A);
  for (let i = 0; i < 199; i += 1) assert.equal((await add(A, id, job(A).id)).status, 201);
  assert.equal((await add(A, id, job(A).id)).status, 201);
  const r = await add(A, id, job(A).id);
  assert.deepEqual([r.status, r.body.error_code], [409, 'SET_LIST_FULL']);
  assert.equal(fake.st.songs.length, 200);
});

test('the index lists the most recently changed first (the player\'s "Add to <last-used list>")', async () => {
  const l1 = await newList(A, 'Older');
  await newList(A, 'Newer');
  await add(A, l1, job(A).id);
  as(A);
  const r = await lists.GET(req(undefined));
  assert.deepEqual(r.body.lists.map((l) => l.name), ['Older', 'Newer']);
  assert.equal(r.body.max_lists, 50);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
});

test('bad ids and bodies are refused before any query', async () => {
  as(A);
  assert.equal((await one.GET(req(undefined), ctx('not-a-uuid'))).status, 404);
  const id = await newList(A);
  fake.st.statements = [];
  as(A);
  assert.equal((await songs.POST(req({ job_id: 'x' }), ctx(id))).status, 400);
  as(A);
  assert.equal((await songs.PUT(req({ order: ['x'] }), ctx(id))).status, 400);
  as(A);
  assert.equal((await songs.POST(req(undefined), ctx(id))).status, 400);
  assert.deepEqual(fake.st.statements, []);
});
