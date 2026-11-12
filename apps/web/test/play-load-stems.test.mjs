// Run: pnpm test (from apps/web)
//
// Stem loader tests (Track 2B). `fetch` is stubbed; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStems, zeroSourceReason, StemLoadError, MAX_MANIFEST_REFRESHES, MAX_STEM_BYTES, MAX_IDLE_READS } from '../src/lib/play/load-stems.ts';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // A responder, not a single Response: a Response body is single-use, so
  // reusing one object makes every refresh after the first fail with
  // MANIFEST_INVALID. That used to be swallowed, and this test passed for the
  // wrong reason — it was exercising a failing refresh, not a spent budget.
  const { fn, calls } = makeFetch({
    manifests: [() => json(manifest(PLAYABLE_STEMS))],
    stem: (n) => (n === 'drums' ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums']);
  assert.equal(calls.manifest, 3);
  assert.equal(calls.stems.filter((c) => c.name === "drums").length, 3);
});

// NB: bounded PER CALL only. There is no cross-call memory, so this is not a
// retry-storm bound — 30 sequential all-403 loads make 90 manifest requests
// against a 60/min/IP route. Honouring retryAfterSec is the caller's job.
test('bounded within one call even when ALL stems 403 forever', async () => {
  const { fn, calls } = makeFetch({
    manifests: [() => json(manifest(PLAYABLE_STEMS))], // fresh body per refresh
    stem: () => new Response('x', { status: 403 }),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 0);
  assert.equal(out.missing.length, 6);
  assert.equal(calls.manifest, 3);
  assert.ok(calls.stems.length <= 18);
  // Every refresh SUCCEEDED here; the URLs simply stayed dead. So there is no
  // nameable failure, and per the zero-source rule this returns rather than
  // throws. Contrast the next test.
  assert.equal(out.refreshFailure, null);
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

test('429 on a REFRESH with no stem loaded throws RATE_LIMITED, not a silent "stem missing"', async () => {
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

// ── single-flight: the generation counter, specifically ───────────────────────
// The `inflight` guard alone passes a test where all six stems 403 in the same
// instant. These pin the OTHER guard: `generation`, which exists for the 403
// that lands AFTER a refresh has already finished.

test('generation counter: a 403 after the refresh completes reuses it — exactly 2 manifest calls', async () => {
  // drums 403s at t=0 and starts the refresh; the refresh itself takes 60 ms.
  //   bass 403s at t=30, DURING the refresh  -> joins the in-flight one.
  // guitar 403s at t=120, AFTER it finished  -> must notice the generation has
  //   moved past what it saw and retry on the fresh URL, NOT start a second
  //   refresh. Deleting either `if (generation > seen) return` or
  //   `generation += 1` makes this a 3rd manifest call.
  const first403AtMs = { drums: 0, bass: 30, guitar: 120 };
  let manifestIndex = 0;
  let manifestsDone = 0;
  const downloadedOn = [];
  const { fn, calls } = makeFetch({
    manifests: [
      async () => {
        const i = manifestIndex++;
        if (i > 0) await sleep(60);
        manifestsDone += 1;
        return json(manifest(PLAYABLE_STEMS, {}, i));
      },
    ],
    stem: async (n, gen) => {
      if (gen === 0 && n in first403AtMs) {
        await sleep(first403AtMs[n]);
        return new Response('x', { status: 403 });
      }
      downloadedOn.push({ name: n, gen, manifestsDone });
      return new Response(bytesFor(n), { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 6);
  assert.deepEqual(out.missing, []);
  assert.equal(calls.manifest, 2, 'the late 403 must reuse the finished refresh, not start another');
  assert.deepEqual(calls.stems.filter((c) => c.name === 'guitar').map((c) => c.gen), [0, 1]);
  for (const d of downloadedOn) {
    if (d.manifestsDone >= 2) assert.equal(d.gen, 1, `${d.name} downloaded on a stale generation`);
  }
});

// ── a failed REFRESH must not throw away stems that already downloaded ───────

test('refresh 429 after 5 stems downloaded: 5/6 returned, 403 stem missing, rate limit surfaced', async () => {
  // Story 5: the job expiring mid-load is exactly when a partial is worth most.
  // The five good stems are still in flight when the 429 lands, so this also
  // pins that we no longer abort siblings holding valid URLs.
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS)), json({ error_code: 'RATE_LIMITED' }, 429, { 'retry-after': '20' })],
    stem: async (n) => {
      if (n === 'other') return new Response('x', { status: 403 });
      await sleep(20);
      return new Response(bytesFor(n), { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(names(out.sources), PLAYABLE_STEMS.filter((s) => s !== 'other'));
  assert.deepEqual(out.missing, ['other']);
  assert.equal(out.refreshFailure?.code, 'RATE_LIMITED');
  assert.equal(out.refreshFailure?.status, 429);
  assert.equal(out.refreshFailure?.retryAfterSec, 20);
  assert.equal(calls.manifest, 2, 'a route that just refused us is not asked again');
  assert.deepEqual(
    calls.stems.filter((c) => c.name === 'other').map((c) => c.gen),
    [0],
    'once the refresh is refused the dead URL must not be re-tried',
  );
});

test('refresh 404 (job expired mid-load) also degrades rather than discarding good stems', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS)), json({ error_code: 'NOT_FOUND' }, 404)],
    stem: (n) => (n === 'keys' ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 5);
  assert.deepEqual(out.missing, ['keys']);
  assert.equal(out.refreshFailure?.code, 'NOT_FOUND');
  assert.equal(out.refreshFailure?.status, 404);
});

test('refresh 429 with NOTHING downloaded still throws RATE_LIMITED and carries Retry-After', async () => {
  // Zero sources is a failed load, not a degraded player: the caller needs the
  // code to decide when to come back. Removing the throw makes this pass as an
  // empty "success".
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS)), json({ error_code: 'RATE_LIMITED' }, 429, { 'retry-after': '45' })],
    stem: () => new Response('x', { status: 403 }),
  });
  await assert.rejects(loadStems(JOB, { fetch: fn }), (e) => {
    assert.ok(e instanceof StemLoadError);
    assert.equal(e.code, 'RATE_LIMITED');
    assert.equal(e.retryAfterSec, 45);
    return true;
  });
});

test('refreshFailure is null on a clean load and on an ordinarily degraded one', async () => {
  const clean = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS))] });
  assert.equal((await loadStems(JOB, { fetch: clean.fn })).refreshFailure, null);
  const degraded = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS.filter((s) => s !== 'bass')))] });
  const out = await loadStems(JOB, { fetch: degraded.fn });
  assert.deepEqual(out.missing, ['bass']);
  assert.equal(out.refreshFailure, null, 'a plain missing stem is not a refresh failure');
});

