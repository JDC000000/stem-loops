// Prove the chord-chip gate is not vacuous: apply each known-bad edit to
// ChordOverlay.tsx, confirm the edit is VALID (tsc exits 0), run the gate and
// require it to FAIL, then restore the file BY COPY and prove the restore.
//
//   node scripts/prove-non-vacuous.mjs <path-to-apps/web> [mutation-name ...]
//
// Standing rules this follows (claude/agent-environment-facts.md, MUTATION TESTING):
//   1. the mutant must compile -- an invalid mutant "kills" by crashing, which
//      looks identical to a kill (tsc --noEmit must exit 0);
//   2. the anchor must occur EXACTLY ONCE -- zero is a skip, not a pass;
//   3. restore by COPY, never `git checkout --` (that silently reverts
//      uncommitted edits); prove it with sha256 AND `git diff --quiet`;
//   4. capture WHICH gate fired, not just that something went red.
//
// It edits a real source file in place. Run it on a checkout you are not using.
// This is an on-demand tool, not part of CI: it runs the whole gate once per
// mutation.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_PKG = resolve(HERE, '..');
const WEB = resolve(process.argv[2] ?? '');
const only = process.argv.slice(3);
if (!process.argv[2]) {
  console.error('usage: prove-non-vacuous.mjs <path-to-apps/web> [mutation ...]');
  process.exit(2);
}
const FILE = join(WEB, 'src/components/ChordOverlay.tsx');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const LABEL = "{density === 'tick' ? null : text}";
const CSS_ANCHOR = '.co-scroll{scrollbar-width:auto;scrollbar-color:rgba(255,255,255,.55) rgba(255,255,255,.12)}';
const HOOK_ANCHOR = 'const canZoomFurther = pps < maxPps * 0.999;';
const effect = (assign) =>
  `${HOOK_ANCHOR}\n  useEffect(() => {\n    document\n      .querySelectorAll<HTMLButtonElement>('[data-testid^="chord-chip-"]')\n      .forEach((b) => {\n        ${assign}\n      });\n  });`;

const MUTATIONS = [
  { name: 'span-wrapper', anchor: LABEL,
    to: "{density === 'tick' ? null : <span style={{ letterSpacing: '0.05em', fontWeight: 700 }}>{text}</span>}" },
  { name: 'bare-b', anchor: LABEL, to: "{density === 'tick' ? null : <b>{text}</b>}" },
  { name: 'stylesheet-border-important', anchor: CSS_ANCHOR,
    to: `${CSS_ANCHOR}\n.co-scroll button{border:4px solid transparent !important}` },
  // The wrapped (<560px) layout has no .co-scroll ancestor, so the rule above
  // cannot reach it; this variant selects the chips themselves and does.
  { name: 'stylesheet-border-important-chip-selector', anchor: CSS_ANCHOR,
    to: `${CSS_ANCHOR}\n[data-testid^="chord-chip-"]{border:4px solid transparent !important}` },
  { name: 'imperative-padding', anchor: HOOK_ANCHOR, to: effect("b.style.padding = '0 14px';") },
  { name: 'imperative-border', anchor: HOOK_ANCHOR, to: effect("b.style.border = '4px solid transparent';") },
  { name: 'height-quarter', anchor: 'height: `${heightPx}px`,', to: 'height: `${heightPx / 4}px`,' },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}
function gate() {
  return run('node', ['--experimental-strip-types', '--test', 'test/chord-chip-fit.test.mjs'], {
    cwd: GATE_PKG,
    env: { ...process.env, CHORD_GATE_SRC: WEB },
  });
}
function summarise(out) {
  const lines = out.split('\n');
  const verdicts = lines.filter((l) => /^(not )?ok \d+ - /.test(l));
  const tests = /^# tests (\d+)/m.exec(out)?.[1];
  const pass = /^# pass (\d+)/m.exec(out)?.[1];
  const fail = /^# fail (\d+)/m.exec(out)?.[1];
  const firstErr = lines.findIndex((l) => l.includes('chord chip(s) have text sticking out'));
  return { verdicts, tests, pass, fail, firstErr: firstErr >= 0 ? lines.slice(firstErr, firstErr + 4).map((l) => l.trim()) : [] };
}

const scratch = mkdtempSync(join(tmpdir(), 'chip-gate-'));
const SNAP = join(scratch, 'ChordOverlay.tsx.orig');
copyFileSync(FILE, SNAP);
const SHA0 = sha(FILE);
const restore = () => copyFileSync(SNAP, FILE);
process.on('exit', () => { try { restore(); } catch {} });
process.on('SIGINT', () => process.exit(130));

console.log(`target ${FILE}\nsha256 before: ${SHA0}`);
const base = run('git', ['-C', WEB, 'diff', '--quiet']);
console.log(`git diff --quiet before: exit ${base.status}`);
if (base.status !== 0) { console.error('working tree is dirty; refusing to mutate'); process.exit(2); }

let exit = 0;
const baseline = summarise(gate().stdout);
console.log(`\n=== BASELINE (unmutated) ===\n${baseline.verdicts.join('\n')}\n# tests ${baseline.tests} pass ${baseline.pass} fail ${baseline.fail}`);
if (baseline.fail !== '0') { console.error('baseline is not green; a kill would prove nothing'); process.exit(2); }

for (const m of MUTATIONS) {
  if (only.length && !only.includes(m.name)) continue;
  console.log(`\n=== MUTATION ${m.name} ===`);
  const src = readFileSync(SNAP, 'utf8');
  const count = src.split(m.anchor).length - 1;
  console.log(`anchor occurrences: ${count}`);
  if (count !== 1) { console.log('SKIP (anchor must occur exactly once)'); exit = 1; continue; }
  writeFileSync(FILE, src.replace(m.anchor, () => m.to));
  const tsc = run('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: WEB });
  console.log(`tsc --noEmit exit: ${tsc.status}`);
  if (tsc.status !== 0) { console.log(tsc.stdout.slice(0, 800)); console.log('SKIP (invalid mutant)'); restore(); exit = 1; continue; }
  const r = summarise(gate().stdout);
  console.log(r.verdicts.join('\n'));
  console.log(`# tests ${r.tests} pass ${r.pass} fail ${r.fail}`);
  console.log(r.firstErr.join('\n'));
  const killed = r.fail !== '0' && Number(r.fail) > 0;
  console.log(killed ? `KILLED by the gate (${r.fail} failing)` : 'SURVIVED  <-- the gate is blind to this');
  if (!killed) exit = 1;
  restore();
  const same = sha(FILE) === SHA0;
  const clean = run('git', ['-C', WEB, 'diff', '--quiet']).status === 0;
  console.log(`restored by copy: sha256 ${same ? 'MATCH' : 'MISMATCH'}, git diff --quiet exit ${clean ? 0 : 1}`);
  if (!same || !clean) { exit = 1; console.log('RESTORE FAILED'); }
}
console.log(`\nsha256 after: ${sha(FILE)}  (${sha(FILE) === SHA0 ? 'identical' : 'DIFFERENT'})`);
process.exit(exit);
