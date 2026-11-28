// #494 item 4: the paste dedupe probe (lib/jobs/stem-artifacts.ts) has its OWN per-IP budget,
// checkPasteProbeRate, instead of spending checkStemListRate, the 60/min budget of
// GET /api/jobs/:id/stems. On a shared IP (NAT) re-pastes used to eat the player's budget (the
// stems GET answered 429), and a busy player made the probe answer "could not tell" (reuse).
// The REAL lib/admission.ts on a recording fake db; real Postgres: paste-probe-rate-pg.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

async function loadAdmission({ rowCount = 1 } = {}) {
  const dbRec = dataUrl(`
    export const db = { tx: async (fn) => fn({ query: (t, p) => db.query(t, p) }), query: async (text, params) => {
      if (/pg_advisory_xact_lock/.test(text)) { globalThis.__ppLocks.push(params[0]); return { rows: [{}], rowCount: 1 }; }
      globalThis.__pp.push({ text, params });
      return { rows: [], rowCount: ${rowCount} };
    } };`);
  const errorCopy = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8')));
  const js = toJs(readFileSync(join(WEB, 'src/lib/admission.ts'), 'utf8'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbRec}'`)
    .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${errorCopy}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}
const reset = () => { globalThis.__pp = []; globalThis.__ppLocks = []; };

test('checkPasteProbeRate counts under its OWN key: never the stems (player) or uploads counter', async () => {
  reset();
  const m = await loadAdmission();
  await m.checkPasteProbeRate('deadbeef');
  await m.checkStemListRate('deadbeef');
  await m.checkUploadRate('deadbeef');
  const [probe, stems, uploads] = globalThis.__pp.map((q) => q.params[0]);
  assert.equal(probe, 'paste-probe:deadbeef');
  assert.equal(stems, 'stems:deadbeef');
  assert.equal(uploads, 'deadbeef');
  assert.equal(new Set([probe, stems, uploads]).size, 3, 'three independent budgets');
  // Serialised on its own advisory key, so it never contends with the player's counter.
  assert.deepEqual(globalThis.__ppLocks, ['paste-probe:deadbeef', 'stems:deadbeef', 'deadbeef']);
  // The same proven atomic check-and-record statement (no migration: the upload_rate_events table).
  const sql = globalThis.__pp[0].text.replace(/\s+/g, ' ');
  assert.match(sql, /INSERT INTO upload_rate_events/);
  assert.match(sql, /SELECT COUNT\(\*\) FROM upload_rate_events/);
});

test('checkPasteProbeRate admits 30/min/IP by default; env-tunable; a bad value falls back to 30', async () => {
  reset();
  delete process.env.PASTE_PROBE_RATE_LIMIT;
  const m = await loadAdmission();
  assert.equal(m.DEFAULT_PASTE_PROBE_RATE_LIMIT, 30);
  await m.checkPasteProbeRate('ip');
  assert.equal(globalThis.__pp[0].params[2], 30, 'default ceiling');
  assert.equal(globalThis.__pp[0].params[1], 60_000, 'rolling 60 s window');
  for (const [raw, want] of [['5', 5], ['0', 30], ['-3', 30], ['abc', 30], ['2.5', 30]]) {
    reset();
    process.env.PASTE_PROBE_RATE_LIMIT = raw;
    const warn = console.warn; console.warn = () => {};
    try { await (await loadAdmission()).checkPasteProbeRate('ip'); } finally { console.warn = warn; }
    assert.equal(globalThis.__pp[0].params[2], want, `PASTE_PROBE_RATE_LIMIT=${raw}`);
  }
  delete process.env.PASTE_PROBE_RATE_LIMIT;
});

test('checkPasteProbeRate BLOCKS when the atomic insert records no row', async () => {
  reset();
  assert.equal((await (await loadAdmission({ rowCount: 0 })).checkPasteProbeRate('ip')).allowed, false);
  reset();
  assert.equal((await (await loadAdmission({ rowCount: 1 })).checkPasteProbeRate('ip')).allowed, true);
});
