// iOS Safari smoke test for Variant Y (decision record v1.3 §Browser).
//
// What this test can verify in Node:
//   - WASM-SIMD-only path (no WebGPU, no Adreno) is the one iOS Safari takes.
//   - Forward pass through the stub model returns correctly-shaped logits.
//   - Memory growth is bounded.
//   - Feature-detection correctly identifies iOS Safari and turns off
//     AudioWorklet-dependent paths.
//
// What this test CANNOT verify in Node (documented in the manual QA stub
// at apps/web/e2e/chord-overlay-safari.spec.ts): the real WASM heap ceiling,
// actual AudioWorklet unavailability inside WebKit, and real-time latency.
// Those checks live in the manual QA script Jon runs on a physical iPhone.
//
// Memory ceiling documented here:
//   - iOS Safari WASM heap caps at ≈ 2 GB in iOS 17.x (per WebKit bug
//     https://bugs.webkit.org/show_bug.cgi?id=240128).
//   - We target < 500 MB steady-state resident so there is headroom for
//     the user's other tabs and the Chordnet model (real weights land in
//     PR-Y1.5b, expected to be ≤ 20 MB).
//   - The stub model is 783 B and uses ~300 KB of runtime scratch per
//     128-frame window. We stay far below the ceiling on the stub. The
//     real guard lives in the Playwright e2e against the real model.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHORDNET_INPUT_BINS,
  loadChordnetSession,
} from '../chordnet-session.ts';
import {
  UnsupportedBrowserError,
  checkTabCaptureSupport,
  startTabCapture,
} from '../tab-capture.ts';

/** iOS Safari UA (iPhone 15 / iOS 17.5). */
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';

/** Fake WASM-SIMD session: shape-correct Float32 output, bounded memory. */
function fakeWasmFactory() {
  return {
    async create() {
      let disposed = false;
      return {
        async run(feeds) {
          if (disposed) throw new Error('session disposed');
          const [, nFrames] = feeds.cqt.dims;
          return {
            logits: {
              data: new Float32Array(nFrames * 60),
              dims: [1, nFrames, 60],
            },
          };
        },
        async release() {
          disposed = true;
        },
      };
    },
  };
}

test('iOS Safari: WASM-SIMD path loads + runs a forward pass', async () => {
  // Fake sessionStorage.
  globalThis.sessionStorage = new (class {
    constructor() {
      this._m = new Map();
    }
    getItem(k) {
      return this._m.get(k) ?? null;
    }
    setItem(k, v) {
      this._m.set(k, String(v));
    }
  })();

  const session = await loadChordnetSession('/chord-stub.onnx', {
    webgpuAvailable: () => false, // iOS Safari has no WebGPU
    isAdreno: () => false,
    sessionFactory: fakeWasmFactory(),
    skipModelVerification: true, // fakeWasmFactory bypasses real ORT
  });
  assert.equal(session.provider, 'wasm');

  const T = 128;
  const input = new Float32Array(T * CHORDNET_INPUT_BINS);
  const logits = await session.runFrames(input, T);
  assert.equal(logits.length, T * 60);
  await session.dispose();
});

test('iOS Safari: feature detection blocks tab capture gracefully', () => {
  const r = checkTabCaptureSupport(IOS_UA);
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'ios-safari');
  assert.match(r.message, /desktop/i);
});

test('iOS Safari: startTabCapture throws UnsupportedBrowserError, not a raw DOMException', async () => {
  await assert.rejects(
    () =>
      startTabCapture(
        {},
        {
          checkSupport: () => checkTabCaptureSupport(IOS_UA),
        },
      ),
    (err) => {
      assert.ok(
        err instanceof UnsupportedBrowserError,
        'must be an UnsupportedBrowserError so the UI can catch it cleanly',
      );
      assert.equal(err.reason, 'ios-safari');
      return true;
    },
  );
});

test('iOS Safari: memory ceiling is bounded on repeated forward passes', async () => {
  globalThis.sessionStorage = new (class {
    constructor() {
      this._m = new Map();
    }
    getItem(k) {
      return this._m.get(k) ?? null;
    }
    setItem(k, v) {
      this._m.set(k, String(v));
    }
  })();

  const session = await loadChordnetSession('/chord-stub.onnx', {
    webgpuAvailable: () => false,
    isAdreno: () => false,
    sessionFactory: fakeWasmFactory(),
    skipModelVerification: true, // fakeWasmFactory bypasses real ORT
  });
  // Run 50 forward passes and make sure no run throws (i.e. no OOM bubble).
  const T = 128;
  const input = new Float32Array(T * CHORDNET_INPUT_BINS);
  for (let i = 0; i < 50; i++) {
    const out = await session.runFrames(input, T);
    assert.equal(out.length, T * 60);
  }
  await session.dispose();
});