// ── byte bound ───────────────────────────────────────────────────────────────

test('a stem declaring a Content-Length over MAX_STEM_BYTES is refused without draining the body', async () => {
  // The stream is infinite: were the declared length ignored, the running count
  // would have to pull ~16 MiB of it before bailing. undici pre-pulls exactly
  // one chunk when it wraps a ReadableStream into a Response, before `loadStems`
  // sees it at all, so 1 is the floor here — not 0.
  const CHUNK = 1024 * 1024;
  let chunksPulled = 0;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'drums') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        pull(c) {
          chunksPulled += 1;
          c.enqueue(new Uint8Array(CHUNK));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(MAX_STEM_BYTES + 1) } });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums']);
  assert.equal(out.sources.length, 5);
  assert.ok(chunksPulled <= 1, `read ${chunksPulled} MiB; the declared length alone must refuse it`);
});

test('a stem that lies about (or omits) Content-Length is cut off by the running byte count', async () => {
  // 64 MB with no Content-Length at all: the only defence is counting as we read.
  const CHUNK = 1024 * 1024;
  let chunksPulled = 0;
  let cancelled = false;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'vocals') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        pull(c) {
          chunksPulled += 1;
          if (chunksPulled > 64) return c.close();
          c.enqueue(new Uint8Array(CHUNK).fill(7));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 }); // no content-length
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['vocals']);
  assert.ok(out.sources.every((s) => s.bytes.byteLength <= MAX_STEM_BYTES));
  // 16 MiB accumulate, the 17th crosses the cap and we cancel, plus undici's
  // one-chunk prefetch = 18. The point is that it is ~17, not 64.
  assert.ok(
    chunksPulled <= MAX_STEM_BYTES / CHUNK + 4,
    `stopped after ${chunksPulled} MiB; must bail at the cap, not read all 64`,
  );
  assert.ok(cancelled, 'the oversize transfer must be cancelled, not just ignored');
});

