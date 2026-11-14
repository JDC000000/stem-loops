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
//
// EXIT CODES (distinct on purpose; 0 means "something ran and every verdict was
// the expected one", never "nothing happened"):
//   0  every mutation that was asked for ran and gave its expected verdict
//   1  at least one mutation gave an unexpected verdict, was skipped (anchor
//      count != 1, tsc != 0), or a restore could not be proved
//   2  refused to start: bad usage, dirty tree, red baseline, or a journal left
//      by a run that was killed without cleanup
//   3  NOT ATTEMPTED: an unknown mutation name was asked for, or the filter
//      selected nothing. Nothing was mutated. This is a skip, not a pass.
//   130/143  interrupted by SIGINT/SIGTERM; the file was restored first
//
// RESTORE PATH. The mutant lives on disk while the gate runs, so everything
// that can end this process restores it: normal exit, SIGINT, SIGTERM, SIGHUP,
// an uncaught exception, and a gate that outlives PROVE_GATE_TIMEOUT_MS. The
// children run ASYNCHRONOUSLY in their own process group: a synchronous spawn
// blocks the event loop, so a signal handler cannot run until the child returns,
// and a `timeout`/CI-cancel SIGTERM left the mutant on disk and orphaned `tsc`.
// SIGKILL cannot be caught; for that case a journal file records the pending
// restore and the next start refuses to run until it is dealt with.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_PKG = resolve(HERE, '..');
// Set by main(). Importing this module (the self-test does) must have no side
// effects: no argv reads, no usage exit.
let WEB = '';
let JOURNAL = '';
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
const DENSITY_ANCHOR = 'const density = chipDensity(w, measureLabel(text, CHIP_FONT_PX));';
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
  // ---- round 3: the routes round 2 found that NOTHING caught ----------------
  // Route 1: `::first-line` is not the chip's own computed style, so a per-chip
  // font-style read never sees it; the gate must see it as WIDTH.
  { name: 'globals-first-line-italic', file: CSS, anchor: GLOBAL_ANCHOR,
    to: `${GLOBAL_ANCHOR}\nbutton::first-line{font-style:italic}` },
  // Route 2: a natural touch-target edit; wider chips cover their neighbours' text.
  { name: 'globals-button-min-width-44', file: CSS, anchor: GLOBAL_ANCHOR,
    to: `${GLOBAL_ANCHOR}\nbutton{min-width:44px}` },
  // Invisible text through channels the alpha check never read.
  { name: 'globals-button-text-fill-transparent', file: CSS, anchor: GLOBAL_ANCHOR,
    to: `${GLOBAL_ANCHOR}\nbutton{-webkit-text-fill-color:transparent}` },
  { name: 'chipstyle-clippath-inset', file: TSX, anchor: CHIP_STYLE,
    to: `${CHIP_STYLE}\n  clipPath: 'inset(0 0 0 100%)',` },
  // A cover that belongs to the chip itself: elementFromPoint says "the chip"
  // (a pseudo-element is its owner), only the pixels know the text is gone.
  { name: 'globals-button-after-cover', file: CSS, anchor: GLOBAL_ANCHOR,
    to: `${GLOBAL_ANCHOR}\nbutton::after{content:'';position:absolute;inset:0;background:#1e40af;pointer-events:none}` },
  // Route 3: names turned into honest ticks (data-density="tick", no text node).
  // Fits are never violated and no count is wrong; only "a tick must be
  // justified" can see it. Both layouts.
  { name: 'ticks-for-long-names', file: TSX, anchor: DENSITY_ANCHOR,
    to: `const density0 = chipDensity(w, measureLabel(text, CHIP_FONT_PX));\n  const density = density0 !== 'tick' && text.length > 3 ? 'tick' : density0;` },
  { name: 'chipstyle-color-transparent', file: TSX, anchor: COLOR_ANCHOR, to: "const chipStyle: CSSProperties = {\n  background: '#1e40af',\n  color: 'transparent'," },
];

// Spawn ASYNCHRONOUSLY, in its own process group, so that (a) signal handlers on
// this process still run while a child is going, and (b) a timeout or a signal
// can kill the child AND its descendants (tsc, chromium) rather than orphan them.
let activeChild = null;
function killGroup(child, sig = 'SIGKILL') {
  if (!child || child.pid === undefined) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}
