// Slice 2a — the demo-song plumbing around the route rule: the server lookups
// (src/lib/demo-songs.ts), GET /api/demos, the /demo/<slug> page, the read-only demo limiter
// (src/lib/admission.ts peekStemListRate) and the catalog (src/lib/demo-catalog.ts).
//
// The db fake EXECUTES the scoping that matters: it returns a row only when the SQL asks for
// `is_demo = true`, so a lookup that stopped scoping to demo rows returns nothing here and
// the tests that expect a demo go red.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (rel) => join(WEB, rel);
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const LUCKY = '9c5ba587-1111-4111-8111-111111111111';
const OFFLINE = '3d43d743-3333-4333-8333-333333333333';
const LOCAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // a demo row not in the catalog (a test stack)
const ORDINARY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const ROWS = [
  { id: LOCAL, title: '_some_upload_name', bpm: '120.0', musical_key: 'C major', is_demo: true, user_id: 'u' },
  { id: OFFLINE, title: 'offline_mix_3', bpm: 95, musical_key: 'G major', is_demo: true, user_id: 'u' },
  { id: LUCKY, title: '_Lucky_Ticket_-_MIX_1_07', bpm: 102, musical_key: 'A major', is_demo: true, user_id: 'u' },
  { id: ORDINARY, title: 'somebody else', bpm: 90, musical_key: 'D major', is_demo: false, user_id: 'x' },
];

const dbStub = dataUrl(`
  export const db = { query: async (text, params = []) => {
    const t = String(text);
    (globalThis.__ds.sql ??= []).push({ t, params });
    if (globalThis.__ds.throws) throw new Error('db down');
    if (!/FROM jobs/.test(t)) throw new Error('unexpected SQL ' + t);
    let rows = globalThis.__ds.rows;
    if (!/is_demo = true/.test(t)) return { rows, rowCount: rows.length }; // unscoped: would leak
    rows = rows.filter((r) => r.is_demo === true);
    if (/id = \\$1/.test(t)) rows = rows.filter((r) => r.id === params[0]);
    const list = /SELECT([\\s\\S]*?)FROM jobs/.exec(t)[1];
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => new RegExp('\\\\b' + k + '\\\\b').test(list))));
    return { rows, rowCount: rows.length };
  } };
`);
const catalogUrl = dataUrl(toJs(readFileSync(P('src/lib/demo-catalog.ts'), 'utf8')));
const retentionStub = dataUrl(`export const JOB_RETAINED_UNTIL_SQL = 'expires_at';`);
const demoSongsJs = toJs(readFileSync(P('src/lib/demo-songs.ts'), 'utf8'))
  .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
  .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionStub}'`)
  .replace(/from ['"]@\/lib\/demo-catalog['"]/g, `from '${catalogUrl}'`);
const demoSongsUrl = dataUrl(demoSongsJs);
const ds = await import(demoSongsUrl);
const catalog = await import(catalogUrl);

beforeEach(() => {
  globalThis.__ds = { rows: ROWS, sql: [], throws: false };
  ds.clearDemoJobsCache();
});

// ── lib/demo-songs.ts ────────────────────────────────────────────────────────────────

test('listDemoJobs: only is_demo rows, catalogued songs first in catalog order, titled from the catalog', async () => {
  const demos = await ds.listDemoJobs();
  assert.deepEqual(demos.map((d) => d.id), [LUCKY, OFFLINE, LOCAL]);
  assert.equal(demos[0].title, 'Lucky Ticket', 'the upload file name leaked as the title');
  assert.equal(demos[0].slug, 'lucky-ticket');
  assert.equal(demos[0].artist, 'The Royal Sundowners');
  assert.equal(demos[2].slug, null);
  assert.equal(demos[2].bpm, 120, 'numeric BPM from a numeric column');
  for (const d of demos) assert.equal('user_id' in d, false, 'user_id left the server');
  assert.ok(!demos.some((d) => d.id === ORDINARY), 'an ordinary job was listed');
  const q = globalThis.__ds.sql[0].t;
  assert.match(q, /is_demo = true/);
  assert.match(q, /status = 'done'/);
  assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE)\b/);
});

test('resolveDemo: a catalog slug, or a demo row id; never an ordinary job; unknown → null', async () => {
  assert.equal((await ds.resolveDemo('lucky-ticket')).id, LUCKY);
  assert.equal((await ds.resolveDemo('LUCKY-TICKET')).id, LUCKY);
  assert.equal((await ds.resolveDemo(LOCAL)).id, LOCAL);
  assert.equal(await ds.resolveDemo(ORDINARY), null, 'an ordinary job id resolved as a demo');
  assert.equal(await ds.resolveDemo('im-asking-you'), null, 'a catalog song with no row resolved');
  assert.equal(await ds.resolveDemo('nope'), null);
  assert.equal(await ds.resolveDemo("'; DROP TABLE jobs; --"), null);
});

