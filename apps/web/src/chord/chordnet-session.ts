// Chordnet ONNX session for Variant Y (free-tier live chord overlay).
//
// Pipeline position: cqt-frontend → chordnet-session → viterbi.
//
// Execution-provider strategy per decision record v1.3 §Browser deployment:
//   1. Try WebGPU first on supporting Chrome/Edge.
//   2. Run the parity gate (pre-canned fixture through WebGPU vs WASM-SIMD;
//      max-abs-diff ≤ 1e-3). On mismatch — mostly observed on Adreno 6xx/
//      750 GPUs — disable WebGPU for the session.
//   3. Fall back to WASM-SIMD (works everywhere including iOS Safari).
//
// Audio never leaves the browser (§1.6a). This file only pulls bytes from
// the model URL — no uploads.

import * as ort from 'onnxruntime-web';

import { N_CHORD_CLASSES } from './alphabet.ts';

export const CHORDNET_INPUT_BINS = 144;
export const DEFAULT_MODEL_URL = '/chord-stub.onnx';
const SS_WEBGPU_DISABLED = 'stem-loops.chordnet.webgpu-disabled-v1';
const PARITY_TOL = 1e-3;

export type ExecutionProvider = 'webgpu' | 'wasm';

export interface ChordnetSession {
  /** The provider that actually loaded (post-parity-gate). */
  readonly provider: ExecutionProvider;
  /** Session-only flag: WebGPU was tried and failed parity, or crashed. */
  readonly webgpuDisabled: boolean;
  /**
   * Run per-frame inference. `cqt` is row-major (nFrames × 144). Returns
   * row-major logits of length nFrames × N_CHORD_CLASSES.
   */
  runFrames(cqt: Float32Array, nFrames: number): Promise<Float32Array>;
  /** Release ORT resources. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** Thin shim so tests can inject a fake WebGPU detector. */
export interface LoadOptions {
  /** Default: checks `navigator.gpu`. Return false to force WASM. */
  webgpuAvailable?: () => boolean;
  /**
   * Default: checks WebGL renderer for "Adreno". Return true to force the
   * WASM fallback regardless of parity (used for the Adreno 6xx/750 gate).
   */
  isAdreno?: () => boolean;
  /**
   * Hook for tests: bypass the parity check entirely. Production code never
   * passes this; the gate always runs on first load.
   */
  skipParityGate?: boolean;
  /**
   * Injectable ORT InferenceSession factory. Defaults to onnxruntime-web.
   * Tests pass a fake to exercise EP-selection paths without a WebAssembly
   * runtime.
   */
  sessionFactory?: SessionFactory;
}

export interface SessionLike {
  run: (
    feeds: Record<string, ort.Tensor>,
  ) => Promise<Record<string, ort.Tensor>>;
  release: () => Promise<void>;
}

export interface SessionFactory {
  create: (
    url: string,
    opts: { executionProviders: string[] },
  ) => Promise<SessionLike>;
}

const defaultSessionFactory: SessionFactory = {
  async create(url, options) {
    return ort.InferenceSession.create(url, {
      executionProviders:
        options.executionProviders as ort.InferenceSession.SessionOptions['executionProviders'],
      graphOptimizationLevel: 'all',
    }) as unknown as SessionLike;
  },
};

function defaultWebgpuAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  // @ts-expect-error — `gpu` is not in lib.dom yet on all TS versions
  return typeof navigator.gpu !== 'undefined';
}

function defaultIsAdreno(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ||
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbg) return false;
    const renderer = String(
      gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '',
    );
    return /adreno/i.test(renderer);
  } catch {
    return false;
  }
}

function sessionStorageGet(key: string): string | null {
  try {
    return typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(key)
      : null;
  } catch {
    return null;
  }
}
function sessionStorageSet(key: string, val: string): void {
  try {
    if (typeof sessionStorage !== 'undefined')
      sessionStorage.setItem(key, val);
  } catch {
    /* best-effort */
  }
}

/** 32 zero-padded frames is enough to compare two EPs numerically. */
function parityFixture(): Float32Array {
  const T = 32;
  const buf = new Float32Array(T * CHORDNET_INPUT_BINS);
  // Deterministic ramp so both EPs get the same non-trivial input.
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (i % 97) / 97 - 0.5;
  }
  return buf;
}

