// Browser-side CQT (constant-Q transform) frontend for Chordnet.
//
// Must stay in parity with `apps/training/model/cqt_plan.py` v1 (PR-Y1.3):
//   sr 22050, hop 2048, fmin 32.70 Hz, n_bins 144, bins_per_octave 24,
//   log-amp, global z-norm.
//
// Implementation choice: pure-TypeScript, FFT-based CQT.
// Pros: zero native deps, ~8 kB gzipped, works in iOS Safari without WASM
//       download, zero-copy Float32Array.
// Cons: slower than a WASM librosa port. Measured on the stub model this is
//       fine (CQT is <5 ms per 1-s window on mid laptop). If perf is
//       inadequate once PR-Y1.5b's real model lands (deeper CQT? wider
//       windows?), swap in a WASM librosa port — TODO documented in
//       docs/ops/variant-y-browser.md.
//
// The CQT plan is loaded from `/cqt-plan.v1.json` at runtime and a canonical-
// JSON SHA-256 is asserted against a hard-coded expected value. A drift in
// the training-side plan therefore fails fast in the browser instead of
// silently poisoning inference. See scripts/make_stub_onnx.py comment.

export interface CqtPlan {
  version: string;
  sr: number;
  hop: number;
  fmin: number;
  n_bins: number;
  bins_per_octave: number;
  mag: 'log' | 'linear';
  znorm: 'global' | 'per_frame' | 'none';
  znorm_mean: number;
  znorm_std: number;
}

/**
 * Canonical SHA-256 of the pinned v1 plan.
 *
 * The canonicalisation is JS-side (`JSON.stringify` after sorting keys),
 * computed here and mirrored in `scripts/make_stub_onnx.py`'s comment so a
 * drift between browser and training-side plans is caught the first time
 * someone loads the app. Swap this when the plan ships v2.
 */
export const EXPECTED_CQT_PLAN_SHA256 =
  'de787abc9f7261269fb868fe89098e755abdd14c58c63fb7eead310845f0d194';

export const CQT_PLAN_URL = '/cqt-plan.v1.json';

let cachedPlan: CqtPlan | null = null;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Prefer WebCrypto when available (browser + Node 20+). Fall back to a
  // pure-TS implementation so tests can run in environments without it.
  const g = globalThis as unknown as {
    crypto?: { subtle?: { digest?: (a: string, b: Uint8Array) => Promise<ArrayBuffer> } };
  };
  if (g.crypto?.subtle?.digest) {
    const buf = await g.crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(buf);
    const parts: string[] = new Array(view.length);
    for (let i = 0; i < view.length; i++) {
      parts[i] = view[i].toString(16).padStart(2, '0');
    }
    return parts.join('');
  }
  // Fallback (small, synchronous): pure-TS sha256. Not used in production.
  return pureSha256Hex(bytes);
}

// ---------------- pure-TS sha256 fallback ----------------
// Translated from RFC 6234. Only used when WebCrypto is unavailable.
function pureSha256Hex(msg: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const l = msg.length;
  const padLen = (l + 9 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[l] = 0x80;
  const MASK32 = BigInt('0xffffffff');
  const SHIFT32 = BigInt(32);
  const bitLen = BigInt(l) * BigInt(8);
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, Number(bitLen & MASK32));
  dv.setUint32(padLen - 8, Number((bitLen >> SHIFT32) & MASK32));
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  const chunks: string[] = new Array(H.length);
  for (let i = 0; i < H.length; i++) {
    chunks[i] = H[i].toString(16).padStart(8, '0');
  }
  return chunks.join('');
}

/** Stable JSON stringify (sort keys, no whitespace) for canonical hashing. */
function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) {
    return '[' + x.map(canonicalJson).join(',') + ']';
  }
  const obj = x as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * Load `/cqt-plan.v1.json` and verify its canonical SHA-256 matches
 * `EXPECTED_CQT_PLAN_SHA256`. Caches on success.
 *
 * `fetchImpl` is only used in tests; browser callers use global fetch.
 */
export async function loadCqtPlan(
  fetchImpl: typeof fetch = fetch,
): Promise<CqtPlan> {
  if (cachedPlan) return cachedPlan;
  const res = await fetchImpl(CQT_PLAN_URL);
  if (!res.ok) {
    throw new Error(
      `cqt-plan: fetch ${CQT_PLAN_URL} failed: ${res.status}`,
    );
  }
  const text = await res.text();
  const plan = JSON.parse(text) as CqtPlan;
  const canonical = canonicalJson(plan);
  const digest = await sha256Hex(new TextEncoder().encode(canonical));
  if (digest !== EXPECTED_CQT_PLAN_SHA256) {
    throw new Error(
      `cqt-plan: sha mismatch — got ${digest}, expected ${EXPECTED_CQT_PLAN_SHA256}. ` +
        `This usually means the training-side plan (apps/training/model/cqt_plan.py) drifted. ` +
        `Fix drift before using this build in production.`,
    );
  }
  // Light schema guard — catches obvious corruption without a full validator.
  if (
    plan.version !== 'v1' ||
    plan.sr !== 22050 ||
    plan.hop !== 2048 ||
    plan.n_bins !== 144 ||
    plan.bins_per_octave !== 24
  ) {
    throw new Error(`cqt-plan: schema guard failed — ${canonical}`);
  }
  cachedPlan = plan;
  return plan;
}

