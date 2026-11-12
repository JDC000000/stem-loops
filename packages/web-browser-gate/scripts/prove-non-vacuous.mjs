// Prove the chord-chip gate is not vacuous: apply each known-bad edit to
// ChordOverlay.tsx, confirm the edit is VALID (tsc exits 0), run the gate and
// require it to FAIL, then restore the file BY COPY and prove the restore.
//
//   node scripts/prove-non-vacuous.mjs <path-to-apps/web> [mutation-name ...]
//
// A KILL IS A REAL ASSERTION FAILURE, NOT "SOMETHING WENT RED". Round 1 counted
// any failure as a kill, which includes a crash: an esbuild error, a page
// timeout, a TypeError in the test file. `node --test` reports all of those as
// `not ok`, indistinguishable from a kill by exit code or by fail count. Here a
// mutant is KILLED only if (1) the suite still reports the baseline test count,
// (2) the setup test passed, (3) at least one `not ok` is an ERR_ASSERTION
// whose message carries the gate's own `GATE-FAIL` tag, and (4) EVERY `not ok`
// is of that kind. Anything else failing is a CRASH, which is rejected (exit 1)
// and is never counted as a kill.
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
const TSX = 'src/components/ChordOverlay.tsx';
const CSS = 'src/app/globals.css';
const abs = (f) => join(WEB, f);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const LABEL = "{density === 'tick' ? null : text}";
const CSS_ANCHOR = '.co-scroll{scrollbar-width:auto;scrollbar-color:rgba(255,255,255,.55) rgba(255,255,255,.12)}';
const HOOK_ANCHOR = 'const canZoomFurther = pps < maxPps * 0.999;';
const CHIP_STYLE = "const chipStyle: CSSProperties = {\n  background: '#1e40af',";
const COLOR_ANCHOR = "const chipStyle: CSSProperties = {\n  background: '#1e40af',\n  color: '#fff',";
const CONTAINER_ANCHOR = "  minHeight: '96px',\n";
const GLOBAL_ANCHOR = '* {\n  font-synthesis: none;\n}';
const PAD_ANCHOR = '`0 ${CHIP_FULL_PAD_PX / 2}px`';
const effect = (assign) =>
  `${HOOK_ANCHOR}\n  useEffect(() => {\n    document\n      .querySelectorAll<HTMLButtonElement>('[data-testid^="chord-chip-"]')\n      .forEach((b) => {\n        ${assign}\n      });\n  });`;

