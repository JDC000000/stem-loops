/**
 * The admission duration probe — since 2026-11-14 a HEADS-UP, never a refusal: a track over
 * the cap is kept and trimmed by the worker to its first MAX_UPLOAD_DURATION_SEC seconds.
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
import { durationVerdict, probeDurationSec, PROBE_TIMEOUT_MS, trimNotice, MAX_UPLOAD_MIN } from './upload-duration.ts';

test('the upload cap IS the player ceiling — one number, compared as values', () => {
  // Not `=== 300`. That passes just as happily when BOTH have drifted together to 600,
  // which is the state this guard exists to prevent coming back. The property is that the
  // two modules agree, so it is asserted between them.
  assert.equal(MAX_UPLOAD_DURATION_SEC, MAX_TRACK_SEC);
  // …and that the shared number is the five minutes the landing copy promises. This one IS
  // a literal, deliberately: it is the product decision, not a restatement of either module.
  assert.equal(MAX_UPLOAD_DURATION_SEC, 300);
});

test('durationVerdict never refuses: a measured long track is flagged for TRIM, not declined', () => {
  const over = durationVerdict(MAX_UPLOAD_DURATION_SEC + 0.5);
  assert.equal(over.trim, true);
  assert.equal(over.reason, 'over_cap');
  assert.equal(over.seconds, MAX_UPLOAD_DURATION_SEC + 0.5);
  // There is no refusal shape any more — the old `ok: false` must not come back.
  for (const v of [MAX_UPLOAD_DURATION_SEC + 0.5, 3600, 86400, 1, null]) {
    assert.equal('ok' in durationVerdict(v), false, `durationVerdict(${v}) still carries a refusal flag`);
  }
});

test('the boundary — exactly the cap is NOT trimmed', () => {
  // The worker and the player both compare with `>`, so a 5:00 song is used whole.
  assert.deepEqual(durationVerdict(MAX_UPLOAD_DURATION_SEC), { trim: false, reason: 'within_cap' });
  assert.deepEqual(durationVerdict(MAX_UPLOAD_DURATION_SEC - 0.001), { trim: false, reason: 'within_cap' });
  assert.deepEqual(durationVerdict(1), { trim: false, reason: 'within_cap' });
});

test('anything unmeasurable says nothing (the worker trims anyway)', () => {
  for (const v of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    assert.deepEqual(durationVerdict(v), { trim: false, reason: 'unmeasured' }, `durationVerdict(${v})`);
  }
});

test('the pre-submit note: shown only for a long track, and names the cap from the constant', () => {
  assert.equal(MAX_UPLOAD_MIN, 5);
  assert.equal(
    trimNotice(durationVerdict(372)),
    'This track is longer than 5 minutes \u2014 we\u2019ll use the first 5 minutes.',
  );
  assert.equal(trimNotice(durationVerdict(MAX_UPLOAD_DURATION_SEC)), null);
  assert.equal(trimNotice(durationVerdict(120)), null);
  assert.equal(trimNotice(durationVerdict(null)), null);
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

test('a 6-minute file measures over the cap, and the two halves agree: trim, with a note', async () => {
  // The end-to-end property, as far as it can be reached without a browser: a real
  // over-length track measures, and the verdict on that measurement is TRIM, not refuse.
  const { opts } = deps({ duration: 360 });
  const measured = await probeDurationSec(BLOB, opts);
  assert.equal(measured, 360);
  assert.equal(durationVerdict(measured).trim, true);
  assert.match(trimNotice(durationVerdict(measured)), /we\u2019ll use the first 5 minutes/);
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