test('abort while a refresh is in flight: rejects ABORTED and starts no further manifest call', async () => {
  const ac = new AbortController();
  let manifestIndex = 0;
  const { fn, calls } = makeFetch({
    manifests: [
      async () => {
        const i = manifestIndex++;
        if (i > 0) await sleep(200);
        return json(manifest(PLAYABLE_STEMS, {}, i));
      },
    ],
    stem: (n, gen) => (gen === 0 ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  const p = loadStems(JOB, { fetch: fn, signal: ac.signal });
  await sleep(30);
  assert.equal(calls.manifest, 2, 'the refresh is in flight by now');
  const stemsBefore = calls.stems.length;
  ac.abort();
  await assert.rejects(p, (e) => e instanceof StemLoadError && e.code === 'ABORTED');
  await sleep(30);
  assert.equal(calls.manifest, 2);
  assert.equal(calls.stems.length, stemsBefore, 'no download starts after the abort');
});

test('a stem exactly at MAX_STEM_BYTES is accepted; one byte over is missing', async () => {
  // Declared AND actual length are both at the boundary, so this pins `>` (not
  // `>=`) on both gates.
  for (const [size, expectOk] of [
    [MAX_STEM_BYTES, true],
    [MAX_STEM_BYTES + 1, false],
  ]) {
    const { fn } = makeFetch({
      manifests: [json(manifest(PLAYABLE_STEMS))],
      stem: (n) =>
        n === 'bass'
          ? new Response(new Uint8Array(size).fill(3), {
              status: 200,
              headers: { 'content-length': String(size) },
            })
          : new Response(bytesFor(n), { status: 200 }),
    });
    const out = await loadStems(JOB, { fetch: fn });
    const bass = out.sources.find((s) => s.name === 'bass');
    if (expectOk) {
      assert.equal(bass?.bytes.byteLength, MAX_STEM_BYTES, 'the cap is inclusive');
      assert.deepEqual(out.missing, []);
    } else {
      assert.equal(bass, undefined);
      assert.deepEqual(out.missing, ['bass'], String(size));
    }
  }
});

test('a real-sized stem streamed in many chunks is reassembled byte-for-byte', async () => {
  // The bounded reader rebuilds the body itself, so prove it does not corrupt or
  // reorder it across chunk boundaries.
  const payload = new Uint8Array(300_000).map((_, i) => (i * 31 + 7) & 0xff);
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'guitar') return new Response(bytesFor(n), { status: 200 });
      let at = 0;
      const body = new ReadableStream({
        pull(c) {
          if (at >= payload.length) return c.close();
          c.enqueue(payload.slice(at, at + 7919));
          at += 7919;
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  const guitar = out.sources.find((s) => s.name === 'guitar');
  assert.deepEqual(new Uint8Array(guitar.bytes), payload);
});

test('a fetch double with no readable body still gets the cap applied after the fact', async () => {
  // jsdom shims and hand-rolled doubles return objects without `.body`.
  const fn = async (url) => {
    if (String(url).endsWith(MANIFEST_PATH)) return json(manifest(PLAYABLE_STEMS));
    const big = String(url).includes('drums');
    return { status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(big ? MAX_STEM_BYTES + 1 : 4) };
  };
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums']);
  assert.equal(out.sources.length, 5);
});

// ── a refresh failure of ANY kind is recorded, never swallowed ────────────────
// Previously only 429/404 were. A refresh that 5xx'd, failed the network or
// returned junk left `refreshFailure` null AND let the known-dead URL be
// re-fetched for the rest of the budget.

for (const [label, responder, code] of [
  ['502', () => json({ error_code: 'STEM_LIST_FAILED' }, 502), 'MANIFEST_FAILED'],
  ['network error', () => { throw new TypeError('network down'); }, 'MANIFEST_FAILED'],
  ['invalid JSON', () => new Response('<html>', { status: 200 }), 'MANIFEST_INVALID'],
  ['valid JSON, wrong shape', () => json({ nope: true }), 'MANIFEST_INVALID'],
]) {
  test(`refresh ${label}: 5/6 kept, cause named as ${code}, dead URL not re-fetched`, async () => {
    let i = 0;
    const { fn, calls } = makeFetch({
      manifests: [
        () => {
          i += 1;
          return i === 1 ? json(manifest(PLAYABLE_STEMS)) : responder();
        },
      ],
      stem: (n) => (n === 'vocals' ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
    });
    const out = await loadStems(JOB, { fetch: fn });
    assert.equal(out.sources.length, 5, label);
    assert.deepEqual(out.missing, ['vocals']);
    assert.equal(out.refreshFailure?.code, code, label);
    assert.equal(calls.manifest, 2, 'the failing route is not asked a second time');
    assert.deepEqual(
      calls.stems.filter((c) => c.name === 'vocals').map((c) => c.gen),
      [0],
      'the dead URL must not be re-fetched once the refresh has failed',
    );
  });
}

test('refresh 502 with NOTHING loaded throws MANIFEST_FAILED rather than returning an empty success', async () => {
  let i = 0;
  const { fn } = makeFetch({
    manifests: [
      () => {
        i += 1;
        return i === 1 ? json(manifest(PLAYABLE_STEMS)) : json({ error_code: 'STEM_LIST_FAILED' }, 502);
      },
    ],
    stem: () => new Response('x', { status: 403 }),
  });
  await assert.rejects(loadStems(JOB, { fetch: fn }), (e) => {
    assert.ok(e instanceof StemLoadError);
    assert.equal(e.code, 'MANIFEST_FAILED');
    return true;
  });
});

// ── a stem-level 429 is a rate limit too, and must not report null ───────────

test('a stem object answering 429: stem missing, but the rate limit is named with its Retry-After', async () => {
  const { fn, calls } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) =>
      n === 'keys'
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '12' } })
        : new Response(bytesFor(n), { status: 200 }),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 5);
  assert.deepEqual(out.missing, ['keys']);
  assert.equal(out.refreshFailure?.code, 'RATE_LIMITED');
  assert.equal(out.refreshFailure?.status, 429);
  assert.equal(out.refreshFailure?.retryAfterSec, 12);
  assert.equal(calls.manifest, 1, 'a stem 429 is not an expiry; it must not trigger a refresh');
});

test('all six stems 429: nothing loaded, so RATE_LIMITED is thrown', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: () => new Response('x', { status: 429, headers: { 'retry-after': '7' } }),
  });
  await assert.rejects(loadStems(JOB, { fetch: fn }), (e) => {
    assert.equal(e.code, 'RATE_LIMITED');
    assert.equal(e.retryAfterSec, 7);
    return true;
  });
});