async function runOnce(
  session: SessionLike,
  cqt: Float32Array,
  nFrames: number,
): Promise<Float32Array> {
  const tensor = new ort.Tensor('float32', cqt, [
    1,
    nFrames,
    CHORDNET_INPUT_BINS,
  ]);
  const out = await session.run({ cqt: tensor });
  const logits = out.logits ?? out[Object.keys(out)[0]];
  const data = logits.data as Float32Array;
  if (data.length !== nFrames * N_CHORD_CLASSES) {
    throw new Error(
      `chordnet: unexpected output length ${data.length}, expected ${
        nFrames * N_CHORD_CLASSES
      }`,
    );
  }
  return data;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Load the Chordnet ONNX model with the EP-selection strategy above.
 *
 * `url` defaults to the committed stub (`/chord-stub.onnx`). The real model
 * swap is a one-liner: set `NEXT_PUBLIC_CHORDNET_MODEL_URL` to the R2 URL
 * once PR-Y1.5b lands trained weights.
 */
export async function loadChordnetSession(
  url: string = DEFAULT_MODEL_URL,
  opts: LoadOptions = {},
): Promise<ChordnetSession> {
  const webgpuAvailable = opts.webgpuAvailable ?? defaultWebgpuAvailable;
  const isAdreno = opts.isAdreno ?? defaultIsAdreno;
  const factory = opts.sessionFactory ?? defaultSessionFactory;

  const adrenoDetected = isAdreno();
  const webgpuEverDisabled = sessionStorageGet(SS_WEBGPU_DISABLED) === '1';
  const tryWebGPU =
    !adrenoDetected && !webgpuEverDisabled && webgpuAvailable();

  let session: SessionLike | null = null;
  let provider: ExecutionProvider = 'wasm';
  let webgpuDisabled = adrenoDetected || webgpuEverDisabled;

  // Create a WASM session first unconditionally — parity needs both.
  const wasmSession = await factory.create(url, {
    executionProviders: ['wasm'],
  });

  if (tryWebGPU && !opts.skipParityGate) {
    try {
      const webgpuSession = await factory.create(url, {
        executionProviders: ['webgpu'],
      });
      const fixture = parityFixture();
      const T = fixture.length / CHORDNET_INPUT_BINS;
      const [a, b] = await Promise.all([
        runOnce(webgpuSession, fixture, T),
        runOnce(wasmSession, fixture, T),
      ]);
      const diff = maxAbsDiff(a, b);
      if (diff <= PARITY_TOL) {
        session = webgpuSession;
        provider = 'webgpu';
        await wasmSession.release();
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `chordnet: WebGPU/WASM parity drift ${diff.toExponential(
            3,
          )} > ${PARITY_TOL}; disabling WebGPU for this session`,
        );
        sessionStorageSet(SS_WEBGPU_DISABLED, '1');
        webgpuDisabled = true;
        await webgpuSession.release();
        session = wasmSession;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        'chordnet: WebGPU load failed, falling back to WASM:',
        err,
      );
      sessionStorageSet(SS_WEBGPU_DISABLED, '1');
      webgpuDisabled = true;
      session = wasmSession;
    }
  } else if (tryWebGPU && opts.skipParityGate) {
    try {
      session = await factory.create(url, {
        executionProviders: ['webgpu'],
      });
      provider = 'webgpu';
      await wasmSession.release();
    } catch {
      session = wasmSession;
    }
  } else {
    session = wasmSession;
  }

  return {
    provider,
    webgpuDisabled,
    async runFrames(cqt, nFrames) {
      if (!session) throw new Error('chordnet: session disposed');
      if (cqt.length !== nFrames * CHORDNET_INPUT_BINS) {
        throw new Error(
          `chordnet: cqt length ${cqt.length} != nFrames*bins ${
            nFrames * CHORDNET_INPUT_BINS
          }`,
        );
      }
      return runOnce(session, cqt, nFrames);
    },
    async dispose() {
      if (session) {
        await session.release();
        session = null;
      }
    },
  };
}

/** Resolve the configured model URL (env override wins over the stub). */
export function resolveModelUrl(): string {
  if (typeof process !== 'undefined' && process.env) {
    const override = process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL;
    if (override && override.length > 0) return override;
  }
  return DEFAULT_MODEL_URL;
}
