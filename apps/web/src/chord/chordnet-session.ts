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
import { sha256Hex } from './sha256.ts';

export const CHORDNET_INPUT_BINS = 144;
export const DEFAULT_MODEL_URL = '/chord-stub.onnx';
const SS_WEBGPU_DISABLED = 'stem-loops.chordnet.webgpu-disabled-v1';
const PARITY_TOL = 1e-3;

/**
 * Hard upper bound on the ChordNet ONNX payload. The trained variant-Y
 * model is ~14 MB; the stub is tiny. Anything beyond 50 MB is either a
 * mis-routed response (HTML error page from a compromised CDN) or an
 * attempt to exhaust memory before verification completes.
 */
export const MAX_MODEL_BYTES = 50 * 1024 * 1024;

/**
 * Build-time-embedded SHA-256 of the ChordNet ONNX payload (64 lowercase
 * hex chars). Required in production when CHORDS_PROVIDER=internal; the
 * model URL is host-controlled (R2 / CDN) and an unverified byte stream
 * flows directly into a chord decoder whose output seeds the
 * chord-edits → weekly-fine-tune flywheel. See session-6 security audit
 * v2 finding F2 and `cqt-frontend.ts`'s EXPECTED_CQT_PLAN_SHA256 pattern.
 *
 * `null` means the operator has not pinned a hash — a development-only
 * state. `fetchVerifiedModel()` warns in dev (`NODE_ENV !== 'production'`)
 * and throws in prod.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` references at build time, so
 * in the browser bundle this collapses to a literal string. In the Node
 * test harness (where `process.env` can still change), use dynamic import
 * with a cache-busting query string to pick up a new value — see the
 * `.security.test.mjs` suite for the pattern.
 */
function readExpectedModelSha(): string | null {
  if (typeof process === 'undefined' || !process.env) return null;
  const v = process.env.NEXT_PUBLIC_CHORDNET_MODEL_SHA256;
  if (!v) return null;
  const trimmed = v.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export const EXPECTED_MODEL_SHA256: string | null = readExpectedModelSha();

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Module-level cache of verified model bytes, keyed by URL. Both the
 * WASM and WebGPU InferenceSession.create() calls reuse these bytes so
 * we fetch (and verify) once per page-load. Reset for tests via
 * `__resetVerifiedModelCacheForTests()`.
 */
const verifiedModelCache = new Map<string, Uint8Array>();

/**
 * Fetch `url`, cap at MAX_MODEL_BYTES, verify SHA-256 against
 * EXPECTED_MODEL_SHA256, and return the raw ONNX bytes. Throws on any
 * failure mode (fetch non-2xx, oversize, hash mismatch, unset pin in
 * production). Caches per-URL so repeat calls (WASM + WebGPU sessions)
 * don't re-fetch or re-verify.
 *
 * `fetchImpl` is only used by tests; browser callers get global fetch.
 */
export async function fetchVerifiedModel(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const cached = verifiedModelCache.get(url);
  if (cached) return cached;

  const isProd =
    typeof process !== 'undefined' &&
    process.env &&
    process.env.NODE_ENV === 'production';

  // Re-read at call time so the Node test harness can swap env between
  // cases without rewiring the module graph. In the browser bundle,
  // Next.js inlines `process.env.NEXT_PUBLIC_*` at build time, so this
  // collapses to the same literal string the EXPECTED_MODEL_SHA256
  // constant was initialised with.
  const pin = readExpectedModelSha();

  if (!pin) {
    const msg =
      'chordnet: NEXT_PUBLIC_CHORDNET_MODEL_SHA256 is not set — the model ' +
      'URL is unverified. Set a 64-hex SHA-256 before shipping. See ' +
      'session-6 security audit v2 finding F2.';
    if (isProd) throw new Error(msg);
    // eslint-disable-next-line no-console
    console.warn(msg);
  } else if (!HEX64_RE.test(pin)) {
    throw new Error(
      `chordnet: NEXT_PUBLIC_CHORDNET_MODEL_SHA256 must be 64 lowercase hex ` +
        `chars, got ${JSON.stringify(pin).slice(0, 80)}.`,
    );
  }

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `chordnet: fetch ${url} failed: ${res.status} ${res.statusText}`,
    );
  }
  // Size-cap before reading the full body into memory. `content-length`
  // is advisory (a hostile CDN can omit or lie), so we re-check after
  // read as well.
  const declared = Number.parseInt(
    res.headers.get('content-length') ?? '',
    10,
  );
  if (Number.isFinite(declared) && declared > MAX_MODEL_BYTES) {
    throw new Error(
      `chordnet: model declared size ${declared} > ${MAX_MODEL_BYTES} bytes.`,
    );
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_MODEL_BYTES) {
    throw new Error(
      `chordnet: model size ${buf.byteLength} > ${MAX_MODEL_BYTES} bytes.`,
    );
  }
  const bytes = new Uint8Array(buf);

  if (pin) {
    const digest = await sha256Hex(bytes);
    if (digest !== pin) {
      throw new Error(
        `chordnet: model sha mismatch — got ${digest}, expected ` +
          `${pin}. Refusing to load an unverified ONNX. ` +
          `If the model was intentionally rotated, update ` +
          `NEXT_PUBLIC_CHORDNET_MODEL_SHA256. See security audit v2 F2.`,
      );
    }
  }

  verifiedModelCache.set(url, bytes);
  return bytes;
}