// ── the zero-source rule, both halves side by side ───────────────────────────

test('zero sources with no nameable failure is a RETURNED result, not a throw', async () => {
  // The manifest lists nothing: the encode produced no stems. A job state, not
  // a load error. Pinned next to the throwing case so the rule cannot drift.
  const { fn } = makeFetch({ manifests: [json(manifest([], { state: 'encode_failed' }))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.missing, [...PLAYABLE_STEMS]);
  assert.equal(out.refreshFailure, null);
});

test('zero sources because every stem 404s is also a RETURNED result', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: () => new Response('gone', { status: 404 }),
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.sources, []);
  assert.equal(out.missing.length, 6);
  assert.equal(out.refreshFailure, null);
});

// ── byte bound: the branches the first sweep missed ──────────────────────────

test('a bodyless fetch double returning 0 bytes is missing, not a zero-length source', async () => {
  // The empty-body test above uses a real Response, which HAS a .body, so it
  // only ever exercises the streaming path. This reaches the fallback branch.
  const fn = async (url) => {
    if (String(url).endsWith(MANIFEST_PATH)) return json(manifest(PLAYABLE_STEMS));
    const empty = String(url).includes('other');
    return { status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(empty ? 0 : 4) };
  };
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['other']);
  assert.equal(out.sources.length, 5);
});

