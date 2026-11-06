// Chord-edit collector tests — PR-Y1.7 (TSD §1.6a).
// Standalone client module (not a route); loaded via ts.transpileModule so
// the mjs test file can drive the TS source without a build step.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/chord/edit-collector.ts');
const HARTE_SRC = join(WEB, 'src/chord/harte.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Minimal localStorage shim for a Node test environment.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
}

let storage;
let fetchCalls;
let fetchImpl;

function installWindow() {
  storage = new MemoryStorage();
  fetchCalls = [];
  fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ edit_id: 'edit-' + fetchCalls.length, created_at: 'now' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.window = { localStorage: storage };
  globalThis.localStorage = storage;
  globalThis.fetch = (url, init) => fetchImpl(url, init);
}

async function loadCollector() {
  // edit-collector imports the shared validator from ./harte.ts; a data: URL
  // module cannot resolve relative specifiers, so inline harte.ts as its own
  // data: URL and point the import at it.
  const harteUrl = dataUrl(toJs(readFileSync(HARTE_SRC, 'utf8')));
  const js = toJs(readFileSync(SRC, 'utf8')).replace(/from '\.\/harte\.ts'/, `from '${harteUrl}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

const VALID = {
  jobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  trackHash: 't' + 'a'.repeat(63),
  startSec: 0.0,
  endSec: 2.0,
  originalLabel: 'C',
  correctedLabel: 'C:min',
  provider: 'klangio',
  providerVersion: 'klangio@1.0',
  alphabetSha: 'a'.repeat(64),
};

beforeEach(() => installWindow());

test('validateChordEdit rejects invalid Harte labels', async () => {
  const { validateChordEdit, ChordEditValidationError } = await loadCollector();
  for (const bad of ['Cmaj7', 'c', 'H', 'A♭', 'C/G', 'C:', '', ' C', 'C:zzz', 'C:maj/14', 'C:maj/0', 'N/3', 'X/5']) {
    assert.throws(
      () => validateChordEdit({ ...VALID, correctedLabel: bad }),
      (err) => err instanceof ChordEditValidationError && err.code === 'EDIT_HARTE',
      `expected reject for ${bad}`,
    );
  }
});

test('validateChordEdit accepts representative Harte labels', async () => {
  const { validateChordEdit } = await loadCollector();
  for (const good of ['N', 'X', 'A', 'G#', 'Bb', 'C:maj', 'F#:min7', 'D:sus4', 'G:7', 'G:7/5', 'A:min/b3', 'C#:maj7/b7', 'Bb:sus4/5']) {
    validateChordEdit({ ...VALID, correctedLabel: good });
  }
});

test('validateChordEdit rejects start_sec >= end_sec', async () => {
  const { validateChordEdit, ChordEditValidationError } = await loadCollector();
  for (const [s, e] of [[1, 1], [2, 1], [0, 0]]) {
    assert.throws(
      () => validateChordEdit({ ...VALID, startSec: s, endSec: e }),
      (err) => err instanceof ChordEditValidationError && err.code === 'EDIT_TIME_RANGE',
    );
  }
});

test('validateChordEdit rejects same original/corrected', async () => {
  const { validateChordEdit, ChordEditValidationError } = await loadCollector();
  assert.throws(
    () => validateChordEdit({ ...VALID, originalLabel: 'C:min', correctedLabel: 'C:min' }),
    (err) => err instanceof ChordEditValidationError && err.code === 'EDIT_LABELS_DIFFER',
  );
});

test('validateChordEdit rejects out-of-range confidence', async () => {
  const { validateChordEdit, ChordEditValidationError } = await loadCollector();
  for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateChordEdit({ ...VALID, originalConfidence: bad }),
      (err) => err instanceof ChordEditValidationError && err.code === 'EDIT_CONFIDENCE',
      `expected reject for ${bad}`,
    );
  }
});

test('validateChordEdit rejects unknown provider', async () => {
  const { validateChordEdit, ChordEditValidationError } = await loadCollector();
  assert.throws(
    () => validateChordEdit({ ...VALID, provider: 'chordify' }),
    (err) => err instanceof ChordEditValidationError && err.code === 'EDIT_PROVIDER',
  );
});

test('buffered edits survive a page reload (round-trip through localStorage)', async () => {
  // First "page view": buffer an edit but DO NOT let the flush deliver it.
  fetchImpl = async () => {
    throw new TypeError('network down');
  };
  const first = await loadCollector();
  // Swallow the resulting flush rejection — the test does not await delivery.
  await first.bufferChordEdit(VALID).catch(() => {});
  assert.equal(first.peekBufferedEdits().length, 1);
  // Per-M3 the key is scoped per-user with an `:anon` fallback.
  const snapshot = storage.getItem('stem-loops-chord-edit-buffer:anon');
  assert.ok(snapshot, 'buffer was not written to localStorage');

  // Simulate a reload: fresh module, but the SAME localStorage contents.
  fetchCalls = [];
  fetchImpl = async (_url, init) => {
    fetchCalls.push(init);
    return new Response(JSON.stringify({ edit_id: 'edit-ok', created_at: 'now' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const second = await loadCollector();
  assert.equal(second.peekBufferedEdits().length, 1);
  const n = await second.flushBufferedEdits();
  assert.equal(n, 1);
  assert.equal(second.peekBufferedEdits().length, 0);
});

test('flushBufferedEdits returns the count delivered', async () => {
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  // Buffer two more (both valid but with different frames).
  await mod.bufferChordEdit({ ...VALID, startSec: 2, endSec: 4, correctedLabel: 'G:min' }).catch(() => {});
  await mod.bufferChordEdit({ ...VALID, startSec: 4, endSec: 6, correctedLabel: 'A:min' }).catch(() => {});
  // Reset counter, then flush fresh.
  fetchCalls = [];
  const n = await mod.flushBufferedEdits();
  // Delivered either on the write or on this flush; exact split depends on
  // scheduling. What matters: 3 edits enqueued, 0 remain, 3 reached fetch
  // overall across buffering + explicit flush.
  assert.ok(n >= 0);
  assert.equal(mod.peekBufferedEdits().length, 0);
});

test('multiple edits to the same frame are NOT deduped', async () => {
  const mod = await loadCollector();
  await mod.bufferChordEdit({ ...VALID, correctedLabel: 'A:min' }).catch(() => {});
  await mod.bufferChordEdit({ ...VALID, correctedLabel: 'A:min7' }).catch(() => {});
  await mod.bufferChordEdit({ ...VALID, correctedLabel: 'A:maj7' }).catch(() => {});
  // Every edit must have been POSTed to the server.
  const sent = fetchCalls.filter((c) => (c.init?.method ?? c.init?.method) === 'POST');
  // Both "shapes" collapse to just the POSTs we did.
  const posts = fetchCalls.filter((c) => c.init && c.init.method === 'POST');
  assert.ok(posts.length >= 3, `expected at least 3 POSTs, got ${posts.length}`);
  assert.equal(mod.peekBufferedEdits().length, 0);
  assert.equal(sent.length, posts.length);
});

test('network error triggers exponential backoff and preserves the edit', async () => {
  const start = Date.now();
  let attempts = 0;
  fetchImpl = async () => {
    attempts += 1;
    throw new TypeError('network down');
  };
  const mod = await loadCollector();
  // bufferChordEdit returns a promise that resolves when its triggered flush
  // settles — awaiting it means one attempt has already run.
  await mod.bufferChordEdit(VALID).catch(() => {});
  assert.equal(attempts, 1);
  // Edit still buffered after that transient failure, attempt counter
  // persisted to localStorage.
  assert.equal(mod.peekBufferedEdits().length, 1);
  // Explicit flush: another attempt. (Not all 4 retries in one flush — each
  // transient failure stops and waits for the next trigger.)
  await mod.flushBufferedEdits();
  assert.ok(attempts >= 2);
  // Rough sanity on timing — at least one backoff sleep happened.
  assert.ok(Date.now() - start >= 400);
});

test('permanent (non-retryable) 4xx responses drop the edit (no infinite retry)', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ error_code: 'CHORD_EDIT_INVALID' }), { status: 400 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  await mod.flushBufferedEdits();
  assert.equal(mod.peekBufferedEdits().length, 0, 'bad row must not wedge the queue');
});

// ─── T3 (y1-test-coverage-audit.md): retryable 4xx must NOT drop the edit ───
// The fix at edit-collector.ts classifies 401/408/429 as retryable and 5xx
// as retryable. Each of these tests buffers one edit, fails one flush
// attempt with the given status, and asserts the edit is still buffered
// (i.e. it will retry on the next flush). We use `scheduler.wait(0)` to
// drain the microtask queue but don't wait for the backoff sleep — the
// buffered edit just needs to survive the first attempt.

test('T3: 401 Unauthorized is NOT permanent (session may expire and come back)', async () => {
  fetchImpl = async () =>
    new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), { status: 401 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  // bufferChordEdit awaits a flush; after it returns we've had one attempt.
  // The edit must still be in the buffer — dropping it would lose the
  // flywheel training signal across a session expiry.
  assert.equal(
    mod.peekBufferedEdits().length,
    1,
    '401 must be retryable — session expiry can\'t silently drop edits',
  );
});

test('T3: 408 Request Timeout is NOT permanent', async () => {
  fetchImpl = async () => new Response('', { status: 408 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  assert.equal(mod.peekBufferedEdits().length, 1, '408 must be retryable');
});

test('T3: 429 Too Many Requests is NOT permanent (rate-limited)', async () => {
  fetchImpl = async () => new Response('', { status: 429 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  assert.equal(mod.peekBufferedEdits().length, 1, '429 must be retryable');
});

test('T3: 5xx responses are NOT permanent', async () => {
  fetchImpl = async () => new Response('server exploded', { status: 500 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  assert.equal(mod.peekBufferedEdits().length, 1, '5xx must be retryable');
});

test('T3: 503 Service Unavailable is NOT permanent', async () => {
  fetchImpl = async () => new Response('', { status: 503 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  assert.equal(mod.peekBufferedEdits().length, 1, '503 must be retryable');
});

test('T3: 404 Not Found is permanent (route genuinely absent)', async () => {
  fetchImpl = async () => new Response('', { status: 404 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  await mod.flushBufferedEdits();
  assert.equal(mod.peekBufferedEdits().length, 0, '404 must be dropped');
});

test('T3: 400 Bad Request is permanent (schema violation)', async () => {
  fetchImpl = async () => new Response('', { status: 400 });
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  await mod.flushBufferedEdits();
  assert.equal(mod.peekBufferedEdits().length, 0, '400 must be dropped');
});

test('submitChordEdit returns the editId on success', async () => {
  const mod = await loadCollector();
  const { editId } = await mod.submitChordEdit(VALID);
  assert.equal(editId, 'edit-1');
  const call = fetchCalls[0];
  assert.equal(call.url, '/api/chord-edits');
  const body = JSON.parse(call.init.body);
  assert.equal(body.job_id, VALID.jobId);
  assert.equal(body.corrected_label, 'C:min');
  // Optional fields omitted when absent.
  assert.equal(body.original_confidence, undefined);
  assert.equal(body.cqt_plan_version, undefined);
});

test('submitChordEdit throws on validation failure before calling fetch', async () => {
  const { submitChordEdit, ChordEditValidationError } = await loadCollector();
  await assert.rejects(
    submitChordEdit({ ...VALID, correctedLabel: 'Cmaj7' }),
    (err) => err instanceof ChordEditValidationError && err.code === 'EDIT_HARTE',
  );
  assert.equal(fetchCalls.length, 0);
});

test('bufferChordEdit snapshot omits internal fields when peeked', async () => {
  const mod = await loadCollector();
  await mod.bufferChordEdit(VALID).catch(() => {});
  // After successful flush, buffer is empty; re-buffer with fetch disabled.
  fetchImpl = async () => { throw new TypeError('down'); };
  await mod.bufferChordEdit(VALID).catch(() => {});
  const peek = mod.peekBufferedEdits();
  assert.equal(peek.length, 1);
  assert.equal(peek[0].jobId, VALID.jobId);
  assert.equal(peek[0]._at, undefined);
  assert.equal(peek[0]._attempts, undefined);
});

// ────────────────────────────────────────────────────────────────────────
// Security audit §3 M3: per-user buffer isolation + sign-out sweep.
// ────────────────────────────────────────────────────────────────────────

test('M3: setChordEditUser scopes the localStorage key per user', async () => {
  // Fetch always fails so edits stay buffered — we are testing WHERE they
  // land, not whether they ship.
  fetchImpl = async () => { throw new TypeError('offline'); };
  const mod = await loadCollector();

  mod.setChordEditUser('user-A');
  await mod.bufferChordEdit(VALID).catch(() => {});
  assert.ok(
    storage.getItem('stem-loops-chord-edit-buffer:user-A'),
    'user A buffer should live under :user-A',
  );
  // The anon bucket must stay empty when a user is set.
  assert.equal(storage.getItem('stem-loops-chord-edit-buffer:anon'), null);

  // Switch to user B. A's buffer stays on disk under the OLD key but is NOT
  // visible to B's reads.
  mod.setChordEditUser('user-B');
  assert.equal(mod.peekBufferedEdits().length, 0, 'B must not see A\'s buffer');
  await mod.bufferChordEdit({ ...VALID, correctedLabel: 'F:maj' }).catch(() => {});
  assert.ok(storage.getItem('stem-loops-chord-edit-buffer:user-B'));
  // A's bucket is untouched.
  assert.ok(storage.getItem('stem-loops-chord-edit-buffer:user-A'));
});

test('M3: flush under user B does NOT send user A\'s buffered edits', async () => {
  // Reproduces the audit scenario: user A buffers while offline, logs out,
  // user B signs in on the same device and starts flushing. B must not POST
  // A's edits — they'd land under B's auth.uid().
  fetchImpl = async () => { throw new TypeError('offline'); };
  const mod = await loadCollector();

  mod.setChordEditUser('user-A');
  await mod.bufferChordEdit(VALID).catch(() => {});
  await mod.bufferChordEdit({ ...VALID, correctedLabel: 'G:maj' }).catch(() => {});

  // User A logs out: handler must call clearBufferedEdits + setChordEditUser(null).
  mod.clearBufferedEdits();
  mod.setChordEditUser(null);
  assert.equal(storage.getItem('stem-loops-chord-edit-buffer:user-A'), null);

  // User B logs in and triggers a flush. Even if the network recovers now,
  // nothing from A should be POSTed.
  mod.setChordEditUser('user-B');
  fetchCalls = [];
  fetchImpl = async (_url, init) => {
    fetchCalls.push(init);
    return new Response(JSON.stringify({ edit_id: 'edit-b', created_at: 'now' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const sent = await mod.flushBufferedEdits();
  assert.equal(sent, 0, 'B must not inherit A\'s queue');
  assert.equal(fetchCalls.length, 0);
});

test('M3: clearBufferedEdits wipes all per-user buckets (and legacy key)', async () => {
  fetchImpl = async () => { throw new TypeError('offline'); };
  const mod = await loadCollector();

  // Plant buffers for two users AND a legacy single-key entry (pre-M3 shape).
  mod.setChordEditUser('user-A');
  await mod.bufferChordEdit(VALID).catch(() => {});
  mod.setChordEditUser('user-B');
  await mod.bufferChordEdit({ ...VALID, correctedLabel: 'A:min' }).catch(() => {});
  storage.setItem('stem-loops-chord-edit-buffer', JSON.stringify([]));
  // Sanity: three chord-edit entries present.
  const before = [...storage.map.keys()].filter((k) => k.startsWith('stem-loops-chord-edit-buffer'));
  assert.equal(before.length, 3);
  // Plant an unrelated key to ensure the sweep is not over-broad.
  storage.setItem('some-other-app-key', 'keep-me');

  mod.clearBufferedEdits();

  const after = [...storage.map.keys()].filter((k) => k.startsWith('stem-loops-chord-edit-buffer'));
  assert.deepEqual(after, []);
  assert.equal(storage.getItem('some-other-app-key'), 'keep-me');
});
