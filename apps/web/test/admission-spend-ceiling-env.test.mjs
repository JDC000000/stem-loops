// REPLICATE_SPEND_CEILING_USD must never fail OPEN on a bad value.
//
// Why this file exists: the W6 mutation sweep (2026-11-12) found that admission.ts read the
// ceiling as `parseFloat(process.env.REPLICATE_SPEND_CEILING_USD ?? '10')` with no validation.
// A typo such as "ten" or "$10" (or an empty string, which `??` does not replace) gives NaN,
// `total >= NaN` is always false, and the 24h spend ceiling never trips: the <$30/mo Replicate
// hard-cap defence silently disappears. ADMISSION_MAX_IN_FLIGHT is already guarded against
// exactly this (see maxInFlight()); this pins the same guard for the spend ceiling.
//
// Scope: ONLY malformed / non-positive env values. The ceiling's boundary (>=), its $10 default
// with the env unset, valid overrides and the 24h window are pinned by
// test/admission-spend-ceiling.test.mjs in draft PR #246 (W6, tests only); not duplicated here.
//
// Instrument: the REAL admission.ts and error-copy.ts. Only the database is replaced. The fake
// answers the three statements checkAdmission() issues and throws on anything else.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(WEB, 'src', p);
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => toJs(readFileSync(SRC(p), 'utf8'));

const dbStub = dataUrl(`
  const ok = (rows) => ({ rows, rowCount: rows.length });
  export const db = {
    query: async (sql) => {
      const s = sql.replace(/\\s+/g, ' ').trim();
      if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE client_ip_hash = \\$1/.test(s))
        return ok([{ count: 0 }]);
      if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE status = ANY\\(\\$1\\)$/.test(s))
        return ok([{ count: 0 }]);
      if (/FROM job_events WHERE created_at >= NOW\\(\\) - INTERVAL '24 hours'$/.test(s))
        return ok([{ total: globalThis.__ceil.total }]);
      throw new Error('fake db: unrecognised SQL: ' + s.slice(0, 160));
    },
  };
`);

const ERRCOPY = dataUrl(read('lib/error-copy.ts'));
const ADMISSION = dataUrl(
  read('lib/admission.ts')
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${ERRCOPY}'`),
);
// A fresh module instance per test, so the "warn once per process" flag starts clean.
let fresh = 0;
const freshAdmission = () => import(ADMISSION + '#fresh' + ++fresh);

const ALLOWED = { allowed: true, error_code: null };
const BLOCKED = { allowed: false, error_code: 'RATE_LIMITED' };
const admit = (mod, total) => {
  globalThis.__ceil.total = total;
  return mod.checkAdmission('iphash').catch((e) => ({ thrown: String(e) }));
};
const captureWarns = async (fn) => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warns;
};

let saved;
beforeEach(() => {
  saved = process.env.REPLICATE_SPEND_CEILING_USD;
  delete process.env.REPLICATE_SPEND_CEILING_USD;
  globalThis.__ceil = { total: '0' };
});
afterEach(() => {
  if (saved === undefined) delete process.env.REPLICATE_SPEND_CEILING_USD;
  else process.env.REPLICATE_SPEND_CEILING_USD = saved;
});

const GARBAGE = ['ten', '$10', 'NaN', '10abc', '0', '-5', '-0', 'Infinity', '1e999', '10,00', 'abc10'];

test('garbage REPLICATE_SPEND_CEILING_USD fails CLOSED to the $10 default, never open', async () => {
  const mod = await freshAdmission();
  const warns = await captureWarns(async () => {
    for (const bad of GARBAGE) {
      process.env.REPLICATE_SPEND_CEILING_USD = bad;
      assert.deepEqual(await admit(mod, '9.99'), ALLOWED, `"${bad}": $9.99 is under the $10 default`);
      assert.deepEqual(await admit(mod, '10'), BLOCKED, `"${bad}": $10 must trip the default ceiling`);
      assert.deepEqual(await admit(mod, '5000'), BLOCKED, `"${bad}": $5000 must never be admitted`);
    }
  });
  assert.equal(warns.length, 1, 'logged once per process, not once per request');
  assert.match(warns[0], /REPLICATE_SPEND_CEILING_USD/);
  assert.match(warns[0], /10/);
});

test('empty / whitespace REPLICATE_SPEND_CEILING_USD is the silent $10 default (?? does not catch "")', async () => {
  const mod = await freshAdmission();
  const warns = await captureWarns(async () => {
    for (const blank of ['', '   ']) {
      process.env.REPLICATE_SPEND_CEILING_USD = blank;
      assert.deepEqual(await admit(mod, '9.99'), ALLOWED, `${JSON.stringify(blank)}: under the default`);
      assert.deepEqual(await admit(mod, '10'), BLOCKED, `${JSON.stringify(blank)}: at the default`);
    }
  });
  assert.equal(warns.length, 0, 'blank is "unset", not a typo');
});

test('well-formed values are still honoured (padded, decimal), and do not warn', async () => {
  const mod = await freshAdmission();
  const warns = await captureWarns(async () => {
    process.env.REPLICATE_SPEND_CEILING_USD = ' 2.5 ';
    assert.deepEqual(await admit(mod, '2.49'), ALLOWED);
    assert.deepEqual(await admit(mod, '2.5'), BLOCKED);
    process.env.REPLICATE_SPEND_CEILING_USD = '40';
    assert.deepEqual(await admit(mod, '39.99'), ALLOWED);
    assert.deepEqual(await admit(mod, '40'), BLOCKED);
    process.env.REPLICATE_SPEND_CEILING_USD = '0.75';
    assert.deepEqual(await admit(mod, '0.74'), ALLOWED);
    assert.deepEqual(await admit(mod, '0.75'), BLOCKED);
  });
  assert.equal(warns.length, 0);
});

test('spendCeilingUsd() is exported and returns the effective ceiling', async () => {
  const mod = await freshAdmission();
  await captureWarns(async () => {
    assert.equal(typeof mod.spendCeilingUsd, 'function');
    assert.equal(mod.DEFAULT_SPEND_CEILING_USD, 10);
    delete process.env.REPLICATE_SPEND_CEILING_USD;
    assert.equal(mod.spendCeilingUsd(), 10);
    process.env.REPLICATE_SPEND_CEILING_USD = '$10';
    assert.equal(mod.spendCeilingUsd(), 10);
    process.env.REPLICATE_SPEND_CEILING_USD = '25';
    assert.equal(mod.spendCeilingUsd(), 25);
  });
});