test('the over-cap Content-Length gate cancels the body rather than abandoning it', async () => {
  let cancelled = false;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'drums') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(MAX_STEM_BYTES + 1) } });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['drums']);
  assert.ok(cancelled, 'the cheap gate must terminate the response, not just drop it');
});

test('a body LONGER than its Content-Length is refused rather than overrunning the buffer', async () => {
  // The pre-sized path trusts Content-Length for sizing only. A sender that
  // declares 1 KiB and then streams more is non-conformant; it must not be able
  // to write past the buffer or smuggle bytes in.
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'bass') return new Response(bytesFor(n), { status: 200 });
      let sent = 0;
      const body = new ReadableStream({
        pull(c) {
          sent += 1;
          if (sent > 40) return c.close();
          c.enqueue(new Uint8Array(1024 * 1024).fill(5)); // 40 MiB behind a 1 KiB CL
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': '1024' } });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['bass']);
  assert.ok(out.sources.every((s) => s.bytes.byteLength <= MAX_STEM_BYTES));
});

test('a body SHORTER than its Content-Length yields exactly the bytes received', async () => {
  const payload = new Uint8Array(5000).map((_, i) => (i * 13 + 1) & 0xff);
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'guitar') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        start(c) {
          c.enqueue(payload);
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': '999999' } });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  const guitar = out.sources.find((s) => s.name === 'guitar');
  assert.equal(guitar.bytes.byteLength, 5000, 'not the 999999 the header claimed');
  assert.deepEqual(new Uint8Array(guitar.bytes), payload);
});

test('malformed Content-Length headers never widen the cap', async () => {
  // Each is paired with a 40 MiB body: whatever the header parses to, the
  // running count is what must stop it.
  for (const cl of ['-1', 'abc', '0', '1e99', '  16777216  ', '100, 100', '0x1000000', '']) {
    const { fn } = makeFetch({
      manifests: [json(manifest(PLAYABLE_STEMS))],
      stem: (n) => {
        if (n !== 'vocals') return new Response(bytesFor(n), { status: 200 });
        let sent = 0;
        const body = new ReadableStream({
          pull(c) {
            sent += 1;
            if (sent > 40) return c.close();
            c.enqueue(new Uint8Array(1024 * 1024).fill(9));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-length': cl } });
      },
    });
    const out = await loadStems(JOB, { fetch: fn });
    assert.deepEqual(out.missing, ['vocals'], `content-length: ${JSON.stringify(cl)}`);
    assert.ok(
      out.sources.every((s) => s.bytes.byteLength <= MAX_STEM_BYTES),
      `content-length: ${JSON.stringify(cl)}`,
    );
  }
});

test('an endless stream of EMPTY chunks is abandoned instead of spinning forever', async () => {
  // `total` never grows, so the byte cap cannot bound this; MAX_IDLE_READS does.
  // Without the bound the read loop never yields and the whole test times out.
  let reads = 0;
  let cancelled = false;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'keys') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        pull(c) {
          reads += 1;
          c.enqueue(new Uint8Array(0));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['keys']);
  assert.equal(out.sources.length, 5);
  assert.ok(cancelled, 'the stalled transfer must be cancelled');
  assert.ok(reads >= MAX_IDLE_READS, `only ${reads} reads; the bound should have been reached`);
  assert.ok(reads < MAX_IDLE_READS * 4, `${reads} reads; must stop promptly at the bound`);
});

test('a timer still fires while a stem body is streaming (the read loop yields)', async () => {
  // Guards the premise behind documenting AbortSignal.timeout as the caller's
  // lever: if the read loop starved the event loop, no timeout could ever fire.
  let ticked = false;
  const t = setTimeout(() => {
    ticked = true;
  }, 5);
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'drums') return new Response(bytesFor(n), { status: 200 });
      let sent = 0;
      const body = new ReadableStream({
        pull(c) {
          sent += 1;
          if (sent > 2000) return c.close();
          c.enqueue(new Uint8Array(0)); // no progress, but bounded
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  await loadStems(JOB, { fetch: fn });
  clearTimeout(t);
  assert.ok(ticked, 'the event loop was starved by the body read');
});

test('AbortSignal.timeout actually fires while a stem body is stalled on empty chunks', async () => {
  // The whole point of yielding on the no-progress path: this is the mitigation
  // the header documents, so it has to be real rather than aspirational.
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'bass') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(0)); // endless, no progress
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const started = Date.now();
  await assert.rejects(
    loadStems(JOB, { fetch: fn, signal: AbortSignal.timeout(40) }),
    (e) => e instanceof StemLoadError && e.code === 'ABORTED',
  );
  assert.ok(Date.now() - started < 4000, 'the timeout must interrupt the stall, not wait it out');
});

test('an over-declared body is refused CLEANLY — cancelled, not left to throw a RangeError', async () => {
  // Without the explicit guard the oversized write throws RangeError and the
  // stem still ends up missing, so the outcome alone cannot tell the two apart.
  // The difference that matters is whether the transfer is terminated.
  let cancelled = false;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'bass') return new Response(bytesFor(n), { status: 200 });
      const body = new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(4096).fill(5)); // endless, behind a 1 KiB CL
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': '1024' } });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, ['bass']);
  assert.ok(cancelled, 'an over-declared body must be cancelled, not abandoned mid-write');
});

test('a fractional Content-Length is treated as absent, not used for pre-sizing', async () => {
  // `new Uint8Array(3.5)` does not throw — it silently truncates to 3. So a
  // fractional length that got trusted would size the buffer short, the
  // over-declared guard would then fire, and a perfectly good 10-byte stem
  // would be dropped. A Content-Length we cannot use is treated as absent, and
  // the body is bounded by MAX_STEM_BYTES alone.
  const payload = new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88, 99, 10]);
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'keys') return new Response(bytesFor(n), { status: 200 });
      return new Response(payload, { status: 200, headers: { 'content-length': '3.5' } });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.missing, []);
  const keys = out.sources.find((s) => s.name === 'keys');
  assert.deepEqual(new Uint8Array(keys.bytes), payload);
});