test('S2: a key that is neither a catalog slug nor a UUID returns null with ZERO database calls', async () => {
  for (const key of ['nonsense', '9c5ba587', 'lucky-ticket-x', '', '../../etc', "'; DROP TABLE jobs; --", 'x'.repeat(5000)]) {
    globalThis.__ds.sql = [];
    assert.equal(await ds.resolveDemo(key), null, key.slice(0, 20));
    assert.equal(globalThis.__ds.sql.length, 0, `${key.slice(0, 20)} reached the database`);
  }
});

test('S2: the demo list is read once per TTL per instance; a failed read is not cached', async () => {
  const t0 = 1_000_000;
  await ds.listDemoJobs(t0);
  await ds.listDemoJobs(t0 + ds.DEMO_LIST_TTL_MS - 1);
  assert.equal(globalThis.__ds.sql.length, 1, 'a second read inside the TTL hit the database');
  await ds.listDemoJobs(t0 + ds.DEMO_LIST_TTL_MS);
  assert.equal(globalThis.__ds.sql.length, 2, 'the TTL never expired');
  ds.clearDemoJobsCache();
  globalThis.__ds.throws = true;
  await assert.rejects(() => ds.listDemoJobs(t0));
  globalThis.__ds.throws = false;
  assert.equal((await ds.listDemoJobs(t0 + 1)).length, 3, 'a failure was cached');
});

test('isDemoJob: true only for an is_demo row; a malformed id never reaches the database', async () => {
  assert.equal(await ds.isDemoJob(LUCKY), true);
  assert.equal(await ds.isDemoJob(ORDINARY), false);
  globalThis.__ds.sql = [];
  assert.equal(await ds.isDemoJob('abc-123'), false);
  assert.equal(globalThis.__ds.sql.length, 0);
  assert.match(String((await ds.isDemoJob(LUCKY), globalThis.__ds.sql.at(-1).t)), /is_demo = true/);
});

// ── catalog ──────────────────────────────────────────────────────────────────────────

test('catalog: the three demo songs with Jon-confirmed BPM and key (design v1.5 decisions table)', () => {
  assert.deepEqual(
    catalog.DEMO_SONGS.map((d) => [d.slug, d.idPrefix, d.title, d.bpm, d.musicalKey]),
    [
      ['lucky-ticket', '9c5ba587', 'Lucky Ticket', 102, 'A major'],
      ['im-asking-you', '32f99278', 'I’m Asking You', 128, 'A minor'],
      ['offline', '3d43d743', 'Offline', 95, 'G major'],
    ],
  );
  assert.equal(catalog.demoForJobId('9C5BA587-aaaa-4aaa-8aaa-aaaaaaaaaaaa')?.slug, 'lucky-ticket');
  assert.equal(catalog.demoForJobId('9c5ba5870-aaaa'), null, 'a prefix match must end at the first dash');
  assert.equal(catalog.demoHref('lucky-ticket'), '/demo/lucky-ticket');
});

// ── GET /api/demos ───────────────────────────────────────────────────────────────────

