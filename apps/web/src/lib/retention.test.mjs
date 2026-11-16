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
test('near/past expiry floors at 60s; null/garbage -> 24h cap', () => {
  assert.equal(presignTtlSec(at(5 * 1000), NOW), 60);
  assert.equal(presignTtlSec(at(-H), NOW), 60);
  assert.equal(presignTtlSec(null, NOW), RETENTION_SEC);
  assert.equal(presignTtlSec('nope', NOW), RETENTION_SEC);
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
  assert.match(sql, /^GREATEST\(jobs\.expires_at, /);
  assert.ok(sql.includes(`interval '${PAID_RETENTION_GRACE_DAYS} days'`));
  assert.ok(sql.includes("s.current_period_start + interval '7 days'"));
  assert.ok(sql.includes("s.plan_code IN ('pro','studio')"));
});