test('a timer fires during a body of many small NON-empty chunks', async () => {
  // The no-progress yield cannot cover this: these reads all make progress, so
  // only the periodic yield keeps the event loop alive.
  let ticked = false;
  const t = setTimeout(() => {
    ticked = true;
  }, 5);
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'vocals') return new Response(bytesFor(n), { status: 200 });
      let sent = 0;
      const body = new ReadableStream({
        pull(c) {
          sent += 1;
          if (sent > 8000) return c.close();
          c.enqueue(new Uint8Array(1).fill(3)); // 1 byte at a time, from memory
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  clearTimeout(t);
  assert.equal(out.sources.find((s) => s.name === 'vocals').bytes.byteLength, 8000);
  assert.ok(ticked, 'a progress-making read loop must still yield to the event loop');
});

test('empty chunks interspersed with real data do not abandon a body that is progressing', async () => {
  // The idle counter has to reset on every real chunk, or a sender that emits
  // more than MAX_IDLE_READS empty chunks IN TOTAL would be dropped despite
  // delivering the whole stem.
  const realChunks = 40;
  const emptiesEach = Math.ceil((MAX_IDLE_READS * 2) / realChunks);
  let sent = 0;
  let emptied = 0;
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: (n) => {
      if (n !== 'other') return new Response(bytesFor(n), { status: 200 });
      let pending = 0;
      const body = new ReadableStream({
        pull(c) {
          if (pending > 0) {
            pending -= 1;
            emptied += 1;
            return c.enqueue(new Uint8Array(0));
          }
          if (sent >= realChunks) return c.close();
          sent += 1;
          pending = emptiesEach;
          c.enqueue(new Uint8Array(10).fill(1));
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.ok(emptied > MAX_IDLE_READS, `only ${emptied} empty chunks; the test must exceed the bound`);
  assert.deepEqual(out.missing, [], 'a progressing body must not be dropped for interspersed empties');
  assert.equal(out.sources.find((s) => s.name === 'other').bytes.byteLength, realChunks * 10);
});

test('a refresh that throws a non-StemLoadError is still recorded as MANIFEST_FAILED', async () => {
  // Defensive branch: every throw inside fetchManifest builds a StemLoadError
  // today, so this needs a response double that throws on property access.
  let i = 0;
  const fn = async (url, init) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    url = String(url);
    if (url.endsWith(MANIFEST_PATH)) {
      i += 1;
      if (i === 1) return json(manifest(PLAYABLE_STEMS));
      return {
        get status() {
          throw new RangeError('exploding response double');
        },
      };
    }
    return url.includes('drums') ? new Response('x', { status: 403 }) : new Response(new Uint8Array([1, 2]), { status: 200 });
  };
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(out.sources.length, 5);
  assert.deepEqual(out.missing, ['drums']);
  assert.equal(out.refreshFailure?.code, 'MANIFEST_FAILED');
  assert.equal(i, 2, 'the exploding route is not asked again');
});

// ── first-run honesty: WHY did nothing play? ─────────────────────────────────
// Before this, `parseManifest` dropped the route's `state` and every failed
// stem download was a bare `return null`, so an encoder failure, a legacy job and
// a browser that could not reach storage (a missing R2 CORS rule) all came back
// as the same `{ sources: [], refreshFailure: null }` and the UI told all three
// "processed before play-along audio was kept".

const ZERO = { sources: [], manifestState: null, stemFailures: { listed: 0, network: 0, http: 0, body: 0 } };

test('manifestState carries the route\'s own state through, and an unknown one is null', async () => {
  for (const state of ['ready', 'partial', 'unavailable', 'encode_failed']) {
    const { fn } = makeFetch({ manifests: [json(manifest([], { state }))] });
    assert.equal((await loadStems(JOB, { fetch: fn })).manifestState, state);
  }
  for (const state of ['exploded', 7, null, undefined, '__proto__']) {
    const { fn } = makeFetch({ manifests: [json(manifest([], { state }))] });
    assert.equal((await loadStems(JOB, { fetch: fn })).manifestState, null, `state ${String(state)}`);
  }
});

test('manifestState is the REFRESHED manifest\'s, not the first one\'s', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS, { state: 'ready' })), json(manifest(PLAYABLE_STEMS, { state: 'partial' }, 1))],
    stem: (n, gen) => (gen === 0 ? new Response('x', { status: 403 }) : new Response(bytesFor(n), { status: 200 })),
  });
  assert.equal((await loadStems(JOB, { fetch: fn })).manifestState, 'partial');
});