// `file` is the file the anchor lives in. Each mutation edits exactly one.
const MUTATIONS = [
  // ---- round 1 -----------------------------------------------------------
  { name: 'span-wrapper', file: TSX, anchor: LABEL,
    to: "{density === 'tick' ? null : <span style={{ letterSpacing: '0.05em', fontWeight: 700 }}>{text}</span>}" },
  { name: 'bare-b', file: TSX, anchor: LABEL, to: "{density === 'tick' ? null : <b>{text}</b>}" },
  { name: 'stylesheet-border-important', file: TSX, anchor: CSS_ANCHOR,
    to: `${CSS_ANCHOR}\n.co-scroll button{border:4px solid transparent !important}` },
  // The wrapped (<560px) layout has no .co-scroll ancestor, so the rule above
  // cannot reach it; this variant selects the chips themselves and does.
  { name: 'stylesheet-border-important-chip-selector', file: TSX, anchor: CSS_ANCHOR,
    to: `${CSS_ANCHOR}\n[data-testid^="chord-chip-"]{border:4px solid transparent !important}` },
  { name: 'imperative-padding', file: TSX, anchor: HOOK_ANCHOR, to: effect("b.style.padding = '0 14px';") },
  { name: 'imperative-border', file: TSX, anchor: HOOK_ANCHOR, to: effect("b.style.border = '4px solid transparent';") },
  { name: 'height-quarter', file: TSX, anchor: 'height: `${heightPx}px`,', to: 'height: `${heightPx / 4}px`,' },
  // ---- round 2, block 1: a sub-pixel defect Chromium visibly ellipsizes -----
  { name: 'padding-plus-0.1px', file: TSX, anchor: PAD_ANCHOR, to: '`0 ${CHIP_FULL_PAD_PX / 2 + 0.1}px`' },
  { name: 'container-tabular-nums', file: TSX, anchor: CONTAINER_ANCHOR,
    to: `${CONTAINER_ANCHOR}  fontVariantNumeric: 'tabular-nums',\n` },
  // ---- round 2, block 2: the font-family and font-style channels ------------
  { name: 'globals-button-monospace', file: CSS, anchor: GLOBAL_ANCHOR,
    to: `${GLOBAL_ANCHOR}\nbutton{font-family:ui-monospace,monospace}` },
  { name: 'chipstyle-fontfamily-monospace', file: TSX, anchor: CHIP_STYLE,
    to: `${CHIP_STYLE}\n  fontFamily: 'monospace',` },
  { name: 'stylesheet-chip-fontfamily-monospace', file: TSX, anchor: CSS_ANCHOR,
    to: `${CSS_ANCHOR}\n[data-testid^="chord-chip-"]{font-family:monospace}` },
  { name: 'effect-fontfamily-monospace', file: TSX, anchor: HOOK_ANCHOR, to: effect("b.style.fontFamily = 'monospace';") },
  { name: 'chipstyle-fontstyle-italic', file: TSX, anchor: CHIP_STYLE,
    to: `${CHIP_STYLE}\n  fontStyle: 'italic',` },
  // ---- round 2, also-fix --------------------------------------------------
  // most names vanish while the chip still claims a full density
  { name: 'names-vanish', file: TSX, anchor: LABEL,
    to: "{density === 'tick' || text.length > 3 ? null : text}" },
  // the N.C. excuse must not hide a regression on that chip
  { name: 'bare-b-on-N.C.-only', file: TSX, anchor: LABEL,
    to: "{density === 'tick' ? null : run.kind === 'none' ? <b>{text}</b> : text}" },
  // invisible text
  { name: 'chipstyle-opacity-0', file: TSX, anchor: CHIP_STYLE, to: `${CHIP_STYLE}\n  opacity: 0,` },
  // CONTROL, not a mutant of the product: a file that compiles (tsc exit 0) but
  // cannot be bundled. It must be classified CRASH. If this ever reads KILLED,
  // the classifier is counting crashes as kills again.
  { name: 'control-unbundleable', file: TSX, expect: 'CRASH', anchor: 'const GUTTER_PX = 44;',
    to: "// @ts-ignore\nimport 'does-not-exist-zzz';\nconst GUTTER_PX = 44;" },
  { name: 'chipstyle-color-transparent', file: TSX, anchor: COLOR_ANCHOR, to: "const chipStyle: CSSProperties = {\n  background: '#1e40af',\n  color: 'transparent'," },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}
function gate() {
  return run('node', ['--experimental-strip-types', '--test', '--test-reporter=tap', 'test/chord-chip-fit.test.mjs'], {
    cwd: GATE_PKG,
    env: { ...process.env, CHORD_GATE_SRC: WEB },
  });
}

// Parse top-level TAP into [{ ok, n, title, code, name, error }]. node:test
// writes, for a failure, an indented YAML block with `code:` and `error:`.
export function parseTap(out) {
  const lines = out.split('\n');
  const tests = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not )?ok (\d+) - (.*)$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    const block = [];
    while (j < lines.length && lines[j].startsWith('  ') && lines[j] !== '  ...') block.push(lines[j++]);
    const text = block.join('\n');
    tests.push({
      ok: !m[1], n: Number(m[2]), title: m[3], block: text,
      code: /^ {2}code: '?([A-Z_]+)'?$/m.exec(text)?.[1] ?? null,
      name: /^ {2}name: '?(\w+)'?$/m.exec(text)?.[1] ?? null,
    });
  }
  return {
    tests,
    count: Number(/^# tests (\d+)/m.exec(out)?.[1] ?? NaN),
    pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN),
    fail: Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN),
    cancelled: Number(/^# cancelled (\d+)/m.exec(out)?.[1] ?? NaN),
  };
}
const isGateAssertion = (t) => !t.ok && t.code === 'ERR_ASSERTION' && t.name === 'AssertionError' && t.block.includes('GATE-FAIL');

// KILLED | SURVIVED | CRASH (+ why)
export function classify(parsed, baselineCount) {
  if (parsed.count !== baselineCount)
    return { verdict: 'CRASH', why: `suite reported ${parsed.count} tests, baseline has ${baselineCount}` };
  const setup = parsed.tests.find((t) => t.n === 1);
  if (!setup || !setup.ok) return { verdict: 'CRASH', why: 'the setup test (bundle + launch) did not pass' };
  const bad = parsed.tests.filter((t) => !t.ok);
  if (parsed.cancelled > 0) return { verdict: 'CRASH', why: `${parsed.cancelled} cancelled test(s)` };
  const nonAssert = bad.filter((t) => !isGateAssertion(t));
  if (nonAssert.length)
    return {
      verdict: 'CRASH',
      why: `${nonAssert.length} failing test(s) are not gate assertions: ` +
        nonAssert.slice(0, 3).map((t) => `#${t.n} code=${t.code} name=${t.name}`).join('; '),
    };
  if (bad.length === 0) return { verdict: 'SURVIVED', why: 'every test passed' };
  return { verdict: 'KILLED', why: `${bad.length} test(s) failed with a GATE-FAIL assertion` };
}