const nextStub = dataUrl(`
  export class NextResponse { static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; } }
`);
const sentryStub = dataUrl(`export const captureException = () => {};`);
const demosRoute = await import(
  dataUrl(
    toJs(readFileSync(P('src/app/api/demos/route.ts'), 'utf8'))
      .replace(/from ['"]@\/lib\/demo-songs['"]/g, `from '${demoSongsUrl}'`)
      .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
      .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`),
  )
);

test('GET /api/demos: the playable demos, publicly cacheable (no credential in the body)', async () => {
  const res = await demosRoute.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.demos.map((d) => d.id), [LUCKY, OFFLINE, LOCAL]);
  assert.match(res.headers['Cache-Control'], /^public, /);
  assert.match(res.headers['Cache-Control'], /s-maxage=\d+/);
  const body = JSON.stringify(res.body);
  assert.doesNotMatch(body, /signed|user_id|https?:/, 'a credential, owner or URL reached the cacheable body');
});

test('GET /api/demos: a database fault is a 500 that is NOT cached', async () => {
  globalThis.__ds.throws = true;
  const res = await demosRoute.GET();
  assert.equal(res.status, 500);
  assert.equal(res.body.error_code, 'INTERNAL_ERROR');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

// ── /demo/<slug> page ────────────────────────────────────────────────────────────────

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'demo-page-'));
const put = (name, code) => (writeFileSync(join(dir, name), code), './' + name);
const navMod = put('nav.mjs', `export function notFound() { const e = new Error('NEXT_NOT_FOUND'); e.digest = 'NEXT_NOT_FOUND'; throw e; }`);
const authMod = put('auth.mjs', `export const getUser = async () => globalThis.__ds.user ?? null;`);
const viewMod = put('view.mjs', `export default function JobView(p) { return { type: 'JobView', props: p }; }`);
const dsMod = put('ds.mjs', demoSongsJs);
const pageFile = put(
  'page.mjs',
  toJs(readFileSync(P('src/app/demo/[slug]/page.tsx'), 'utf8'), true)
    .replace(/from ['"]next\/navigation['"]/g, `from '${navMod}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authMod}'`)
    .replace(/from ['"]@\/lib\/demo-songs['"]/g, `from '${dsMod}'`)
    .replace(/from ['"]@\/lib\/seo\/demo-pages['"]/g, `from '${pathToFileURL(P('src/lib/seo/demo-pages.ts')).href}'`)
    .replace(/from ['"]\.\.\/\.\.\/jobs\/\[id\]\/JobView['"]/g, `from '${viewMod}'`),
);
const demoPage = await import(pathToFileURL(join(dir, pageFile.slice(2))).href);

test('/demo/<slug>: a catalog slug renders the player for that demo job, signed out', async () => {
  const el = await demoPage.default({ params: { slug: 'lucky-ticket' } });
  assert.equal(el.props.id, LUCKY);
  assert.equal(el.props.signedIn, false);
  globalThis.__ds.user = { user_id: 'u-1' };
  assert.equal((await demoPage.default({ params: { slug: 'lucky-ticket' } })).props.signedIn, true);
});

test('/demo/<slug>: anything that is not a playable demo is a 404, including an ordinary job id', async () => {
  for (const slug of ['nope', ORDINARY, 'im-asking-you']) {
    await assert.rejects(() => demoPage.default({ params: { slug } }), (e) => e.digest === 'NEXT_NOT_FOUND', slug);
  }
});

test('/demo/<slug> is dynamic and lays the player out under the notch like /jobs/[id]', () => {
  assert.equal(demoPage.dynamic, 'force-dynamic');
  assert.equal(demoPage.viewport.viewportFit, 'cover');
});

// QA-55: the catalog's demo pages are in sitemap.xml, so they must be indexable (a sitemap URL
// marked noindex is a Search Console error), built by the SEO-06 builder (canonical, Open Graph,
// Twitter), with canonical == sitemap path and a unique title of <= 60 characters once the layout
// template (" · stem-loops") is added. Off-catalog slugs: noindex.
test('/demo/<slug> metadata: catalog slugs indexable, SEO-06 complete, canonical is the sitemap path', async () => {
  const { DEMO_SONGS } = await import(catalogUrl);
  const { default: sitemap } = await import(pathToFileURL(P('src/app/sitemap.ts')).href);
  const demoUrls = sitemap().map((e) => e.url).filter((u) => u.includes('/demo/'));
  assert.equal(demoUrls.length, DEMO_SONGS.length);
  const titles = new Set();
  for (const d of DEMO_SONGS) {
    const m = demoPage.generateMetadata({ params: { slug: d.slug } });
    assert.notEqual(m.robots?.index, false, `${d.slug} is noindex but listed in the sitemap`);
    assert.ok(m.title.includes(d.title), d.slug);
    assert.ok(`${m.title} · stem-loops`.length <= 60, `${d.slug}: title over 60 characters`);
    assert.match(m.description, /the demo opens without signing in/i);
    const path = `/demo/${d.slug}`;
    assert.equal(m.alternates?.canonical, path, `${d.slug}: canonical`);
    assert.ok(demoUrls.includes(`https://stem-loops.com${m.alternates.canonical}`), `${d.slug}: canonical not in sitemap`);
    assert.equal(m.openGraph?.url, path);
    assert.equal(m.openGraph?.title, m.title);
    assert.ok(m.openGraph?.siteName && m.openGraph?.images?.length, `${d.slug}: openGraph incomplete`);
    assert.equal(m.twitter?.card, 'summary_large_image');
    assert.ok(m.twitter?.images?.length, `${d.slug}: twitter image`);
    titles.add(m.title);
  }
  assert.equal(titles.size, DEMO_SONGS.length, 'demo titles are unique');
  for (const slug of ['nope', ORDINARY, 'Lucky-Ticket']) {
    const m = demoPage.generateMetadata({ params: { slug } });
    assert.equal(m.robots.index, false, slug);
    assert.equal(m.alternates, undefined, slug);
  }
});

// ── the read-only demo limiter (QA B-17: no write on GET) ────────────────────────────

test('peekStemListRate: one SELECT on the stems counter, no INSERT; refuses at the stems budget', async () => {
  const seen = [];
  const db = dataUrl(`export const db = { query: async (t, p) => { globalThis.__peek.push({ t, p }); return { rows: [{ count: globalThis.__peekCount }], rowCount: 1 }; } };`);
  const errCopy = dataUrl(toJs(readFileSync(P('src/lib/error-copy.ts'), 'utf8')));
  const adm = await import(
    dataUrl(
      toJs(readFileSync(P('src/lib/admission.ts'), 'utf8'))
        .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
        .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${errCopy}'`),
    ) + '#peek'
  );
  globalThis.__peek = seen;
  globalThis.__peekCount = 59;
  assert.equal((await adm.peekStemListRate('h')).allowed, true);
  globalThis.__peekCount = 60;
  assert.equal((await adm.peekStemListRate('h')).allowed, false);
  assert.equal(seen.length, 2);
  for (const { t, p } of seen) {
    assert.match(t, /^\s*SELECT COUNT/);
    assert.doesNotMatch(t, /\b(INSERT|UPDATE|DELETE)\b/i, 'the demo limiter writes on GET');
    assert.equal(p[0], 'stems:h', 'the demo limiter must read the stems counter the stems route records');
  }
});