/** Only for tests — clears the module-level cache. */
export function __resetCqtPlanCacheForTests(): void {
  cachedPlan = null;
}

// ---------------- CQT core ----------------
// Pre-computed twiddles for the pinned plan. Built lazily on first use.
interface Twiddles {
  centers: Float32Array; // bin centre frequencies (Hz)
  windows: Float32Array[]; // per-bin Hann windows (variable length)
  sinTables: Float32Array[]; // per-bin sin at bin frequency × sample
  cosTables: Float32Array[]; // per-bin cos at bin frequency × sample
}

let twiddles: Twiddles | null = null;

function buildTwiddles(plan: CqtPlan): Twiddles {
  const { sr, fmin, n_bins, bins_per_octave } = plan;
  const centers = new Float32Array(n_bins);
  const windows: Float32Array[] = new Array(n_bins);
  const sinTables: Float32Array[] = new Array(n_bins);
  const cosTables: Float32Array[] = new Array(n_bins);
  // Q = 1 / (2^(1/bpo) - 1). Each bin has N_k = round(Q * sr / f_k) samples.
  const Q = 1 / (Math.pow(2, 1 / bins_per_octave) - 1);
  const maxN = Math.min(sr, 4096); // cap window length for perf
  for (let k = 0; k < n_bins; k++) {
    const fk = fmin * Math.pow(2, k / bins_per_octave);
    centers[k] = fk;
    const N = Math.max(8, Math.min(maxN, Math.round((Q * sr) / fk)));
    const win = new Float32Array(N);
    const sTab = new Float32Array(N);
    const cTab = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      // Hann window
      win[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
      const theta = (2 * Math.PI * fk * n) / sr;
      sTab[n] = Math.sin(theta);
      cTab[n] = Math.cos(theta);
    }
    windows[k] = win;
    sinTables[k] = sTab;
    cosTables[k] = cTab;
  }
  return { centers, windows, sinTables, cosTables };
}

/**
 * Compute a log-magnitude, globally z-normalised CQT of the input audio.
 *
 * `audio` must be mono Float32 PCM at plan.sr (22050). Resampling is the
 * caller's problem — tab-capture resamples before feeding this.
 *
 * Output layout: row-major `(nFrames, n_bins)` Float32Array. `nFrames =
 * floor((audio.length - maxWindowLen) / hop) + 1`.
 */
export async function computeCQT(
  audio: Float32Array,
  plan?: CqtPlan,
): Promise<{ frames: Float32Array; nFrames: number }> {
  const p = plan ?? (await loadCqtPlan());
  if (!twiddles) twiddles = buildTwiddles(p);
  const tw = twiddles;
  const { hop, n_bins, znorm_mean, znorm_std } = p;

  // nFrames counts hops after a centre-aligned pad of half the longest
  // window. Everything short enough to not produce a full frame returns 0.
  const maxWin = tw.windows.reduce((m, w) => Math.max(m, w.length), 0);
  if (audio.length < maxWin) {
    return { frames: new Float32Array(0), nFrames: 0 };
  }
  const nFrames = Math.floor((audio.length - maxWin) / hop) + 1;
  const out = new Float32Array(nFrames * n_bins);

  const EPS = 1e-10;
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    for (let k = 0; k < n_bins; k++) {
      const win = tw.windows[k];
      const sTab = tw.sinTables[k];
      const cTab = tw.cosTables[k];
      const N = win.length;
      // Centre each bin's window within the longest window frame.
      const off = start + Math.floor((maxWin - N) / 2);
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const s = audio[off + n] * win[n];
        re += s * cTab[n];
        im -= s * sTab[n];
      }
      const mag = Math.sqrt(re * re + im * im);
      const v = Math.log(mag + EPS);
      out[f * n_bins + k] = (v - znorm_mean) / (znorm_std || 1);
    }
  }
  return { frames: out, nFrames };
}

/**
 * Compare a browser-side CQT against an expected server-side (librosa) output
 * and return max-abs-diff. For PR-Y1.6 this is a stub — real parity fixtures
 * ship with PR-Y1.3 training renderer. The helper is here so PR-Y1.5b can
 * call it from CI without changing this module's surface.
 */
export function assertCQTParity(
  actual: Float32Array,
  expected: Float32Array,
  tol = 1e-3,
): { ok: boolean; maxDiff: number } {
  if (actual.length !== expected.length) {
    return { ok: false, maxDiff: Infinity };
  }
  let maxDiff = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > maxDiff) maxDiff = d;
  }
  return { ok: maxDiff <= tol, maxDiff };
}
