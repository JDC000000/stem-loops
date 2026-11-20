// #300 review R3-4 (QA-54): the demo-song read limiter must stay READ-ONLY.
//
// GET /api/jobs/:id and GET /api/jobs/:id/play-chords ask lib/demo-rate.ts whether a demo
// read is allowed. It must use admission.ts's peekStemListRate (one SELECT COUNT), never the
// recording checkStemListRate (BEGIN + advisory lock + INSERT INTO upload_rate_events): a
// limiter that records on GET is QA B-17's write-on-GET regression. Every route harness
// stubs demo-rate, so before this file nothing caught a swap of the import (review mutant
// P8 survived the whole suite).
//
// The REAL demo-rate.ts, admission.ts and client-ip.ts run here; only the db is faked, and
// it records every statement and every transaction it is asked for. No database needed.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(WEB, rel), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Answers a COUNT with globalThis.__dr.count; an INSERT ... RETURNING with one row (allowed).
const dbStub = dataUrl(`
  const answer = (t) => /^\\s*INSERT/i.test(t) ? { rows: [{ id: 1 }], rowCount: 1 }
    : /COUNT\\(/i.test(t) ? { rows: [{ count: globalThis.__dr.count }], rowCount: 1 }
    : { rows: [], rowCount: 0 };
  export const db = {
    query: async (t) => { globalThis.__dr.sql.push(String(t)); return answer(String(t)); },
    tx: async (fn) => {
      globalThis.__dr.tx += 1;
      return fn({ query: async (t) => { globalThis.__dr.sql.push(String(t)); return answer(String(t)); } });
    },
  };
`);
const secretEnv = dataUrl(toJs(read('src/lib/secret-env.ts')));
const clientIp = dataUrl(toJs(read('src/lib/client-ip.ts')).replace(/from ['"]@\/lib\/secret-env['"]/g, `from '${secretEnv}'`));
const errorCopy = dataUrl(toJs(read('src/lib/error-copy.ts')));
const admission = dataUrl(
  toJs(read('src/lib/admission.ts'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`)
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${errorCopy}'`),
);
const demoRateJs = toJs(read('src/lib/demo-rate.ts'))
  .replace(/from ['"]@\/lib\/admission['"]/g, `from '${admission}'`)
  .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIp}'`);
assert.ok(!/from ['"]@\//.test(demoRateJs), 'demo-rate.ts gained an import this harness does not wire');
const { demoReadAllowed } = await import(dataUrl(demoRateJs));

const req = { headers: { get: (h) => (h.toLowerCase() === 'x-forwarded-for' ? '203.0.113.7' : null) } };

beforeEach(() => {
  globalThis.__dr = { sql: [], tx: 0, count: 0 };
});

test('a demo read under budget is allowed and writes nothing: one SELECT, no INSERT, no transaction', async () => {
  assert.equal(await demoReadAllowed(req), true);
  const writes = globalThis.__dr.sql.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s));
  assert.deepEqual(writes, [], 'the demo limiter wrote on GET (B-17)');
  assert.equal(globalThis.__dr.tx, 0, 'the demo limiter opened a transaction (the recording limiter does)');
  assert.equal(globalThis.__dr.sql.length, 1, `expected one statement, got ${globalThis.__dr.sql.length}`);
  assert.match(globalThis.__dr.sql[0], /^\s*SELECT COUNT\(\*\)/);
  assert.match(globalThis.__dr.sql[0], /FROM upload_rate_events/);
});

test('a demo read over budget is refused, still without writing', async () => {
  globalThis.__dr.count = 10_000;
  assert.equal(await demoReadAllowed(req), false);
  assert.deepEqual(globalThis.__dr.sql.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s)), []);
  assert.equal(globalThis.__dr.tx, 0);
});
