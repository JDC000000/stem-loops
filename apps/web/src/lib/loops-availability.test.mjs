// The 24-hour loops window (Jon, 2026-11-14) and the paste parser. Every
// expected value is written out by hand, never recomputed with the module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOPS_WINDOW_MS,
  LOOPS_CLOSED_COPY,
  loopsWindowOpen,
  expiresAtMsOf,
  jobIdFrom,
} from './loops/availability.ts';
import { RETENTION_MS } from './retention.ts';

const T = Date.parse('2026-11-14T12:00:00.000Z');

test('the window is the retention window: 24 hours, not a second number to keep in step', () => {
  assert.equal(LOOPS_WINDOW_MS, 86_400_000);
  assert.equal(LOOPS_WINDOW_MS, RETENTION_MS);
});

test('expires_at decides when present: open one ms before, closed AT it and after', () => {
  const end = Date.parse('2026-11-14T12:00:00.000Z');
  assert.equal(loopsWindowOpen({ expiresAtMs: end }, end - 1), true);
  assert.equal(loopsWindowOpen({ expiresAtMs: end }, end), false);
  assert.equal(loopsWindowOpen({ expiresAtMs: end }, end + 1), false);
  // expires_at wins over a createdAt that disagrees with it.
  assert.equal(loopsWindowOpen({ expiresAtMs: end, createdAtMs: end }, end + 1000), false);
});

test('without expires_at, created + 24h decides', () => {
  const created = Date.parse('2026-11-13T12:00:00.000Z');
  assert.equal(loopsWindowOpen({ createdAtMs: created }, Date.parse('2026-11-14T11:59:59.999Z')), true);
  assert.equal(loopsWindowOpen({ createdAtMs: created }, Date.parse('2026-11-14T12:00:00.000Z')), false);
});

test('with neither, the window is open: the server is the authority and will say 404', () => {
  assert.equal(loopsWindowOpen({}, T), true);
  assert.equal(loopsWindowOpen({ expiresAtMs: null, createdAtMs: null }, T), true);
  assert.equal(loopsWindowOpen({ expiresAtMs: Number.NaN }, T), true);
});

test('expiresAtMsOf parses ISO and refuses junk', () => {
  assert.equal(expiresAtMsOf('2026-11-14T12:00:00.000Z'), 1_794_657_600_000);
  assert.equal(expiresAtMsOf('later'), null);
  assert.equal(expiresAtMsOf(null), null);
  assert.equal(expiresAtMsOf(undefined), null);
});

test('jobIdFrom reads an id out of a bare id, a job link or a loops link, lowercased', () => {
  const id = '477fb242-695a-4b29-9373-a26b9067a8fa';
  assert.equal(jobIdFrom(id), id);
  assert.equal(jobIdFrom(`  https://stem-loops.com/jobs/${id.toUpperCase()}  `), id);
  assert.equal(jobIdFrom(`https://stem-loops.com/loops?job=${id}`), id);
  assert.equal(jobIdFrom('https://youtube.com/watch?v=abc'), null);
  assert.equal(jobIdFrom(''), null);
  assert.equal(jobIdFrom(null), null);
});

test('closed copy: plain, says 24 hours, uses "on our end", and every reason has a sentence', () => {
  assert.deepEqual(Object.keys(LOOPS_CLOSED_COPY).sort(), ['expired', 'no_stems', 'not_found']);
  assert.match(LOOPS_CLOSED_COPY.expired, /within 24 hours/);
  assert.match(LOOPS_CLOSED_COPY.expired, /on our end/);
  for (const v of Object.values(LOOPS_CLOSED_COPY)) {
    assert.doesNotMatch(v, /on our side/);
    assert.doesNotMatch(v, /up to 5 minutes|refused/);
  }
});
