// Self-test of scripts/prove-non-vacuous.mjs: the tool that decides whether the
// chord-chip gate is vacuous must itself not lie. No Chromium, no checkout is
// mutated. (The restore-on-SIGTERM path is exercised by hand, with a real gate
// run, and its output is in the PR description; it cannot be faked here because
// the tool runs the one real gate file.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, parseTap, run, GATE_FAIL_AT_START } from '../scripts/prove-non-vacuous.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/prove-non-vacuous.mjs');

const tap = (errBlock) => {
  let out = 'TAP version 13\nok 1 - setup\n';
  for (let n = 2; n <= 9; n++) out += `ok ${n} - t${n}\n`;
  out += `not ok 10 - one\n  ---\n${errBlock}\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  ...\n# tests 10\n# pass 9\n# fail 1\n# cancelled 0\n`;
  return out;
};

test('GATE-FAIL counts only at the START of the error text', () => {
  // A page error whose text merely mentions the tag is a crash, not a kill.
  const mention = tap("  error: |-\n    the page threw\n    \n    + actual - expected\n    + [ 'Error: boom, while rendering GATE-FAIL tooltip' ]");
  assert.equal(classify(parseTap(mention), 10).verdict, 'CRASH');
  // The two shapes node:test prints a genuine gate message in.
  assert.equal(classify(parseTap(tap('  error: |-\n    GATE-FAIL 3 chord chip(s) have text sticking out')), 10).verdict, 'KILLED');
  assert.equal(classify(parseTap(tap("  error: 'GATE-FAIL no chip was measured'")), 10).verdict, 'KILLED');
  assert.equal(classify(parseTap(tap('  error: "GATE-FAIL it\'s quoted"')), 10).verdict, 'KILLED');
  assert.ok(!GATE_FAIL_AT_START.test("  error: 'TypeError: x'\n  stack: |-\n    GATE-FAIL"));
});

test('a changed test count, a failed setup and a cancelled test are never a kill', () => {
  const real = tap('  error: |-\n    GATE-FAIL x');
  assert.equal(classify(parseTap(real), 11).verdict, 'CRASH');
  assert.equal(classify(parseTap(real.replace('ok 1 - setup', 'not ok 1 - setup')), 10).verdict, 'CRASH');
  assert.equal(classify(parseTap(real.replace('# cancelled 0', '# cancelled 1')), 10).verdict, 'CRASH');
});

test('an unknown mutation name is NOT ATTEMPTED (exit 3), not a pass, and touches nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prove-selftest-'));
  const r = spawnSync('node', [TOOL, dir, 'no-such-mutant'], { encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /NOT ATTEMPTED: unknown mutation name\(s\): no-such-mutant/);
  assert.ok(!/=== MUTATION/.test(r.stdout), 'ran a mutation block');
  // One good name next to a bad one must not run the good one either.
  const r2 = spawnSync('node', [TOOL, dir, 'bare-b', 'no-such-mutant'], { encoding: 'utf8' });
  assert.equal(r2.status, 3);
  assert.ok(!/=== MUTATION|BASELINE/.test(r2.stdout));
});

test('no arguments is a usage error (exit 2), importing the module is not', () => {
  const r = spawnSync('node', [TOOL], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('a child past its timeout is killed with its descendants and reported timed out', async () => {
  const t0 = Date.now();
  const r = await run('sh', ['-c', 'sleep 317 & sleep 318'], { timeoutMs: 1000 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  // SIGKILL is delivered at once but the processes take a moment to leave the table.
  const alive = () => spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /sleep 31[78]/.test(l));
  for (let i = 0; i < 40 && alive().length; i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(alive(), [], 'a descendant outlived its parent');
  const ok = await run('sh', ['-c', 'echo hi'], { timeoutMs: 5000 });
  assert.equal(ok.status, 0);
  assert.equal(ok.timedOut, false);
});
