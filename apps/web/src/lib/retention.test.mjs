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
