// Landing copy gate: the demo's alignment claims must match the measured v3 demo
// (documents/stem-loops-landing/demo-assets-v3/FINDINGS.md), and claims that were never true
// (or describe the pre-tempo-fit pipeline) must not come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const LANDING = [...walk(join(WEB, 'src/app/(landing)')), ...walk(join(WEB, 'src/components/landing'))]
  .filter((p) => /\.(tsx?|css)$/.test(p))
  .map((p) => [p.slice(WEB.length + 1), readFileSync(p, 'utf8')]);

test('no pre-tempo-fit numbers or never-true claims in the landing', () => {
  const banned = [
    /\b31\s*(?:&nbsp;|\\u00a0| )?ms/i, /\b62\s*(?:&nbsp;|\\u00a0| )?ms/i, /\b124\s*(?:&nbsp;|\\u00a0| )?ms/i,
    /20 ms after/i, /repeats? (?:run|runs) long/i, /time.stretch/i, /101\.3/, /cut to the bar/i,
    /starts on the downbeat/i, /no drift/i, /zero drift/i, /drift-free/i, /phase-locked/i, /sample-accurate/i,
  ];
  for (const [file, src] of LANDING) for (const re of banned) assert.doesNotMatch(src, re, `${file} matches ${re}`);
});

test('the H1 stays "Paste a song. Get bar-length loops."', () => {
  const page = LANDING.find(([f]) => f.endsWith('(landing)/page.tsx'))[1];
  assert.match(page, /Paste a song\.<\/span> <span className="h1-line">Get bar&#8209;length loops\./);
});

test('drift is stated as a per-length upper bound, never zero', async () => {
  const src = readFileSync(join(WEB, 'src/components/landing/demo-data.ts'), 'utf8').replace(/^import .*$/m, 'const DEMO_DATA_BASE = "", DEMO_BEFORE_PEAKS_URL = "";');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { driftBoundMs } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  // FINDINGS v3: |drift| 0.9 / 1.8 / 0.6 / 5.7 ms at 1 / 2 / 4 / 8 bars
  const measured = { 1: 0.9, 2: 1.8, 4: 0.6, 8: 5.7 };
  for (const [bars, ms] of Object.entries(measured)) {
    const bound = driftBoundMs(+bars);
    assert.ok(bound > 0, `bound for ${bars} bars must not be zero`);
    assert.ok(bound > ms, `bound ${bound} ms must exceed the measured ${ms} ms at ${bars} bars`);
  }
});

test('the landing reads the v3 demo set', () => {
  const cfg = readFileSync(join(WEB, 'src/lib/public-config.ts'), 'utf8');
  assert.match(cfg, /'demo-assets-v3\/'/);
  assert.match(cfg, /'assets-v3\/'/);
  assert.match(cfg, /lucky_ticket_drums_102\.0bpm_G_minor_verse_0006\.wav/);
});
