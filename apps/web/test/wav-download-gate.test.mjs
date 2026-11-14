// Run: pnpm --filter web test
//
// The paid export gate: GET /api/jobs/:id/download signs the full-length stem WAV
// (`_stems/dl/<stem>.wav`) only for a caller whose plan carries `export_stems` (today:
// Studio), while Opus playback and the chord artifact stay open. `export_wav24` is NOT
// consulted: the owner's tiering is "$4.99 = no stem export, $12 = stem export".
// TSD §12.2 is the Opus/WAV split this gate sits on.
//
// What is REAL here: the download route, lib/billing/entitlements.ts (its plan lookup,
// effectivePlanCode and enforceEntitlement all run), lib/stem-keys.ts, and — for the
// sharing property — the real stems and play-chords routes. What is stubbed is the edge:
// Postgres (answers by SQL text, with the plans table seeded as 034 + 037 leave it),
// R2/S3, getUser, and next/server.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (rel) => join(WEB, rel);
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const real = (rel) => dataUrl(toJs(readFileSync(P(rel), 'utf8')));

const JOB = '550e8400-e29b-41d4-a716-446655440000';
const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const SIX = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

// The tiering as migration 037 leaves it on top of 034 (owner decision, 2026-11-12):
// stems on Studio only, wav24 on nobody. Fixture data, not read from the migration;
// pricing-features-table.test.mjs is the test that parses 034 + 037.
const STEMS_DENIAL = 'stem export is included in Studio only';
const PLANS = {
  free: { code: 'free', monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false },
  pro: { code: 'pro', monthly_job_quota: 50, services: [], export_stems: false, export_wav24: false },
  studio: { code: 'studio', monthly_job_quota: 150, services: [], export_stems: true, export_wav24: false },
};

const nextStub = dataUrl(`
  export class NextResponse {
    static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
  }
  export class NextRequest {}
`);
const sentryStub = dataUrl(`export const captureException = () => {}; export const captureMessage = () => {};`);
const s3Stub = dataUrl(`
  export class HeadObjectCommand { constructor(input) { this.input = input; this.kind = 'head'; } }
  export class ListObjectsV2Command { constructor(input) { this.input = input; this.kind = 'list'; } }
  export class GetObjectCommand { constructor(input) { this.input = input; } }
`);

/** Postgres by SQL text. `plan` is what the user's entitlement row says; null = no row. */
const dbStub = dataUrl(`
  const PLANS = ${JSON.stringify(PLANS)};
  export const db = { query: async (text, params) => {
    const st = globalThis.__st;
    st.sql.push(text.replace(/\\s+/g, ' ').trim().slice(0, 60));
    if (/FROM jobs/.test(text)) {
      const rows = st.job ? [st.job] : [];
      return { rows, rowCount: rows.length };
    }
    if (/FROM entitlements e/.test(text)) {
      const rows = st.plan && st.plan !== 'free' ? [{
        plan_code: st.plan, period_start: new Date(Date.now() - 864e5).toISOString(),
        period_end: new Date(Date.now() + 864e5 * 20).toISOString(), jobs_used: 0,
        sub_status: 'active', sub_period_start: new Date(Date.now() - 864e5).toISOString(),
      }] : [];
      return { rows, rowCount: rows.length };
    }
    if (/v_credit_balance/.test(text)) return { rows: [{ credits_remaining: 0 }], rowCount: 1 };
    if (/trial_grants/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM plans/.test(text)) return { rows: [{ ...PLANS[params[0]], ...(st.planPatch ?? {}) }], rowCount: 1 };
    throw new Error('unexpected SQL in test: ' + text.slice(0, 80));
  } };
`);

const authStub = dataUrl(`
  export const getUser = async () => { globalThis.__st.getUserCalls++; return globalThis.__st.user; };
`);
const r2Stub = dataUrl(`
  export const r2 = { send: async (cmd) => {
    const st = globalThis.__st;
    st.r2.push([cmd.kind, cmd.input.Key ?? cmd.input.Prefix]);
    if (cmd.kind === 'head') {
      if (!st.dlKeys.includes(cmd.input.Key)) { const e = new Error('nf'); e.name = 'NotFound'; throw e; }
      return {};
    }
    return { Contents: st.listKeys.map((Key) => ({ Key, Size: 1 })) };
  } };
  export const mintPlayChordsSignedUrl = async (id) => {
    globalThis.__st.minted.push(['chords', id]);
    return 'https://r2.example/jobs/' + id + '/play.chords.json?sig=x';
  };
  export const PLAY_CHORDS_SIGNED_URL_TTL_SEC = 300;
`);
// Records the artifact KIND each URL was signed for, and embeds the real key shape.
const stemUrlsStub = dataUrl(`
  export const mintStemPlayUrl = async (jobId, stem) => {
    globalThis.__st.minted.push(['play', stem]);
    return 'https://r2.example/' + jobId + '/_stems/play/' + stem + '.opus?sig=x';
  };
  export const mintStemDownloadUrl = async (jobId, stem, expiresIn, filename) => {
    globalThis.__st.minted.push(['download', stem, expiresIn, filename]);
    return 'https://r2.example/' + jobId + '/_stems/dl/' + stem + '.wav?sig=x';
  };
`);
const admissionStub = dataUrl(`export const checkStemListRate = async () => ({ allowed: true, error_code: null });`);
const clientIpStub = dataUrl(`export const clientIpHashOf = () => 'iphash';`);

