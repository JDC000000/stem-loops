// Run: pnpm test (from apps/web)
//
// Stem loader tests (Track 2B). `fetch` is stubbed; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStems, StemLoadError, MAX_MANIFEST_REFRESHES } from '../src/lib/play/load-stems.ts';
import { PLAYABLE_STEMS } from '../src/lib/play/types.ts';

const JOB = '11111111-2222-3333-4444-555555555555';
const MANIFEST_PATH = `/api/jobs/${JOB}/stems`;

const bytesFor = (s) => new Uint8Array([PLAYABLE_STEMS.indexOf(s) + 1, 9, 9, 9]).buffer;
const manifest = (stems, extra = {}, gen = 0) => ({
  stems: stems.map((s) => ({ stem: s, signed_url: `https://r2.example/${s}.opus?g=${gen}` })),
  expected: [...PLAYABLE_STEMS],
  complete: stems.length === 6,
  state: stems.length === 6 ? 'ready' : 'partial',
  expires_in_sec: 900,
  ...extra,
});
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * Stub fetch. `manifests` is a list of responders, one per manifest call (last one repeats).
 * `stem(name, gen, callIndex)` returns a Response for a stem download.
 */
function makeFetch({ manifests, stem = (n) => new Response(bytesFor(n), { status: 200 }) }) {
  const calls = { manifest: 0, stems: [] };
  const fn = async (url, init) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    url = String(url);
    if (url.endsWith(MANIFEST_PATH)) {
      const m = manifests[Math.min(calls.manifest, manifests.length - 1)];
      calls.manifest += 1;
      return typeof m === 'function' ? m() : m;
    }
    const u = new URL(url);
    const name = u.pathname.slice(1).replace('.opus', '');
    const gen = Number(u.searchParams.get('g'));
    calls.stems.push({ name, gen });
    return stem(name, gen, calls.stems.length - 1, init);
  };
  return { fn, calls };
}

const names = (xs) => xs.map((x) => x.name ?? x);

test('happy path: 6/6 loaded, nothing missing, bytes match per stem', async () => {
  const { fn, calls } = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 6);
  assert.deepEqual(out.missing, []);
  assert.equal(calls.manifest, 1);
  for (const s of out.sources) {
    assert.deepEqual(new Uint8Array(s.bytes), new Uint8Array(bytesFor(s.name)));
  }
});

test('downloads run in parallel, not serially', async () => {
  let inFlight = 0;
  let peak = 0;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return new Response(bytesFor(n), { status: 200 });
    },
  });
  await loadStems(JOB, { fetch: fn });
  assert.equal(peak, 6);
});

test('complete:false with one stem absent: present returned, absent in missing, no throw', async () => {
  const present = PLAYABLE_STEMS.filter((s) => s !== 'drums');
  const { fn, calls } = makeFetch({ manifests: [json(manifest(present))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(names(out.sources), present);
  assert.deepEqual(out.missing, ['drums']);
  assert.equal(calls.stems.length, 5);
});

test('complete:true but a stem absent from the list is still reported missing (do not trust the flag)', async () => {
  const present = PLAYABLE_STEMS.filter((s) => s !== 'vocals');
  const { fn } = makeFetch({ manifests: [json(manifest(present, { complete: true }))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['vocals']);
});

test('one stem download 404s: goes to missing, others load, no throw, no refresh', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => (n === 'bass' ? new Response('nope', { status: 404 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['bass']);
  assert.equal(out.sources.length, 5);
  assert.equal(calls.manifest, 1);
});

test('one stem download throws a network error: goes to missing', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n === 'keys') throw new TypeError('network down');
      return new Response(bytesFor(n), { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['keys']);
});

test('403 (expired URL): manifest re-fetched once, stem retried with the FRESH url, succeeds', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS, {}, 0)), json(manifest(PLAYABLE_STEMS, {}, 1))],
    stem: (n, gen) =>
      n === 'guitar' && gen === 0 ? new Response('expired', { status: 403 }) : new Response(bytesFor(n), { status: 200 }),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, []);
  assert.equal(out.sources.length, 6);
  assert.equal(calls.manifest, 2);
  assert.deepEqual(calls.stems.filter((c) => c.name === 'guitar').map((c) => c.gen), [0, 1]);
});

