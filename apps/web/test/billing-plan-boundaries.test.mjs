// Exact-instant boundaries of effectivePlanCode() and isPeriodStale() (lib/billing/entitlements.ts).
//
// Mutation sweep 2026-11-12 (W6): the expiry tests use instants days away from every boundary,
// so `end > now` -> `end >= now` (a paid plan still honoured AT period_end) passed the whole
// web suite. These pin the instant itself, with `now` passed in, so they are not timing-flaky.
// The policy pinned: a period is OVER at period_end (stale, and no longer paid), and past_due
// grace ends exactly PAST_DUE_GRACE_MS after current_period_start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const dbStub = dataUrl(`export const db = { query: async () => { throw new Error('no db in this test'); } };`);
const ENT = dataUrl(
  toJs(readFileSync(join(WEB, 'src/lib/billing/entitlements.ts'), 'utf8')).replace(
    /from ['"]@\/lib\/db['"]/g,
    `from '${dbStub}'`,
  ),
);
const { effectivePlanCode, isPeriodStale, PAST_DUE_GRACE_MS } = await import(ENT);

const END = Date.parse('2026-12-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const plan = (subStatus, now, extra = {}) =>
  effectivePlanCode({ planCode: 'pro', periodEnd: iso(END), subStatus, subPeriodStart: null, now, ...extra });

test('active / trialing: paid strictly BEFORE period_end, free AT and after it', () => {
  for (const s of ['active', 'trialing']) {
    assert.equal(plan(s, END - 1), 'pro', `${s} 1 ms before period_end`);
    assert.equal(plan(s, END), 'free', `${s} exactly at period_end`);
    assert.equal(plan(s, END + 1), 'free', `${s} 1 ms after period_end`);
  }
});

test('past_due: paid strictly inside the grace window, free at its end', () => {
  const start = END - 30 * 24 * 3600 * 1000;
  const pd = (now) => plan('past_due', now, { subPeriodStart: iso(start) });
  assert.equal(PAST_DUE_GRACE_MS, 7 * 24 * 3600 * 1000);
  assert.equal(pd(start + PAST_DUE_GRACE_MS - 1), 'pro');
  assert.equal(pd(start + PAST_DUE_GRACE_MS), 'free');
});

test('isPeriodStale: stale exactly AT period_end (same instant the plan stops being paid)', () => {
  assert.equal(isPeriodStale(iso(END), END - 1), false);
  assert.equal(isPeriodStale(iso(END), END), true);
  assert.equal(isPeriodStale(iso(END), END + 1), true);
  assert.equal(isPeriodStale(null, END), false);
  assert.equal(isPeriodStale('not a date', END), false);
});