const entitlementsUrl = (() => {
  let js = toJs(readFileSync(P('src/lib/billing/entitlements.ts'), 'utf8'));
  js = js.replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`);
  return dataUrl(js);
})();

const jobAccessUrl = dataUrl(
  toJs(readFileSync(P('src/lib/job-access.ts'), 'utf8')).replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`),
);

async function loadRoute(rel) {
  let js = toJs(readFileSync(P(rel), 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/r2['"]/g, `from '${r2Stub}'`)
    // SEC-1 (#220): the REAL ownership helper, over this file's getUser stub.
    .replace(/from ['"]@\/lib\/job-access['"]/g, `from '${jobAccessUrl}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsUrl}'`)
    .replace(/from ['"]@\/lib\/stem-urls['"]/g, `from '${stemUrlsStub}'`)
    .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admissionStub}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub}'`)
    .replace(/from ['"]@\/lib\/stem-keys['"]/g, `from '${real('src/lib/stem-keys.ts')}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${real('src/lib/retention.ts')}'`)
    .replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${s3Stub}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`);
  return import(dataUrl(js) + '#' + Math.random());
}
const loadDownload = () => loadRoute('src/app/api/jobs/[id]/download/route.ts');
const loadStems = () => loadRoute('src/app/api/jobs/[id]/stems/route.ts');
const loadChords = () => loadRoute('src/app/api/jobs/[id]/play-chords/route.ts');

const download = (mod, stem = 'drums', id = JOB) =>
  mod.GET({ url: `https://stem-loops.test/api/jobs/${id}/download${stem === null ? '' : `?stem=${stem}`}` }, { params: { id } });
const plain = () => ({ url: 'https://x.test/', headers: { get: () => null } });

/** state: who is calling, which plan they are on, and what the job looks like. */
function arrange({ user = OWNER, plan = 'free', jobUser = OWNER, status = 'done', noJob = false, hasDl = true } = {}) {
  globalThis.__st = {
    getUserCalls: 0, sql: [], r2: [], minted: [],
    user: user === null ? null : { user_id: user, email: `${user}@x.test` },
    plan,
    job: noJob ? null : {
      id: JOB, user_id: jobUser, status, expires_at: new Date(Date.now() + 3600e3).toISOString(),
    },
    dlKeys: hasDl ? SIX.map((s) => `${JOB}/_stems/dl/${s}.wav`) : [],
    listKeys: [
      ...SIX.map((s) => `${JOB}/_stems/play/${s}.opus`),
      ...SIX.map((s) => `${JOB}/_stems/dl/${s}.wav`),
    ],
  };
}
beforeEach(async () => {
  process.env.R2_BUCKET_NAME = 'test-bucket';
  // enforceEntitlement caches a snapshot per user for 30s; without this a test would
  // inherit the previous test's plan.
  (await import(entitlementsUrl))._resetEntitlementCacheForTests();
  arrange();
});

// ───────────── 1. a Studio user gets a signed stem WAV URL ─────────────

test('Studio owner (export_stems true, export_wav24 FALSE) gets a signed WAV URL for the dl/ artifact, with a download filename', async () => {
  arrange({ plan: 'studio' });
  const res = await download(await loadDownload(), 'vocals');
  assert.equal(res.status, 200);
  assert.match(res.body.signed_url, new RegExp(`${JOB}/_stems/dl/vocals\\.wav`));
  assert.deepEqual(globalThis.__st.minted, [['download', 'vocals', 900, 'vocals.wav']]);
  assert.equal(res.headers['Cache-Control'], 'private, no-store', 'a signed URL is a bearer credential');
});

test('a signed-in Studio user can fetch an ANONYMOUS job (user_id null) — the link is that job\'s credential', async () => {
  arrange({ plan: 'studio', user: STRANGER, jobUser: null });
  assert.equal((await download(await loadDownload())).status, 200);
});

// ───────────── 2. free / anonymous callers get no WAV URL ─────────────

test('ANONYMOUS caller: 401, no URL minted, and the database is never touched', async () => {
  arrange({ user: null, plan: 'studio' });
  const res = await download(await loadDownload());
  assert.equal(res.status, 401);
  assert.equal(res.body.error_code, 'AUTH_REQUIRED');
  assert.equal(res.body.signed_url, undefined);
  assert.deepEqual(globalThis.__st.minted, []);
  assert.deepEqual(globalThis.__st.sql, [], 'no job or plan lookup before sign-in: nothing to probe');
  assert.deepEqual(globalThis.__st.r2, []);
});

test('FREE signed-in owner: 402, no URL minted, R2 not even probed', async () => {
  arrange({ plan: 'free' });
  const res = await download(await loadDownload());
  assert.equal(res.status, 402);
  assert.equal(res.body.error_code, 'ENTITLEMENT_UNAVAILABLE');
  assert.equal(res.body.signed_url, undefined);
  assert.deepEqual(globalThis.__st.minted, []);
  assert.deepEqual(globalThis.__st.r2, []);
});

test('a denial does not leak plan state: body is exactly {error_code, message}', async () => {
  arrange({ plan: 'free' });
  const res = await download(await loadDownload());
  assert.deepEqual(Object.keys(res.body).sort(), ['error_code', 'message']);
  assert.equal(res.headers['Cache-Control'], 'private, no-store', 'denials are not cacheable either');
  const blob = JSON.stringify(res.body);
  for (const secret of [OWNER, 'free', 'plan_code', 'jobs_used', 'period_end', 'credits']) {
    assert.ok(!blob.includes(secret), `denial body must not contain ${secret}: ${blob}`);
  }
});

test('Studio user on SOMEONE ELSE\'S owned job: 404 (not 403), no URL, entitlement never consulted', async () => {
  arrange({ plan: 'studio', user: STRANGER, jobUser: OWNER });
  const res = await download(await loadDownload());
  assert.equal(res.status, 404);
  assert.equal(res.body.error_code, 'NOT_FOUND');
  assert.deepEqual(globalThis.__st.minted, []);
  assert.ok(!globalThis.__st.sql.some((s) => /entitlements|plans/.test(s)));
});

test('a job whose user_id column is MISSING from the row denies everyone (fail closed)', async () => {
  arrange({ plan: 'studio' });
  delete globalThis.__st.job.user_id; // undefined !== null
  assert.equal((await download(await loadDownload())).status, 404);
});

test('unfinished, expired and malformed-id jobs never reach the signer', async () => {
  arrange({ plan: 'studio', status: 'separating' });
  const mod = await loadDownload();
  assert.equal((await download(mod)).status, 404);
  arrange({ plan: 'studio', noJob: true });
  assert.equal((await download(mod)).status, 404);
  arrange({ plan: 'studio' });
  assert.equal((await download(mod, 'drums', 'not-a-uuid')).status, 404);
  assert.deepEqual(globalThis.__st.minted, []);
});

test('stem must be one of the six; a path-ish or missing value is 400 and signs nothing', async () => {
  arrange({ plan: 'studio' });
  const mod = await loadDownload();
  for (const bad of [null, '', 'master', '../drums', 'drums.wav', 'drums/../vocals']) {
    const res = await download(mod, bad);
    assert.equal(res.status, 400, `stem=${bad}`);
  }
  assert.deepEqual(globalThis.__st.minted, []);
});

test('a stem that was never retained is 404 STEM_NOT_FOUND, not a URL to a missing object', async () => {
  arrange({ plan: 'studio', hasDl: false });
  const res = await download(await loadDownload());
  assert.equal(res.status, 404);
  assert.equal(res.body.error_code, 'STEM_NOT_FOUND');
  assert.deepEqual(globalThis.__st.minted, []);
});

// ───────────── 3. SHARING: anonymous callers still get Opus + chords ─────────────

test('SHARING: an anonymous caller still gets all six Opus playback stems — and no WAV', async () => {
  arrange({ user: null, plan: 'free', jobUser: null });
  const res = await (await loadStems()).GET(plain(), { params: { id: JOB } });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ready');
  assert.deepEqual(res.body.stems.map((s) => s.stem), ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);
  for (const s of res.body.stems) {
    assert.match(s.signed_url, /\/_stems\/play\/[a-z]+\.opus\?/);
    assert.ok(!/\.wav|\/dl\//.test(s.signed_url), 'playback must never carry the download artifact');
  }
  assert.ok(globalThis.__st.minted.every(([kind]) => kind === 'play'));
  assert.equal(globalThis.__st.getUserCalls, 0, 'playback must not depend on who is asking');
});

test('SHARING: an anonymous caller still gets the chord artifact', async () => {
  arrange({ user: null, plan: 'free', jobUser: null });
  const res = await (await loadChords()).GET(plain(), { params: { id: JOB } });
  assert.equal(res.status, 200);
  assert.match(res.body.signed_url, /play\.chords\.json/);
  assert.deepEqual(globalThis.__st.minted, [['chords', JOB]]);
  assert.equal(globalThis.__st.getUserCalls, 0);
});

test('SHARING: playback is also open to a FREE signed-in stranger (entitlement is never consulted)', async () => {
  arrange({ user: STRANGER, plan: 'free', jobUser: null });
  const res = await (await loadStems()).GET(plain(), { params: { id: JOB } });
  assert.equal(res.status, 200);
  assert.ok(!globalThis.__st.sql.some((s) => /entitlements|plans/.test(s)));
});

// SEC-1 (#220), reviewer probes: playback of an OWNED job is the owner's alone.
for (const [name, load] of [['stems', () => loadStems()], ['play-chords', () => loadChords()]]) {
  test(`OWNED job: ${name} is 404 for a signed-in stranger and for a signed-out caller, 200 for the owner`, async () => {
    arrange({ user: STRANGER, plan: 'studio', jobUser: OWNER });
    assert.equal((await (await load()).GET(plain(), { params: { id: JOB } })).status, 404);
    assert.deepEqual(globalThis.__st.minted, []);
    arrange({ user: null, jobUser: OWNER });
    assert.equal((await (await load()).GET(plain(), { params: { id: JOB } })).status, 404);
    assert.deepEqual(globalThis.__st.minted, []);
    arrange({ user: OWNER, jobUser: OWNER });
    assert.equal((await (await load()).GET(plain(), { params: { id: JOB } })).status, 200);
  });
}

// ───────────── 4. the tier mapping: Free 402, Pro 402, Studio signed URL ─────────────

for (const [plan, wantStems, wantWav] of [['free', false, false], ['pro', false, false], ['studio', true, false]]) {
  test(`mapping: ${plan} -> export_stems=${wantStems}, export_wav24=${wantWav} (real enforceEntitlement over the 034 + 037 flags)`, async () => {
    arrange({ plan });
    const ent = await import(entitlementsUrl);
    ent._resetEntitlementCacheForTests();
    const allows = async (action) => {
      try { await ent.enforceEntitlement(action, OWNER); return true; } catch (e) {
        if (e instanceof ent.EntitlementError) return false;
        throw e;
      }
    };
    assert.equal(await allows('export_stems'), wantStems);
    assert.equal(await allows('export_wav24'), wantWav);
  });
}

for (const [plan, status] of [['free', 402], ['pro', 402], ['studio', 200]]) {
  test(`tier table through the route: ${plan} -> ${status}`, async () => {
    arrange({ plan });
    const res = await download(await loadDownload());
    assert.equal(res.status, status);
    assert.equal(res.body.signed_url !== undefined, status === 200);
    assert.equal(globalThis.__st.minted.length, status === 200 ? 1 : 0);
  });
}

test('PRO ($4.99: no stem export) is refused with 402 and the denial names the plan that includes it, not the caller\'s', async () => {
  arrange({ plan: 'pro' });
  const res = await download(await loadDownload());
  assert.equal(res.status, 402);
  assert.equal(res.body.message, STEMS_DENIAL);
  assert.ok(!/\bpro\b/i.test(res.body.message), 'the caller\'s own plan is not echoed');
  assert.deepEqual(Object.keys(res.body).sort(), ['error_code', 'message']);
  assert.deepEqual(globalThis.__st.minted, []);
});

test('export_wav24 is irrelevant: a plan with stems=true, wav24=false is served (kills a re-added wav24 check)', async () => {
  arrange({ plan: 'pro' });
  globalThis.__st.planPatch = { export_stems: true, export_wav24: false };
  const res = await download(await loadDownload());
  assert.equal(res.status, 200);
  assert.equal(globalThis.__st.minted.length, 1);
});

test('wav24 alone does not open the route: stems=false, wav24=true is refused (no OR-logic)', async () => {
  // Pins the other direction: export_stems is THE gate. A row that carries only
  // wav24 (an inconsistent edit to `plans`) must not become a way in.
  arrange({ plan: 'studio' });
  globalThis.__st.planPatch = { export_stems: false, export_wav24: true };
  const res = await download(await loadDownload());
  assert.equal(res.status, 402);
  assert.equal(res.body.message, STEMS_DENIAL);
  assert.deepEqual(globalThis.__st.minted, []);
});