test('all six 403 together: ONE shared refresh (single-flight), all recover', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS, {}, 0)), json(manifest(PLAYABLE_STEMS, {}, 1))],
    stem: (n, gen) => (gen === 0 ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 6);
  assert.equal(calls.manifest, 2, 'initial + exactly one refresh');
});

test('retry is BOUNDED: perpetual 403 stops at 3 manifest calls (1 + 2 refreshes), stem goes missing', async () => {
  assert.equal(MAX_MANIFEST_REFRESHES, 2);
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => (n === 'drums' ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums']);
  assert.equal(calls.manifest, 3);
  assert.equal(calls.stems.filter((c) => c.name === "drums").length, 3);
});

test('bounded even when ALL stems 403 forever (no retry storm)', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: () => new Response('x', { status: 403 }),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 0);
  assert.equal(out.missing.length, 6);
  assert.equal(calls.manifest, 3);
  assert.ok(calls.stems.length <= 18);
});

test('manifest 429 is distinguishable (RATE_LIMITED) and carries Retry-After; no stem fetched', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json({ error_code: 'RATE_LIMITED', message: 'slow down' }, 429, { 'retry-after': '30' })],
  });
  await assert.rejects(loadStems(JOB, { fetch: fn }), (e) => {
    assert.ok(e instanceof StemLoadError);
    assert.equal(e.code, 'RATE_LIMITED');
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSec, 30);
    return true;
  });
  assert.equal(calls.stems.length, 0);
});

test('429 on a REFRESH is fatal RATE_LIMITED, not a silent "stem missing"', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS)), json({ error_code: 'RATE_LIMITED' }, 429)],
    stem: () => new Response('x', { status: 403 }),
  });
  await assert.rejects(loadStems(JOB, { fetch: fn }), (e) => e.code === 'RATE_LIMITED');
});

test('manifest 404 -> NOT_FOUND; manifest 502 -> MANIFEST_FAILED; bad JSON/shape -> MANIFEST_INVALID', async () => {
  for (const [res, code] of [
    [json({ error_code: 'NOT_FOUND' }, 404), 'NOT_FOUND'],
    [json({ error_code: 'STEM_LIST_FAILED' }, 502), 'MANIFEST_FAILED'],
    [new Response('<html>', { status: 200 }), 'MANIFEST_INVALID'],
    [json({ nope: true }), 'MANIFEST_INVALID'],
    [json(null), 'MANIFEST_INVALID'],
  ]) {
    const { fn } = makeFetch({ manifests: [res] });
    await assert.rejects(loadStems(JOB, { fetch: fn }), (e) => e.code === code, code);
  }
});

test('abort mid-flight: rejects ABORTED, in-flight downloads receive the abort, nothing resolves as a partial success', async () => {
  const ac = new AbortController();
  let sawAbort = 0;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n, _g, _i, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          sawAbort += 1;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  });
  const p = loadStems(JOB, { fetch: fn, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p, (e) => e instanceof StemLoadError && e.code === 'ABORTED');
  assert.equal(sawAbort, 6);
});

test('already-aborted signal: rejects ABORTED without touching the network', async () => {
  const ac = new AbortController();
  ac.abort();
  const { fn, calls } = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS))] });
  await assert.rejects(loadStems(JOB, { fetch: fn, signal: ac.signal }), (e) => e.code === 'ABORTED');
  assert.equal(calls.manifest, 0);
});