if (import.meta.url === `file://${process.argv[1]}`) main();

function main() {
  const files = [...new Set(MUTATIONS.map((m) => m.file))];
  const scratch = mkdtempSync(join(tmpdir(), 'chip-gate-'));
  const SNAP = Object.fromEntries(files.map((f, i) => [f, join(scratch, `orig-${i}`)]));
  for (const f of files) copyFileSync(abs(f), SNAP[f]);
  const SHA0 = Object.fromEntries(files.map((f) => [f, sha(abs(f))]));
  const restore = () => { for (const f of files) copyFileSync(SNAP[f], abs(f)); };
  process.on('exit', () => { try { restore(); } catch {} });
  process.on('SIGINT', () => process.exit(130));

  for (const f of files) console.log(`target ${abs(f)}\nsha256 before: ${SHA0[f]}`);
  const base = run('git', ['-C', WEB, 'diff', '--quiet']);
  console.log(`git diff --quiet before: exit ${base.status}`);
  if (base.status !== 0) { console.error('working tree is dirty; refusing to mutate'); process.exit(2); }

  let exit = 0;
  const bp = parseTap(gate().stdout);
  console.log(`\n=== BASELINE (unmutated) ===\n${bp.tests.map((t) => `${t.ok ? 'ok' : 'not ok'} ${t.n} - ${t.title}`).join('\n')}\n# tests ${bp.count} pass ${bp.pass} fail ${bp.fail}`);
  if (bp.fail !== 0 || !(bp.count > 1)) { console.error('baseline is not green; a kill would prove nothing'); process.exit(2); }
  const BASE_COUNT = bp.count;

  for (const m of MUTATIONS) {
    if (only.length && !only.includes(m.name)) continue;
    console.log(`\n=== MUTATION ${m.name} (${m.file}) ===`);
    const src = readFileSync(SNAP[m.file], 'utf8');
    const count = src.split(m.anchor).length - 1;
    console.log(`anchor occurrences: ${count}`);
    if (count !== 1) { console.log('SKIP (anchor must occur exactly once)'); exit = 1; continue; }
    writeFileSync(abs(m.file), src.replace(m.anchor, () => m.to));
    const tsc = run('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: WEB });
    console.log(`tsc --noEmit exit: ${tsc.status}`);
    if (tsc.status !== 0) { console.log(tsc.stdout.slice(0, 800)); console.log('SKIP (invalid mutant)'); restore(); exit = 1; continue; }
    const out = gate().stdout;
    const r = parseTap(out);
    console.log(r.tests.map((t) => `${t.ok ? 'ok' : 'not ok'} ${t.n} - ${t.title}${t.ok ? '' : ` [${t.code}/${t.name}]`}`).join('\n'));
    console.log(`# tests ${r.count} pass ${r.pass} fail ${r.fail}`);
    const firstFail = r.tests.find((t) => !t.ok);
    if (firstFail) {
      const bl = firstFail.block.split('\n');
      const at = Math.max(0, bl.findIndex((l) => l.startsWith('  error:')));
      console.log(bl.slice(at, at + 4).map((l) => l.slice(0, 300)).join('\n'));
    }
    const c = classify(r, BASE_COUNT);
    console.log(`${c.verdict}: ${c.why}`);
    const want = m.expect ?? 'KILLED';
    if (c.verdict !== want) { exit = 1; console.log(`UNEXPECTED: wanted ${want}`); }
    else if (want !== 'KILLED') console.log(`(control behaved as expected: ${want})`);
    restore();
    const same = files.every((f) => sha(abs(f)) === SHA0[f]);
    const clean = run('git', ['-C', WEB, 'diff', '--quiet']).status === 0;
    console.log(`restored by copy: sha256 ${same ? 'MATCH' : 'MISMATCH'}, git diff --quiet exit ${clean ? 0 : 1}`);
    if (!same || !clean) { exit = 1; console.log('RESTORE FAILED'); }
  }
  for (const f of files) console.log(`\nsha256 after ${f}: ${sha(abs(f))}  (${sha(abs(f)) === SHA0[f] ? 'identical' : 'DIFFERENT'})`);
  process.exit(exit);
}
