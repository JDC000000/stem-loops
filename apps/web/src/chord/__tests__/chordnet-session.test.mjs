import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHORDNET_INPUT_BINS,
  DEFAULT_MODEL_URL,
  loadChordnetSession,
  resolveModelUrl,
} from '../chordnet-session.ts';

// Stub a sessionStorage so the module's branch-off is predictable per test.
beforeEach(() => {
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

/**
 * Build a tiny fake InferenceSession factory that returns deterministic
 * logits per EP so we can assert EP selection.
 */
function makeFactory({
  webgpuLogitsFill,
  wasmLogitsFill,
  failWebgpu = false,
}) {
  const records = [];
  return {
    records,
    factory: {
      async create(url, opts) {
        records.push({ url, eps: opts.executionProviders });
        if (opts.executionProviders.includes('webgpu') && failWebgpu) {
          throw new Error('fake: webgpu unavailable');
        }
        const fill = opts.executionProviders.includes('webgpu')
          ? webgpuLogitsFill
          : wasmLogitsFill;
        return {
          async run(feeds) {
            const input = feeds.cqt;
            const [, nFrames] = input.dims;
            // Emit (1, nFrames, 60) with the configured fill value.
            const out = new Float32Array(nFrames * 60);
            out.fill(fill);
            return {
              logits: {
                data: out,
                dims: [1, nFrames, 60],
              },
            };
          },
          async release() {
            records.push({ released: opts.executionProviders[0] });
          },
        };
      },
    },
  };
}

test('env override wins over the stub model URL', () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL = 'https://r2.example/x.onnx';
    assert.equal(resolveModelUrl(), 'https://r2.example/x.onnx');
    delete process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL;
    assert.equal(resolveModelUrl(), DEFAULT_MODEL_URL);
  } finally {
    process.env = originalEnv;
  }
});

test('WebGPU unavailable → falls back to WASM', async () => {
  const { factory, records } = makeFactory({
    webgpuLogitsFill: 1,
    wasmLogitsFill: 2,
  });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => false,
    isAdreno: () => false,
    sessionFactory: factory,
  });
  assert.equal(session.provider, 'wasm');
  assert.equal(session.webgpuDisabled, false);
  // Only the WASM session should have been created.
  const created = records.filter((r) => r.url);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].eps, ['wasm']);
});

test('Adreno detection → forces WASM, flags webgpuDisabled', async () => {
  const { factory, records } = makeFactory({
    webgpuLogitsFill: 1,
    wasmLogitsFill: 2,
  });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => true, // would use WebGPU normally
    isAdreno: () => true,
    sessionFactory: factory,
  });
  assert.equal(session.provider, 'wasm');
  assert.equal(session.webgpuDisabled, true);
  const created = records.filter((r) => r.url);
  assert.equal(created.length, 1, 'WebGPU session must not be created');
  assert.deepEqual(created[0].eps, ['wasm']);
});

test('Parity drift → disables WebGPU and persists via sessionStorage', async () => {
  const { factory } = makeFactory({
    webgpuLogitsFill: 0.5,
    wasmLogitsFill: 0.0, // max-abs-diff = 0.5 > 1e-3
  });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => true,
    isAdreno: () => false,
    sessionFactory: factory,
  });
  assert.equal(session.provider, 'wasm');
  assert.equal(session.webgpuDisabled, true);
  // sessionStorage should be flagged so next load skips WebGPU entirely.
  assert.equal(
    globalThis.sessionStorage.getItem('stem-loops.chordnet.webgpu-disabled-v1'),
    '1',
  );
});

test('Parity match → keeps WebGPU', async () => {
  const { factory } = makeFactory({
    webgpuLogitsFill: 0.001,
    wasmLogitsFill: 0.001, // diff 0
  });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => true,
    isAdreno: () => false,
    sessionFactory: factory,
  });
  assert.equal(session.provider, 'webgpu');
  assert.equal(session.webgpuDisabled, false);
});

test('WebGPU create() throws → falls back to WASM', async () => {
  const { factory } = makeFactory({
    webgpuLogitsFill: 1,
    wasmLogitsFill: 1,
    failWebgpu: true,
  });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => true,
    isAdreno: () => false,
    sessionFactory: factory,
  });
  assert.equal(session.provider, 'wasm');
  assert.equal(session.webgpuDisabled, true);
});

test('runFrames: shape mismatch throws', async () => {
  const { factory } = makeFactory({ webgpuLogitsFill: 0, wasmLogitsFill: 0 });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => false,
    sessionFactory: factory,
  });
  await assert.rejects(
    () => session.runFrames(new Float32Array(10), 1),
    /cqt length/,
  );
});

test('runFrames: returns a Float32Array of nFrames * 60', async () => {
  const { factory } = makeFactory({ webgpuLogitsFill: 7, wasmLogitsFill: 7 });
  const session = await loadChordnetSession('/stub.onnx', {
    webgpuAvailable: () => false,
    sessionFactory: factory,
  });
  const nFrames = 5;
  const logits = await session.runFrames(
    new Float32Array(nFrames * CHORDNET_INPUT_BINS),
    nFrames,
  );
  assert.ok(logits instanceof Float32Array);
  assert.equal(logits.length, nFrames * 60);
  assert.equal(logits[0], 7);
});