test('sources follow PLAYABLE_STEMS order even when manifest and completion order are scrambled', async () => {
  const scrambled = ['other', 'vocals', 'keys', 'guitar', 'bass', 'drums'];
  const delay = { other: 1, vocals: 5, keys: 10, guitar: 15, bass: 20, drums: 25 };
  const { fn } = makeFetch({
    manifests: [json(manifest(scrambled))],
    stem: async (n) => {
      await new Promise((r) => setTimeout(r, 30 - delay[n]));
      return new Response(bytesFor(n), { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(names(out.sources), [...PLAYABLE_STEMS]);
});

test('missing is also in PLAYABLE_STEMS order', async () => {
  const { fn } = makeFetch({ manifests: [json(manifest(['guitar', 'bass']))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums', 'keys', 'vocals', 'other']);
});

// ── adversarial ──────────────────────────────────────────────────────────────

test('zero stems in manifest: returns all six missing, no throw, no stem fetch', async () => {
  const { fn, calls } = makeFetch({ manifests: [json(manifest([], { state: 'encode_failed' }))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.missing, [...PLAYABLE_STEMS]);
  assert.equal(calls.stems.length, 0);
});

test('stem name not in PLAYABLE_STEMS is ignored (never fetched, never returned)', async () => {
  const m = manifest(PLAYABLE_STEMS);
  m.stems.push({ stem: 'kazoo', signed_url: 'https://r2.example/kazoo.opus?g=0' });
  m.stems.push({ stem: '__proto__', signed_url: 'https://r2.example/p.opus?g=0' });
  const { fn, calls } = makeFetch({ manifests: [json(m)] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(names(out.sources), [...PLAYABLE_STEMS]);
  assert.ok(!calls.stems.some((c) => c.name === 'kazoo' || c.name === 'p'));
});

test('duplicate stem entries: first wins, one source, one fetch', async () => {
  const m = manifest(PLAYABLE_STEMS);
  m.stems.push({ stem: 'drums', signed_url: 'https://r2.example/drums.opus?g=7' });
  const { fn, calls } = makeFetch({ manifests: [json(m)] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.filter((s) => s.name === 'drums').length, 1);
  assert.deepEqual(calls.stems.filter((c) => c.name === 'drums'), [{ name: 'drums', gen: 0 }]);
});

test('URL that 200s with an empty body is missing, not a zero-length source', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => (n === 'other' ? new Response(new ArrayBuffer(0), { status: 200 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['other']);
  assert.ok(out.sources.every((s) => s.bytes.byteLength > 0));
});

test('expires_in_sec of 0 / negative / NaN-ish is not trusted and does not cause a refresh loop', async () => {
  for (const v of [0, -5, null, 'soon']) {
    const { fn, calls } = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS, { expires_in_sec: v }))] });
    const out = await loadStems(JOB, { fetch: fn });
    assert.equal(out.sources.length, 6, String(v));
    assert.equal(calls.manifest, 1, String(v));
  }
});

test('bad signed_url entries (non-string, javascript:, empty) are treated as absent', async () => {
  const m = manifest(PLAYABLE_STEMS);
  m.stems[0].signed_url = 'javascript:alert(1)';
  m.stems[1].signed_url = '';
  m.stems[2].signed_url = 42;
  const { fn } = makeFetch({ manifests: [json(m)] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums', 'bass', 'guitar']);
});

test('a refreshed manifest that DROPS a stem makes it missing rather than looping', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS, {}, 0)), json(manifest(PLAYABLE_STEMS.filter((s) => s !== 'keys'), {}, 1))],
    stem: (n, gen) => (n === 'keys' && gen === 0 ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['keys']);
  assert.equal(calls.manifest, 2);
});

test('jobId is URL-encoded into the manifest path', async () => {
  let seen;
  const fn = async (url) => {
    seen = String(url);
    return json(manifest([]));
  };
  await loadStems('a/b?c', { fetch: fn });
  assert.equal(seen, '/api/jobs/a%2Fb%3Fc/stems');
});
