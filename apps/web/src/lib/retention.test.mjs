// Run: pnpm --filter web test   (node >= 22.6, built-in type stripping + test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presignTtlSec, formatExpiresIn, RETENTION_SEC } from './retention.ts';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = (ms) => new Date(NOW + ms);
const H = 3600 * 1000;

test('fresh job gets the full 24h', () => {
  assert.equal(presignTtlSec(at(24 * H), NOW), RETENTION_SEC);
});
test('never exceeds the job\'s remaining life', () => {
  assert.equal(presignTtlSec(at(1 * H), NOW), 3600);
  assert.equal(presignTtlSec(at(23 * H).toISOString(), NOW), 23 * 3600);
});
test('never exceeds 24h even for legacy 7-day rows', () => {
  assert.equal(presignTtlSec(at(7 * 24 * H), NOW), RETENTION_SEC);
});
test('near/past expiry floors at 60s; null/garbage -> 60s floor (fails closed)', () => {
  assert.equal(presignTtlSec(at(5 * 1000), NOW), 60);
  assert.equal(presignTtlSec(at(-H), NOW), 60);
  // QA track B, B-12: an unreadable expiry fails CLOSED to the 60 s floor, never the 24 h max.
  assert.equal(presignTtlSec(null, NOW), 60);
  assert.equal(presignTtlSec(undefined, NOW), 60);
  assert.equal(presignTtlSec('nope', NOW), 60);
  assert.equal(presignTtlSec('garbage', NOW), 60);
  assert.equal(presignTtlSec(new Date(Infinity), NOW), 60);
  assert.equal(presignTtlSec(new Date(NaN), NOW), 60);
});
test('formatExpiresIn', () => {
  assert.equal(formatExpiresIn(NOW + 5 * H + 1000, NOW), 'in 5 hours');
  assert.equal(formatExpiresIn(NOW + 1 * H, NOW), 'in 1 hour');
  assert.equal(formatExpiresIn(NOW + 12 * 60000, NOW), 'in 12 minutes');
  assert.equal(formatExpiresIn(NOW + 20000, NOW), 'in under a minute');
  assert.equal(formatExpiresIn(NOW - 1, NOW), 'expired');
});

test('formatExpiresIn: two days or more reads in days (a paid library outlives 24 h)', () => {
  assert.equal(formatExpiresIn(NOW + 47 * H, NOW), 'in 47 hours');
  assert.equal(formatExpiresIn(NOW + 48 * H, NOW), 'in 2 days');
  assert.equal(formatExpiresIn(NOW + 40 * 24 * H + 5 * H, NOW), 'in 40 days');
  assert.equal(formatExpiresIn(NOW + 24 * H, NOW), 'in 24 hours', 'Free\'s window still reads in hours');
});

test('a paid library URL is still capped at 24 h, however long the song is kept', () => {
  assert.equal(presignTtlSec(at(400 * 24 * H), NOW), RETENTION_SEC);
});

test('JOB_RETAINED_UNTIL_SQL: Free 24 h is expires_at; paid adds 30 days; past_due is 7 days', async () => {
  const { JOB_RETAINED_UNTIL_SQL: sql, PAID_RETENTION_GRACE_DAYS, RETENTION_HOURS } = await import('./retention.ts');
  assert.equal(RETENTION_HOURS, 24);
  assert.equal(PAID_RETENTION_GRACE_DAYS, 30);
  // Outer CASE: a demo song (migration 040) first, then the Free/paid rule unchanged.
  assert.match(sql, /^\(CASE WHEN jobs\.is_demo THEN '2099-12-31T00:00:00Z'::timestamptz ELSE GREATEST\(jobs\.expires_at, /);
  assert.match(sql, / END\)$/);
  assert.ok(sql.includes(`interval '${PAID_RETENTION_GRACE_DAYS} days'`));
  assert.ok(sql.includes("s.current_period_start + interval '7 days'"));
  assert.ok(sql.includes("s.plan_code IN ('pro','studio')"));
});

// ── demo songs (V3 Slice 0, migration 040) ──
test('demo: the SQL returns DEMO_RETAINED_UNTIL, a FINITE 2099-12-31, never infinity', async () => {
  const { JOB_RETAINED_UNTIL_SQL: sql, DEMO_RETAINED_UNTIL } = await import('./retention.ts');
  assert.equal(DEMO_RETAINED_UNTIL, '2099-12-31T00:00:00Z');
  assert.ok(sql.includes(`WHEN jobs.is_demo THEN '${DEMO_RETAINED_UNTIL}'::timestamptz`));
  assert.doesNotMatch(sql, /infinity/i, "'infinity' -> node-pg Infinity -> NaN -> 1 s signed URLs");
  const t = new Date(DEMO_RETAINED_UNTIL).getTime();
  assert.ok(Number.isFinite(t));
  assert.equal(new Date(t).toISOString(), '2099-12-31T00:00:00.000Z', 'expiry reads as 2099-12-31');
  // What node-pg hands the route for that timestamptz (a Date) round-trips through JSON.
  assert.equal(JSON.parse(JSON.stringify({ e: new Date(t) })).e, '2099-12-31T00:00:00.000Z');
});

test('demo: presignTtlSec for a demo expiry stays at the normal 24 h cap (no NaN, no 1 s)', async () => {
  const { DEMO_RETAINED_UNTIL } = await import('./retention.ts');
  assert.equal(presignTtlSec(DEMO_RETAINED_UNTIL, NOW), RETENTION_SEC);
  assert.equal(presignTtlSec(new Date(DEMO_RETAINED_UNTIL), NOW), RETENTION_SEC);
});

test('demo: isDemoRow is true only for is_demo === true', async () => {
  const { isDemoRow } = await import('./retention.ts');
  assert.equal(isDemoRow({ is_demo: true }), true);
  for (const r of [{ is_demo: false }, {}, { is_demo: null }, { is_demo: 'true' }, null, undefined]) {
    assert.equal(isDemoRow(r), false, JSON.stringify(r));
  }
});
