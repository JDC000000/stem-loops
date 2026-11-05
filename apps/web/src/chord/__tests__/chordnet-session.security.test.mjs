// Security tests for the ChordNet model-SHA gate (session-6 audit v2 F2).
//
// Loads chordnet-session.ts once, swaps process.env between cases, and
// asserts:
//   * SHA mismatch throws
//   * oversize payload throws (both via content-length and post-read)
//   * unset pin is a warning in dev, throws in prod
//   * malformed pin throws before fetch
//   * non-2xx fetch throws
//   * load path fetches once and shares the verified Uint8Array between
//     the WASM + WebGPU InferenceSession.create() calls (TOCTOU defence)
//
// `fetchVerifiedModel` reads `process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256`
// AT CALL TIME (not at module-load), specifically so this test suite can
// manipulate the env inline. See chordnet-session.ts's readExpectedModelSha().

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  fetchVerifiedModel,
  loadChordnetSession,
  __resetVerifiedModelCacheForTests,
  MAX_MODEL_BYTES,
} from '../chordnet-session.ts';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeFetchReturning(body, { ok = true, status = 200, contentLength } = {}) {
  const headers = new Map();
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength));
  } else {
    headers.set(
      'content-length',
      String(body.byteLength ?? body.length ?? 0),
    );
  }
  return async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      body instanceof Uint8Array
        ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        : body,
  });
}

beforeEach(() => {
  __resetVerifiedModelCacheForTests();
  // Each test sets its own env; clear from prior case.
  delete process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256;
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
    length: 0,
    key: () => null,
  };
});

test('fetchVerifiedModel: SHA mismatch throws', async () => {
  const body = new Uint8Array([1, 2, 3, 4, 5]);
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = 'b'.repeat(64);
  await assert.rejects(
    () => fetchVerifiedModel('/chord.onnx', makeFetchReturning(body)),
    /sha mismatch/,
  );
});

test('fetchVerifiedModel: matching SHA passes and caches on repeat call', async () => {
  const body = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = sha256Hex(Buffer.from(body));
  let fetchCalls = 0;
  const counting = async () => {
    fetchCalls++;
    return makeFetchReturning(body)();
  };
  const first = await fetchVerifiedModel('/chord.onnx', counting);
  const second = await fetchVerifiedModel('/chord.onnx', counting);
  assert.equal(first.length, body.length);
  assert.equal(second, first, 'second call must hit the module cache');
  assert.equal(fetchCalls, 1, 'cache must skip the second fetch');
});

test('fetchVerifiedModel: payload > MAX_MODEL_BYTES is rejected post-read (lied content-length)', async () => {
  // Build > MAX bytes so we can prove the post-read guard fires. The size
  // check runs BEFORE the SHA, so the pin value doesn't matter.
  const oversize = new Uint8Array(MAX_MODEL_BYTES + 1);
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = 'a'.repeat(64);
  const lying = makeFetchReturning(oversize, { contentLength: 1024 });
  await assert.rejects(
    () => fetchVerifiedModel('/chord.onnx', lying),
    /model size .* > .* bytes/,
  );
});

test('fetchVerifiedModel: declared content-length > MAX_MODEL_BYTES rejected upfront', async () => {
  const body = new Uint8Array([1, 2, 3]);
  // Upfront guard runs BEFORE SHA — pin content is irrelevant here.
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = 'a'.repeat(64);
  const lyingBig = makeFetchReturning(body, {
    contentLength: MAX_MODEL_BYTES + 1_000_000,
  });
  await assert.rejects(
    () => fetchVerifiedModel('/chord.onnx', lyingBig),
    /declared size/,
  );
});

test('fetchVerifiedModel: unset SHA in production throws', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      () => fetchVerifiedModel('/chord.onnx', makeFetchReturning(body)),
      /not set/,
    );
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
  }
});

test('fetchVerifiedModel: unset SHA in dev warns and passes', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const out = await fetchVerifiedModel(
      '/chord.onnx',
      makeFetchReturning(body),
    );
    assert.equal(out.length, body.length);
    assert.ok(
      warns.some((w) => /NEXT_PUBLIC_CHORDNET_MODEL_SHA256/.test(w)),
      'dev-mode unset pin must emit a warning',
    );
  } finally {
    console.warn = origWarn;
    process.env.NODE_ENV = prevNodeEnv;
  }
});

test('fetchVerifiedModel: malformed SHA pin (non-hex) throws before fetch', async () => {
  const body = new Uint8Array([1, 2, 3]);
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = 'definitely-not-a-sha';
  // Fetch should not even run — if it does, we'd see fetchCalls > 0.
  let fetchCalls = 0;
  const counting = async () => {
    fetchCalls++;
    return makeFetchReturning(body)();
  };
  await assert.rejects(
    () => fetchVerifiedModel('/chord.onnx', counting),
    /64 lowercase hex/,
  );
  assert.equal(fetchCalls, 0, 'fetch must not run with a malformed pin');
});

test('fetchVerifiedModel: non-2xx fetch throws', async () => {
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = 'a'.repeat(64);
  const notFound = makeFetchReturning(new Uint8Array(0), {
    ok: false,
    status: 404,
  });
  await assert.rejects(
    () => fetchVerifiedModel('/chord.onnx', notFound),
    /failed: 404/,
  );
});

test('loadChordnetSession: fetches once and reuses bytes across WASM + WebGPU sessions', async () => {
  // Pin matches; parity gate stays on so both EP sessions get created,
  // which proves the verified Uint8Array is reused for both.
  const body = new Uint8Array(32);
  for (let i = 0; i < body.length; i++) body[i] = i;
  process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256 = sha256Hex(Buffer.from(body));

  let fetchCalls = 0;
  const counting = async () => {
    fetchCalls++;
    return makeFetchReturning(body)();
  };

  const sources = [];
  const factory = {
    async create(source) {
      sources.push(source);
      return {
        async run(feeds) {
          const [, nFrames] = feeds.cqt.dims;
          return {
            logits: {
              data: new Float32Array(nFrames * 60),
              dims: [1, nFrames, 60],
            },
          };
        },
        async release() {},
      };
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = counting;
  try {
    await loadChordnetSession('/chord.onnx', {
      webgpuAvailable: () => true,
      isAdreno: () => false,
      sessionFactory: factory,
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(fetchCalls, 1, 'model must be fetched exactly once');
  assert.ok(sources.length >= 2, 'both WASM + WebGPU sessions created');
  for (const s of sources) {
    assert.ok(
      s instanceof Uint8Array,
      'factory received verified bytes, not a URL',
    );
  }
  assert.equal(
    sources[0],
    sources[1],
    'both sessions share the same buffer reference',
  );
});