test('encode_failed manifest -> ENCODE_FAILED, not the legacy "no stems"', async () => {
  const { fn } = makeFetch({ manifests: [json(manifest([], { state: 'encode_failed' }))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(zeroSourceReason(out), 'ENCODE_FAILED');
  const legacy = makeFetch({ manifests: [json(manifest([], { state: 'unavailable' }))] });
  assert.equal(zeroSourceReason(await loadStems(JOB, { fetch: legacy.fn })), 'NO_STEMS');
});

test('every stem GET rejecting at the network level (what a missing R2 CORS rule looks like) -> FETCH_NETWORK', async () => {
  const { fn } = makeFetch({
    manifests: [json(manifest(PLAYABLE_STEMS))],
    stem: () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual(out.sources, []);
  assert.equal(out.refreshFailure, null, 'still a returned result: the zero-source rule is unchanged');
  assert.equal(out.stemFailures.listed, 6);
  assert.equal(out.stemFailures.network, 6);
  assert.equal(out.stemFailures.http, 0);
  assert.equal(zeroSourceReason(out), 'FETCH_NETWORK');
  // manifest said `ready`: delivery outranks the job state.
  assert.equal(out.manifestState, 'ready');
});

test('stemFailures carries origins and counts, never a path, query or signature', async () => {
  const signed = PLAYABLE_STEMS.map((s) => ({
    stem: s,
    signed_url: `https://acct.r2.example/bucket/job/${s}.opus?X-Amz-Signature=SECRET&X-Amz-Credential=AKIA`,
  }));
  const { fn } = makeFetch({ manifests: [json({ stems: signed, state: 'ready' })] });
  const out = await loadStems(JOB, {
    fetch: async (url, init) => {
      if (String(url).endsWith(MANIFEST_PATH)) return fn(url, init);
      throw new TypeError('Failed to fetch');
    },
  });
  assert.deepEqual(out.stemFailures.storageOrigins, ['https://acct.r2.example']);
  const dump = JSON.stringify(out.stemFailures);
  for (const leak of ['SECRET', 'AKIA', 'X-Amz', '.opus', '?', '/bucket']) {
    assert.ok(!dump.includes(leak), `stemFailures leaked ${leak}`);
  }
});

test('storage answering 404 for every stem -> FETCH_HTTP with the status; 403 past the refresh budget too', async () => {
  const a = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS))], stem: () => new Response('gone', { status: 404 }) });
  const o = await loadStems(JOB, { fetch: a.fn });
  assert.equal(zeroSourceReason(o), 'FETCH_HTTP');
  assert.deepEqual(o.stemFailures.httpStatuses, [404]);
  assert.equal(o.stemFailures.http, 6);

  // a function responder: a Response body can be read once, and a 403 refreshes the manifest
  const b = makeFetch({ manifests: [() => json(manifest(PLAYABLE_STEMS))], stem: () => new Response('no', { status: 403 }) });
  const o2 = await loadStems(JOB, { fetch: b.fn });
  assert.equal(zeroSourceReason(o2), 'FETCH_HTTP');
  assert.deepEqual(o2.stemFailures.httpStatuses, [403]);
});