/** Test-only — drop the per-URL verified-bytes cache. */
export function __resetVerifiedModelCacheForTests(): void {
  verifiedModelCache.clear();
}

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
  /**
   * Hook for tests: bypass fetch+SHA verification entirely and pass the
   * raw URL string to the session factory. Production code never passes
   * this; the model-SHA gate always runs on first load. See security
   * audit v2 finding F2 and the dedicated `.security.test.mjs` suite.
   */
  skipModelVerification?: boolean;
}

export interface SessionLike {
  run: (
    feeds: Record<string, ort.Tensor>,
  ) => Promise<Record<string, ort.Tensor>>;
  release: () => Promise<void>;
}

export interface SessionFactory {
  /**
   * `source` is either the original model URL (for tests / stubbed
   * factories that don't go through fetchVerifiedModel) or a Uint8Array
   * of pre-verified ONNX bytes (the production path, where both the
   * WASM and WebGPU sessions share one verified buffer).
   */
  create: (
    source: string | Uint8Array,
    opts: { executionProviders: string[] },
  ) => Promise<SessionLike>;
}

const defaultSessionFactory: SessionFactory = {
  async create(source, options) {
    // `ort.InferenceSession.create` has separate overloads for `string` and
    // `Uint8Array`; the union narrows cleanly via typeof so TS picks the
    // right overload at each branch.
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders:
        options.executionProviders as ort.InferenceSession.SessionOptions['executionProviders'],
      graphOptimizationLevel: 'all',
    };
    if (typeof source === 'string') {
      return ort.InferenceSession.create(source, opts) as unknown as SessionLike;
    }
    return ort.InferenceSession.create(source, opts) as unknown as SessionLike;
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

  // Verify the ONNX bytes once per page-load, then hand the same buffer
  // to every InferenceSession.create() call below. The alternative — two
  // separate fetches, one per EP — would fetch the model twice AND open
  // a second TOCTOU window where the CDN could serve different bytes
  // after the parity gate accepted the first. See audit v2 finding F2.
  //
  // `skipModelVerification` is a test-only hook: when set, we pass the
  // URL string straight to the factory (back-compat with pre-F2 tests
  // whose stub factories don't go through fetch).
  const source: string | Uint8Array = opts.skipModelVerification
    ? url
    : await fetchVerifiedModel(url);

  // Create a WASM session first unconditionally — parity needs both.
  const wasmSession = await factory.create(source, {
    executionProviders: ['wasm'],
  });

  if (tryWebGPU && !opts.skipParityGate) {
    try {
      const webgpuSession = await factory.create(source, {
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
      session = await factory.create(source, {
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
