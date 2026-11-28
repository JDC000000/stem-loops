// Beta QA S12 / QW-5 (#489): POST /api/uploads tells a SIGNED-IN caller who is out of songs
// (or credits) BEFORE it mints the presigned PUT, so the browser does not upload up to 200 MB
// only for POST /api/jobs to refuse the job. The check is the upload path's two read-only gates
// (enforceEntitlement('start_job_upload') then checkMonthlyQuota) with the same 402 bodies;
// it must not spend anything (no burst attempt, no counter) and signed-out callers skip it.
//
// The REAL route, error-copy.ts and create-link-job.ts (quotaRefusalBody) run. Admission, auth,
// R2 and the two billing gates are recording stubs.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE, SAME_ORIGIN_HEADERS } from './helpers/same-origin.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => toJs(readFileSync(join(WEB, 'src', p), 'utf8'));

const ERRCOPY = dataUrl(read('lib/error-copy.ts'));
const LINK_JOB = dataUrl(read('lib/jobs/create-link-job.ts'));
const S = () => globalThis.__uq;
const stub = {
  next: dataUrl(`
    export class NextResponse {
      constructor(body, init) { this.status = (init && init.status) || 200; }
      static json(obj, init) { const r = new NextResponse(null, init); r.body = obj; return r; }
    }
    export class NextRequest {}`),
  sentry: dataUrl(`export const captureException = () => { globalThis.__uq.calls.push('sentry'); };`),
  clientIp: dataUrl(`export const clientIpHashOf = () => 'ip-a';`),
  auth: dataUrl(`export const getUser = async () => { globalThis.__uq.calls.push('getUser'); return globalThis.__uq.user; };`),
  admission: dataUrl(`
    const c = (n) => globalThis.__uq.calls.push(n);
    export const checkUploadRate = async () => { c('checkUploadRate'); return { allowed: true }; };
    export const checkGlobalCapacity = async () => { c('checkGlobalCapacity'); return { allowed: true }; };
    export const checkAnonUploadDailyRate = async () => { c('checkAnonUploadDailyRate'); return { allowed: true }; };
    export const recordAnonPresign = async () => { c('recordAnonPresign'); };`),
  upload: dataUrl(`
    export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
    export const validateUpload = () => globalThis.__uq.valid
      ? { ok: true, ext: 'mp3', contentType: 'audio/mpeg' }
      : { ok: false, error_code: 'UPLOAD_INVALID', message: 'bad file' };`),
  r2: dataUrl(`export const presignPut = async (key) => { globalThis.__uq.minted.push(key); return 'https://r2.example/put'; };`),
  ent: dataUrl(`
    export class EntitlementError extends Error {
      constructor(code, message, status = 402) { super(message ?? code); this.code = code; this.status = status; }
    }
    export async function enforceEntitlement(action, userId) {
      globalThis.__uq.calls.push('enforceEntitlement:' + action + ':' + userId);
      const e = globalThis.__uq.entErr;
      if (e === 'boom') throw new Error('db down');
      if (e) throw new EntitlementError(e.code, e.message, e.status);
      return { allowed: true, snapshot: globalThis.__uq.snap };
    }`),
  rate: dataUrl(`
    export async function checkMonthlyQuota(userId) { globalThis.__uq.calls.push('checkMonthlyQuota:' + userId); return globalThis.__uq.quota; }
    export async function checkBurstLimit() { globalThis.__uq.calls.push('checkBurstLimit'); return null; }`),
};
const route = await import(
  dataUrl(
    read('app/api/uploads/route.ts')
      .replace(/from ['"]@\/lib\/admission['"]/g, `from '${stub.admission}'`)
      .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${ERRCOPY}'`)
      .replace(/from ['"]@\/lib\/jobs\/create-link-job['"]/g, `from '${LINK_JOB}'`)
      .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${stub.ent}'`)
      .replace(/from ['"]@\/lib\/billing\/rate-limit['"]/g, `from '${stub.rate}'`)
      .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${stub.clientIp}'`)
      .replace(/from ['"]@\/lib\/upload['"]/g, `from '${stub.upload}'`)
      .replace(/from ['"]@\/lib\/r2['"]/g, `from '${stub.r2}'`)
      .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${stub.auth}'`)
      .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${stub.sentry}'`)
      .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
      .replace(/from ['"]next\/server['"]/g, `from '${stub.next}'`),
  )
);
const { entitlementMessage } = await import(ERRCOPY);

const U = 'u-1';
const RESETS = '2026-12-01T00:00:00.000Z';
const presign = () =>
  route.POST({ json: async () => ({ filename: 'song.mp3', size: 1_000_000 }), headers: new Headers(SAME_ORIGIN_HEADERS) });
const gates = () => S().calls.filter((c) => /^(enforceEntitlement|checkMonthlyQuota|checkBurstLimit)/.test(c));

beforeEach(() => {
  globalThis.__uq = {
    user: { user_id: U },
    snap: { plan_code: 'free', jobs_quota: 5, jobs_used: 5, credits_remaining: 0 },
    quota: null,
    entErr: null,
    valid: true,
    calls: [],
    minted: [],
  };
});

test('free account out of monthly songs -> 402 with the free quota sentence, nothing minted', async () => {
  S().quota = { kind: 'quota_exceeded', resets_at: RESETS };
  const r = await presign();
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, {
    error: 'monthly quota reached',
    code: 'quota_exceeded',
    resets_at: RESETS,
    error_code: 'FREE_MONTHLY_QUOTA_EXHAUSTED',
    message: entitlementMessage('FREE_MONTHLY_QUOTA_EXHAUSTED'),
  });
  assert.deepEqual(S().minted, [], 'no PUT URL for a job that would be refused');
  assert.deepEqual(gates(), [`enforceEntitlement:start_job_upload:${U}`, `checkMonthlyQuota:${U}`]);
});

for (const plan of ['pro', 'studio']) {
  test(`${plan} at the plan allowance (checkMonthlyQuota) -> 402 with the plan sentence, nothing minted`, async () => {
    S().snap = { plan_code: plan, jobs_quota: 100, jobs_used: 100, credits_remaining: 0 };
    S().quota = { kind: 'quota_exceeded', resets_at: RESETS };
    const r = await presign();
    assert.equal(r.status, 402);
    assert.equal(r.body.error_code, 'ENTITLEMENT_UNAVAILABLE');
    assert.equal(r.body.code, 'quota_exceeded');
    assert.equal(r.body.message, entitlementMessage('ENTITLEMENT_UNAVAILABLE', 'quota exhausted'));
    assert.deepEqual(S().minted, []);
  });
}

test('the entitlement gate refuses (e.g. paid quota exhausted) -> its status, code and sentence, nothing minted', async () => {
  S().entErr = { code: 'ENTITLEMENT_UNAVAILABLE', message: 'quota exhausted', status: 402 };
  const r = await presign();
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, {
    error_code: 'ENTITLEMENT_UNAVAILABLE',
    message: entitlementMessage('ENTITLEMENT_UNAVAILABLE', 'quota exhausted'),
  });
  assert.deepEqual(S().minted, []);
  assert.deepEqual(gates(), [`enforceEntitlement:start_job_upload:${U}`], 'quota is not read after a refusal');
});

test('an EntitlementError keeps its own status (not forced to 402)', async () => {
  S().entErr = { code: 'CREDIT_BALANCE_INSUFFICIENT', message: 'no credits', status: 403 };
  const r = await presign();
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, 'CREDIT_BALANCE_INSUFFICIENT');
  assert.equal(r.body.message, entitlementMessage('CREDIT_BALANCE_INSUFFICIENT', 'no credits'));
  assert.deepEqual(S().minted, []);
});

test('an unexpected gate failure -> 500, nothing minted', async () => {
  S().entErr = 'boom';
  const r = await presign();
  assert.equal(r.status, 500);
  assert.equal(r.body.error_code, 'INTERNAL_ERROR');
  assert.deepEqual(S().minted, []);
});

test('under quota -> 200 and minted; no burst attempt is recorded and the anon daily cap is not used', async () => {
  S().snap = { plan_code: 'free', jobs_quota: 5, jobs_used: 2, credits_remaining: 0 };
  const r = await presign();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(S().minted.length, 1);
  assert.deepEqual(gates(), [`enforceEntitlement:start_job_upload:${U}`, `checkMonthlyQuota:${U}`]);
  assert.ok(!S().calls.includes('checkAnonUploadDailyRate'));
  assert.ok(!S().calls.includes('recordAnonPresign'));
});

test('signed out -> the billing gates are not called; the anon daily cap still is', async () => {
  S().user = null;
  S().quota = { kind: 'quota_exceeded', resets_at: RESETS };
  const r = await presign();
  assert.equal(r.status, 200);
  assert.deepEqual(gates(), []);
  assert.ok(S().calls.includes('checkAnonUploadDailyRate'));
  assert.ok(S().calls.includes('recordAnonPresign'));
});

test('cheap refusals first: an invalid file is 400 before any billing read', async () => {
  S().valid = false;
  S().quota = { kind: 'quota_exceeded', resets_at: RESETS };
  const r = await presign();
  assert.equal(r.status, 400);
  assert.deepEqual(gates(), []);
  const order = S().calls.filter((c) => c === 'checkUploadRate' || c === 'checkGlobalCapacity');
  assert.deepEqual(order, ['checkUploadRate', 'checkGlobalCapacity']);
});