test('200 with an empty body for every stem -> FETCH_BODY', async () => {
  const { fn } = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS))], stem: () => new Response(new Uint8Array(0), { status: 200 }) });
  const out = await loadStems(JOB, { fetch: fn });
  assert.equal(zeroSourceReason(out), 'FETCH_BODY');
  assert.equal(out.stemFailures.body, 6);
});

test('a clean load has zero failures and reads PLAYABLE', async () => {
  const { fn } = makeFetch({ manifests: [json(manifest(PLAYABLE_STEMS))] });
  const out = await loadStems(JOB, { fetch: fn });
  assert.deepEqual([out.stemFailures.network, out.stemFailures.http, out.stemFailures.body], [0, 0, 0]);
  assert.equal(zeroSourceReason(out), 'PLAYABLE');
});

test('zeroSourceReason: precedence table', () => {
  const f = (o) => ({ ...ZERO.stemFailures, ...o });
  const r = (o) => zeroSourceReason({ ...ZERO, ...o });
  assert.equal(r({}), 'NO_STEMS');
  assert.equal(r({ manifestState: 'unavailable' }), 'NO_STEMS');
  assert.equal(r({ manifestState: 'encode_failed' }), 'ENCODE_FAILED');
  assert.equal(r({ manifestState: 'ready', stemFailures: f({ listed: 6, network: 6 }) }), 'FETCH_NETWORK');
  assert.equal(r({ stemFailures: f({ listed: 6, http: 6 }) }), 'FETCH_HTTP');
  assert.equal(r({ stemFailures: f({ listed: 6, body: 6 }) }), 'FETCH_BODY');
  // mixed: the browser-level failure is the one an owner must act on
  assert.equal(r({ stemFailures: f({ listed: 6, network: 3, http: 3 }) }), 'FETCH_NETWORK');
  // failures with NOTHING offered cannot be a delivery fault
  assert.equal(r({ stemFailures: f({ listed: 0, network: 2 }) }), 'NO_STEMS');
  // anything playable wins over everything
  assert.equal(r({ sources: [{ name: 'drums', bytes: new ArrayBuffer(1) }], manifestState: 'encode_failed' }), 'PLAYABLE');
});
