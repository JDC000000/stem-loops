/**
 * The admission duration guard.
 *
 * Every assertion here reads an EXPORTED VALUE or calls an exported function. None of it
 * matches on source text: this repo has been bitten seven times by a gate a comment, a
 * string literal or an unrelated constant could satisfy, and `assert.match(src, /300/)`
 * is the same defect wearing a number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_UPLOAD_DURATION_SEC } from './upload.ts';
import { MAX_TRACK_SEC } from './play/types.ts';
import { durationVerdict, probeDurationSec, PROBE_TIMEOUT_MS } from './upload-duration.ts';

test('the upload cap IS the player ceiling — one number, compared as values', () => {
  // Not `=== 300`. That passes just as happily when BOTH have drifted together to 600,
  // which is the state this guard exists to prevent coming back. The property is that the
  // two modules agree, so it is asserted between them.
  assert.equal(MAX_UPLOAD_DURATION_SEC, MAX_TRACK_SEC);
  // …and that the shared number is the five minutes the landing copy promises. This one IS
  // a literal, deliberately: it is the product decision, not a restatement of either module.
  assert.equal(MAX_UPLOAD_DURATION_SEC, 300);
});

test('durationVerdict declines only what it has MEASURED to be over the cap', () => {
  const over = durationVerdict(MAX_UPLOAD_DURATION_SEC + 0.5);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too_long');
  assert.equal(over.seconds, MAX_UPLOAD_DURATION_SEC + 0.5);
});

test('the boundary is inclusive — exactly the cap passes', () => {
  // A track of exactly MAX_UPLOAD_DURATION_SEC is inside the promise, and the worker uses
  // `> max_sec` too. An off-by-one here would turn away a legitimate 5:00 song.
  assert.deepEqual(durationVerdict(MAX_UPLOAD_DURATION_SEC), { ok: true, reason: 'within_cap' });
  assert.deepEqual(durationVerdict(MAX_UPLOAD_DURATION_SEC - 0.001), { ok: true, reason: 'within_cap' });
  assert.deepEqual(durationVerdict(1), { ok: true, reason: 'within_cap' });
});

test('IT FAILS OPEN: anything unmeasurable passes, and says it was unmeasured', () => {
  // This is the whole safety argument for putting a check in the browser at all. A client
  // probe is not a boundary, so the ONLY acceptable failure direction is to let the file
  // through and leave it to the worker's MAX_UPLOAD_DURATION_SEC.
  for (const v of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    assert.deepEqual(durationVerdict(v), { ok: true, reason: 'unmeasured' }, `durationVerdict(${v}) must pass`);
  }
});

// ── probeDurationSec: the browser half, through its injected seam ────────────────────────
// node:test has no media stack, so the <audio> element is supplied. What is being proved is
// the probe's OWN contract — that it resolves, never rejects, and yields null on every
// failure path — not that happy-dom can decode audio.

const BLOB = new Blob([new Uint8Array([0, 1, 2, 3])]);

/** A fake <audio> whose load outcome the test chooses. */
function fakeAudio(outcome) {
  const el = { preload: '', src: '', duration: Number.NaN, onloadedmetadata: null, onerror: null,
               removeAttribute() {}, load() {} };
  Object.defineProperty(el, 'src', {
    set(v) {
      this._src = v;
      queueMicrotask(() => {
        if (outcome.error) el.onerror?.();
        else if (outcome.hang) { /* nothing ever fires — the timeout must win */ }
        else { el.duration = outcome.duration; el.onloadedmetadata?.(); }
      });
    },
    get() { return this._src ?? ''; },
  });
  return el;
}

function deps(outcome, extra = {}) {
  const revoked = [];
  return {
    revoked,
    opts: {
      createElement: () => fakeAudio(outcome),
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: (u) => revoked.push(u),
      timeoutMs: 50,
      ...extra,
    },
  };
}

test('a measurable file yields its duration, and the object URL is released', async () => {
  const { revoked, opts } = deps({ duration: 123.5 });
  assert.equal(await probeDurationSec(BLOB, opts), 123.5);
  assert.deepEqual(revoked, ['blob:fake'], 'the probe leaked its object URL');
});

test('a 6-minute file measures over the cap, and the two halves agree', async () => {
  // The end-to-end property, as far as it can be reached without a browser: a real
  // over-length track measures, and the verdict on that measurement declines it.
  const { opts } = deps({ duration: 360 });
  const measured = await probeDurationSec(BLOB, opts);
  assert.equal(measured, 360);
  assert.equal(durationVerdict(measured).ok, false);
});

test('an undecodable file resolves null rather than failing the upload', async () => {
  const { revoked, opts } = deps({ error: true });
  assert.equal(await probeDurationSec(BLOB, opts), null);
  assert.deepEqual(revoked, ['blob:fake']);
});

test('a file that reports no finite duration resolves null', async () => {
  for (const duration of [Number.POSITIVE_INFINITY, Number.NaN]) {
    const { opts } = deps({ duration });
    assert.equal(await probeDurationSec(BLOB, opts), null, `duration ${duration} must not be reported`);
  }
});

test('a probe that never answers is abandoned, not awaited forever', async () => {
  const { revoked, opts } = deps({ hang: true });
  const t0 = Date.now();
  assert.equal(await probeDurationSec(BLOB, opts), null);
  assert.ok(Date.now() - t0 >= 45, 'resolved before the timeout could have fired');
  assert.deepEqual(revoked, ['blob:fake']);
});

test('a throwing browser API is swallowed — the probe never rejects', async () => {
  // assert.rejects with no matcher absorbs a refusal; this asserts the resolved VALUE.
  const boom = () => { throw new Error('createObjectURL blocked'); };
  const { opts } = deps({ duration: 10 }, { createObjectURL: boom });
  assert.equal(await probeDurationSec(BLOB, opts), null);

  const { opts: o2 } = deps({ duration: 10 }, { createElement: boom });
  assert.equal(await probeDurationSec(BLOB, o2), null);
});

test('with no DOM and no injected seam the probe is a no-op, not a crash', async () => {
  // Server-rendering this module must not throw. `document` is absent under node:test.
  assert.equal(typeof document, 'undefined');
  assert.equal(await probeDurationSec(BLOB), null);
});

test('the probe timeout is a real finite budget', () => {
  assert.ok(Number.isFinite(PROBE_TIMEOUT_MS) && PROBE_TIMEOUT_MS > 0);
});