export function run(cmd, args, opts = {}) {
  const { timeoutMs = 0, ...spawnOpts } = opts;
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { ...spawnOpts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const CAP = 256 * 1024 * 1024;
    child.stdout.setEncoding('utf8').on('data', (d) => { if (stdout.length < CAP) stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { if (stderr.length < CAP) stderr += d; });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs) : null;
    const done = (status, signal) => {
      if (timer) clearTimeout(timer);
      killGroup(child); // any descendant still holding the group
      if (activeChild === child) activeChild = null;
      resolveRun({ status, signal, stdout, stderr, timedOut });
    };
    child.on('error', (e) => { stderr += String(e); done(127, null); });
    child.on('close', (code, signal) => done(code, signal));
  });
}
// A gate that hangs the page must not hang this tool with a file mutated.
const GATE_TIMEOUT_MS = Number(process.env.PROVE_GATE_TIMEOUT_MS ?? 15 * 60 * 1000);
const TSC_TIMEOUT_MS = Number(process.env.PROVE_TSC_TIMEOUT_MS ?? 5 * 60 * 1000);
function gate() {
  return run('node', ['--experimental-strip-types', '--test', '--test-reporter=tap', 'test/chord-chip-fit.test.mjs'], {
    cwd: GATE_PKG,
    env: { ...process.env, CHORD_GATE_SRC: WEB },
    timeoutMs: GATE_TIMEOUT_MS,
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
// The tag must START the error text. `includes` accepted it anywhere in the
// block, so a crash whose stack or message merely MENTIONED GATE-FAIL (a
// TypeError quoting a gate message, a path, a log line) would count as a kill.
// node:test prints the message either inline (`error: 'GATE-FAIL ...'`) or as a
// block scalar (`error: |-` then the text on the next, indented line).
export const GATE_FAIL_AT_START = /^ {2}error: (?:'|"|\|-?\n {4})GATE-FAIL /m;
const isGateAssertion = (t) =>
  !t.ok && t.code === 'ERR_ASSERTION' && t.name === 'AssertionError' && GATE_FAIL_AT_START.test(t.block);

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

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });


async function main() {
  if (!process.argv[2]) {
    console.error('usage: prove-non-vacuous.mjs <path-to-apps/web> [mutation ...]');
    process.exit(2);
  }
  WEB = resolve(process.argv[2]);
  const only = process.argv.slice(3);
  // One journal per target checkout, so two runs on two checkouts do not block each other.
  JOURNAL = join(tmpdir(), `chip-gate-restore-journal-${createHash('sha1').update(WEB).digest('hex').slice(0, 12)}.json`);
  // ---- validate the request BEFORE touching anything ------------------------
  const known = MUTATIONS.map((m) => m.name);
  const unknown = only.filter((n) => !known.includes(n));
  if (unknown.length) {
    console.error(`NOT ATTEMPTED: unknown mutation name(s): ${unknown.join(', ')}\nknown: ${known.join(', ')}`);
    process.exit(3);
  }
  const selected = MUTATIONS.filter((m) => !only.length || only.includes(m.name));
  if (selected.length === 0) { console.error('NOT ATTEMPTED: no mutation selected'); process.exit(3); }

  if (existsSync(JOURNAL)) {
    console.error(
      `refusing to start: ${JOURNAL} exists, so an earlier run was killed (SIGKILL?) with a mutant possibly still on disk.\n` +
        readFileSync(JOURNAL, 'utf8') +
        '\nrestore each listed target from its listed backup (cp), check `git diff --quiet`, then delete the journal.',
    );
    process.exit(2);
  }

  const files = [...new Set(selected.map((m) => m.file))];
  const scratch = mkdtempSync(join(tmpdir(), 'chip-gate-'));
  const SNAP = Object.fromEntries(files.map((f, i) => [f, join(scratch, `orig-${i}`)]));
  for (const f of files) copyFileSync(abs(f), SNAP[f]);
  const SHA0 = Object.fromEntries(files.map((f) => [f, sha(abs(f))]));
  const restore = () => { for (const f of files) copyFileSync(SNAP[f], abs(f)); };

  // Everything that can end the process restores first. `exit` handlers must be
  // synchronous, and this one is.
  let restored = false;
  const restoreOnce = () => { try { restore(); restored = true; } catch (e) { console.error('RESTORE ERROR', e); } };
  process.on('exit', () => {
    killGroup(activeChild);
    restoreOnce();
    try { unlinkSync(JOURNAL); } catch {}
  });
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => { console.error(`\n${sig}: restoring and exiting`); killGroup(activeChild); process.exit(code); });
  }
  process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
  writeFileSync(JOURNAL, files.map((f) => `target ${abs(f)}\nbackup ${SNAP[f]}\nsha256 ${SHA0[f]}`).join('\n') + '\n');

  for (const f of files) console.log(`target ${abs(f)}\nsha256 before: ${SHA0[f]}`);
  const base = spawnSync('git', ['-C', WEB, 'diff', '--quiet']);
  console.log(`git diff --quiet before: exit ${base.status}`);
  if (base.status !== 0) { console.error('working tree is dirty; refusing to mutate'); process.exit(2); }

  let exit = 0;
  const bg = await gate();
  if (bg.timedOut) { console.error('baseline gate run timed out'); process.exit(2); }
  const bp = parseTap(bg.stdout);
  console.log(`\n=== BASELINE (unmutated) ===\n${bp.tests.map((t) => `${t.ok ? 'ok' : 'not ok'} ${t.n} - ${t.title}`).join('\n')}\n# tests ${bp.count} pass ${bp.pass} fail ${bp.fail}`);
  if (bp.fail !== 0 || !(bp.count > 1)) { console.error('baseline is not green; a kill would prove nothing'); process.exit(2); }
  const BASE_COUNT = bp.count;

  let ran = 0;
  for (const m of selected) {
    console.log(`\n=== MUTATION ${m.name} (${m.file}) ===`);
    const src = readFileSync(SNAP[m.file], 'utf8');
    const count = src.split(m.anchor).length - 1;
    console.log(`anchor occurrences: ${count}`);
    if (count !== 1) { console.log('SKIP (anchor must occur exactly once)'); exit = 1; continue; }
    writeFileSync(abs(m.file), src.replace(m.anchor, () => m.to));
    const tsc = await run('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: WEB, timeoutMs: TSC_TIMEOUT_MS });
    console.log(`tsc --noEmit exit: ${tsc.timedOut ? 'TIMEOUT' : tsc.status}`);
    if (tsc.status !== 0) { console.log(tsc.stdout.slice(0, 800)); console.log('SKIP (invalid mutant)'); restore(); exit = 1; continue; }
    const g = await gate();
    ran++;
    const r = parseTap(g.stdout);
    console.log(r.tests.map((t) => `${t.ok ? 'ok' : 'not ok'} ${t.n} - ${t.title}${t.ok ? '' : ` [${t.code}/${t.name}]`}`).join('\n'));
    console.log(`# tests ${r.count} pass ${r.pass} fail ${r.fail}`);
    const firstFail = r.tests.find((t) => !t.ok);
    if (firstFail) {
      const bl = firstFail.block.split('\n');
      const at = Math.max(0, bl.findIndex((l) => l.startsWith('  error:')));
      console.log(bl.slice(at, at + 4).map((l) => l.slice(0, 300)).join('\n'));
    }
    // A gate that outlived its timeout is a CRASH, whatever it printed first.
    // WHICH instrument fired, over every failing test (a mutant that trips two
    // instruments should show both: the class-level one must not be hiding behind
    // a cheaper one that happens to be listed first).
    const KINDS = [
      ['text sticking out (width)', /GATE-FAIL \d+ chord chip\(s\) have text sticking out/],
      ['characters not painted (pixels)', /GATE-FAIL \d+ character\(s\) are not painted/],
      ['ticks not justified', /GATE-FAIL \d+ tick\(s\) are not justified/],
      ['measurement not of the chip as shipped (style)', /GATE-FAIL \d+ chip measurement\(s\) are not of the chip/],
      ['did not look at the dataset (counts)', /GATE-FAIL the gate did not look at the dataset/],
      ['pinned font did not paint', /GATE-FAIL the pinned font did not paint/],
    ];
    const fired = KINDS.map(([name, re]) => [name, r.tests.filter((t) => !t.ok && re.test(t.block)).length]).filter(([, n]) => n > 0);
    if (fired.length) console.log(`instruments fired (tests of ${r.fail} failing): ${fired.map(([n, k]) => `${n} x${k}`).join('; ')}`);
    const c = g.timedOut
      ? { verdict: 'CRASH', why: `the gate did not finish within ${GATE_TIMEOUT_MS} ms and was killed` }
      : classify(r, BASE_COUNT);
    console.log(`${c.verdict}: ${c.why}`);
    const want = m.expect ?? 'KILLED';
    if (c.verdict !== want) { exit = 1; console.log(`UNEXPECTED: wanted ${want}`); }
    else if (want !== 'KILLED') console.log(`(control behaved as expected: ${want})`);
    restore();
    const same = files.every((f) => sha(abs(f)) === SHA0[f]);
    const clean = spawnSync('git', ['-C', WEB, 'diff', '--quiet']).status === 0;
    console.log(`restored by copy: sha256 ${same ? 'MATCH' : 'MISMATCH'}, git diff --quiet exit ${clean ? 0 : 1}`);
    if (!same || !clean) { exit = 1; console.log('RESTORE FAILED'); }
  }
  for (const f of files) console.log(`\nsha256 after ${f}: ${sha(abs(f))}  (${sha(abs(f)) === SHA0[f] ? 'identical' : 'DIFFERENT'})`);
  console.log(`\nmutations selected ${selected.length}, run to a verdict ${ran}, exit ${ran === 0 && exit === 0 ? 3 : exit}`);
  if (ran === 0 && exit === 0) exit = 3; // nothing reached a verdict: not a pass
  process.exit(exit);
}
