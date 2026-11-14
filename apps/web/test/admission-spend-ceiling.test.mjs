// The rolling 24h Replicate spend ceiling in checkAdmission() (lib/admission.ts, gate 3).
//
// Why this file exists: the mutation sweep of 2026-11-12 (W6) found that NOTHING in the web
// suite pinned this gate. Every fake DB in the suite answers the job_events SUM with '0', so
// all four of these mutants passed the full suite (1543 tests, 0 failures):
//   - `total >= ceiling` -> `total > ceiling`      (the ceiling itself is admitted)
//   - the `return BLOCKED` line deleted            (no ceiling at all)
//   - default `'10'` -> `'1000'`                   (env unset: a 100x higher ceiling)
//   - `INTERVAL '24 hours'` -> `INTERVAL '1 hour'` (the window shrinks; spend "expires" early)
//
// Instrument: the REAL admission.ts and error-copy.ts. Only the database is replaced. The fake
// answers the three statements checkAdmission() issues and throws on anything else; a throw out
// of checkAdmission is captured and compared, so a mutant that changes the SQL fails an
// assertion here rather than erroring the file out.

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
  const F = () => globalThis.__spend;
  const ok = (rows) => ({ rows, rowCount: rows.length });
  export const db = {
    query: async (sql) => {
      const s = sql.replace(/\\s+/g, ' ').trim();
      const f = F();
      f.sql.push(s);
      if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE client_ip_hash = \\$1/.test(s))
        return ok([{ count: 0 }]);
      if (/^SELECT COUNT\\(\\*\\)::int AS count FROM jobs WHERE status = ANY\\(\\$1\\)$/.test(s))
        return ok([{ count: 0 }]);
      if (/FROM job_events WHERE created_at >= NOW\\(\\) - INTERVAL '24 hours'$/.test(s))
        return ok([{ total: f.total }]);
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
const { checkAdmission } = await import(ADMISSION);

const ALLOWED = { allowed: true, error_code: null };
// F72: the spend ceiling is RATE_LIMITED with its own reason and its own sentence.
const BLOCKED = {
  allowed: false,
  error_code: 'RATE_LIMITED',
  reason: 'spend_ceiling',
  message: "We've reached today's processing limit on our end. It's not something you did. Please try again later.",
};
const admit = (total) => {
  globalThis.__spend.total = total;
  return checkAdmission('iphash').catch((e) => ({ thrown: String(e) }));
};

let saved;
beforeEach(() => {
  saved = process.env.REPLICATE_SPEND_CEILING_USD;
  delete process.env.REPLICATE_SPEND_CEILING_USD;
  globalThis.__spend = { total: '0', sql: [] };
});
afterEach(() => {
  if (saved === undefined) delete process.env.REPLICATE_SPEND_CEILING_USD;
  else process.env.REPLICATE_SPEND_CEILING_USD = saved;
});

test('spend ceiling: default is $10 per rolling 24h: $9.99 admitted, exactly $10.00 refused', async () => {
  assert.deepEqual(await admit('9.99'), ALLOWED);
  assert.deepEqual(await admit('10'), BLOCKED, 'reaching the ceiling must refuse (>=, not >)');
  assert.deepEqual(await admit('10.000001'), BLOCKED);
  assert.deepEqual(await admit('250'), BLOCKED, 'far over the ceiling must refuse');
});

test('spend ceiling: REPLICATE_SPEND_CEILING_USD overrides the default, both lower and higher', async () => {
  process.env.REPLICATE_SPEND_CEILING_USD = '2.5';
  assert.deepEqual(await admit('2.49'), ALLOWED);
  assert.deepEqual(await admit('2.5'), BLOCKED);
  process.env.REPLICATE_SPEND_CEILING_USD = '40';
  assert.deepEqual(await admit('39.99'), ALLOWED, '$10 must no longer be the ceiling');
  assert.deepEqual(await admit('40'), BLOCKED);
});

test('spend ceiling: the window is the last 24 hours of job_events, summed from cost_usd', async () => {
  assert.deepEqual(await admit('0'), ALLOWED);
  const q = globalThis.__spend.sql.find((s) => /FROM job_events/.test(s));
  assert.ok(q, 'checkAdmission must read job_events');
  assert.match(q, /SUM\(\(detail->>'cost_usd'\)::numeric\)/);
  assert.match(q, /WHERE created_at >= NOW\(\) - INTERVAL '24 hours'$/);
});

test('spend ceiling: the refusal is RATE_LIMITED and is checked after the per-client and capacity gates', async () => {
  const r = await admit('11');
  assert.deepEqual(r, BLOCKED);
  const order = globalThis.__spend.sql.map((s) =>
    /client_ip_hash/.test(s) ? 'client' : /status = ANY/.test(s) ? 'capacity' : /job_events/.test(s) ? 'spend' : '?',
  );
  assert.deepEqual(order, ['client', 'capacity', 'spend']);
});
