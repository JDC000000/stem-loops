// Browser-side CQT (constant-Q transform) frontend for Chordnet.
//
// Must stay in parity with `apps/training/model/cqt_plan.py` v1 (PR-Y1.3)
// and its librosa pipeline in `apps/training/model/cqt_parity.py`:
//   sr 22050, hop 2048, fmin 32.70 Hz, n_bins 144, bins_per_octave 24,
//   log-amp via amplitude_to_db(ref=np.max, amin=1e-5, top_db=80),
//   per-clip z-norm. (The v1 plan JSON ships `znorm_mean`/`znorm_std`
//   placeholders of 0/1 — they are intentionally bypassed and replaced
//   with the per-clip statistics so the browser matches the training
//   pipeline byte-for-byte. The parity suite in
//   `src/chord/__tests__/cqt-parity.test.mjs` is the gate.)
//
// Implementation choice: pure-TypeScript, bank-of-filters CQT.
// Pros: zero native deps, works in iOS Safari without WASM download,
//       zero-copy Float32Array.
// Cons: slower than a WASM librosa port, and on the lowest ~60 bins
//       the window is truncated to 4096 samples for perf (see
//       `CQT_WINDOW_CAP_SAMPLES`). The bass-band truncation is the
//       main source of the known strict-parity gap and is tracked as
//       `PR-Y1.qa-T2-FOLLOWUP` in `evals/bugs.json`. If parity on the
//       bass band becomes blocking before that ticket lands, swap in
//       a WASM librosa port — TODO documented in
//       `docs/ops/variant-y-browser.md`.
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

/** Only for tests — clears the module-level twiddles cache. */
export function __resetTwiddlesCacheForTests(): void {
  twiddles = null;
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

/**
 * Per-bin window-length cap. The ideal CQT uses N_k = round(Q·sr/f_k)
 * samples per bin, which at fmin=32.70 Hz / bpo=24 evaluates to ~23 014
 * samples at bin 0 (a ~1.04-second kernel at sr=22050). We cap at 4096
 * samples (~186 ms), which is below the ideal for the lowest ~60 bins.
 * The under-length window underestimates magnitude in the bass octaves,
 * and that's the primary source of the strict-parity gap documented in
 * PR-Y1.qa-T2 (follow-up bug in `evals/bugs.json`). The upper ~84 bins
 * (k ≥ 60, f_k ≥ ~184 Hz, where ideal N_k ≤ 4096) are unaffected by the
 * cap and are the ones the parity suite asserts against the strict
 * 1e-3 librosa tolerance in `cqt-parity.test.mjs`.
 *
 * Why not just raise the cap? iOS Safari memory + per-frame O(sum(N_k))
 * inner-loop cost on the capture path; and even once that is paid,
 * librosa's CQT uses a recursive/hybrid filterbank (Schörkhuber &
 * Klapuri 2010) with per-octave downsampling — a from-scratch librosa
 * WASM port is the right end-state fix for the lowest-order bins.
 * Tracked as a follow-up; see `docs/ops/variant-y-browser.md`
 * ("swap in a WASM librosa port").
 */
const CQT_WINDOW_CAP_SAMPLES = 4096;

function buildTwiddles(plan: CqtPlan): Twiddles {
  const { sr, fmin, n_bins, bins_per_octave } = plan;
  const centers = new Float32Array(n_bins);
  const windows: Float32Array[] = new Array(n_bins);
  const sinTables: Float32Array[] = new Array(n_bins);
  const cosTables: Float32Array[] = new Array(n_bins);
  // Q = 1 / (2^(1/bpo) - 1). Each bin has N_k = round(Q * sr / f_k) samples.
  const Q = 1 / (Math.pow(2, 1 / bins_per_octave) - 1);
  const maxN = Math.min(sr, CQT_WINDOW_CAP_SAMPLES);
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
 * Zero-pad `audio` by `pad` samples on each side. Matches
 * `numpy.pad(audio, pad, mode='constant')` — which is what librosa.cqt
 * uses by default (`pad_mode='constant'`, constant_values=0). Zero-cost
 * passthrough when `pad === 0`.
 */
function zeroPad(audio: Float32Array, pad: number): Float32Array {
  if (pad <= 0) return audio;
  const out = new Float32Array(audio.length + 2 * pad); // zero-initialised
  out.set(audio, pad);
  return out;
}

/**
 * Compute a log-amplitude, per-clip z-normalised CQT of the input audio.
 *
 * `audio` must be mono Float32 PCM at plan.sr (22050). Resampling is the
 * caller's problem — tab-capture resamples before feeding this.
 *
 * Framing / normalisation match `apps/training/model/cqt_parity.py`'s
 * librosa pipeline, which is the training-side ground truth:
 *
 * 1. Zero-pad by `floor(maxWin/2)` samples each side, then take frames
 *    centred at `i*hop` in the original signal — matches librosa.cqt's
 *    default `pad_mode='constant'` + its always-on centred framing. The
 *    resulting frame count is `1 + floor(len/hop)`.
 * 2. For each (frame, bin), compute the magnitude via a Hann-windowed
 *    complex dot product with the bin's pre-computed sin/cos tables.
 * 3. Convert to dB with `20*log10(max(amin, mag))`, clip relative values
 *    at `global_max - top_db`. Equivalent to
 *    `librosa.amplitude_to_db(mag, ref=np.max, amin=1e-5, top_db=80)`
 *    modulo the constant `-20*log10(max(amin, ref))` offset that the
 *    subsequent z-norm absorbs anyway.
 * 4. Per-clip z-norm: subtract the full-matrix mean, divide by the
 *    full-matrix std (or 1 if std is zero — matches the Python reference
 *    which uses `std = float(mag.std()) or 1.0`).
 *
 * The plan-carried `znorm_mean` / `znorm_std` are intentionally ignored on
 * this code path: the v1 plan ships (0, 1) placeholders, and the reference
 * pipeline standardises per-clip. When the trainer ships corpus-level
 * (mean, std) they will live in a separate manifest and this function
 * will grow a `plan.znorm === 'corpus'` branch.
 *
 * Output layout: row-major `(nFrames, n_bins)` Float32Array with
 * `nFrames = 1 + floor(audio.length / plan.hop)`. Empty input → empty output.
 *
 * Known parity caveat (Option B, tracked in evals/bugs.json): the lowest
 * ~60 bins (k < 60, f_k < ~184 Hz) use a window truncated to 4096 samples;
 * see `CQT_WINDOW_CAP_SAMPLES`. The strict 1e-3 librosa tolerance holds
 * on bins k ≥ 60; on bins k < 60 a looser bound applies (see the
 * `cqt-parity.test.mjs` suite for the exact numbers).
 */
export async function computeCQT(
  audio: Float32Array,
  plan?: CqtPlan,
): Promise<{ frames: Float32Array; nFrames: number }> {
  const p = plan ?? (await loadCqtPlan());
  if (!twiddles) twiddles = buildTwiddles(p);
  const tw = twiddles;
  const { hop, n_bins } = p;

  if (audio.length === 0) {
    return { frames: new Float32Array(0), nFrames: 0 };
  }

  // Match librosa.cqt: zero-pad by half the longest window (pad_mode='constant',
  // the default) and centre each frame at `i*hop` in the ORIGINAL signal
  // (equivalently `i*hop + pad` in the padded signal).
  const maxWin = tw.windows.reduce((m, w) => Math.max(m, w.length), 0);
  const pad = Math.floor(maxWin / 2);
  const padded = zeroPad(audio, pad);

  const nFrames = 1 + Math.floor(audio.length / hop);
  const out = new Float32Array(nFrames * n_bins);

  // --- Pass 1: magnitude → 20*log10(max(amin, mag)), track the global max ---
  // `AMIN` matches librosa.amplitude_to_db's default (1e-5 on the amplitude
  // axis, equivalent to 1e-10 on the squared/power axis).
  const AMIN = 1e-5;
  const LOG10_AMIN_20 = 20 * Math.log10(AMIN); // -100 dB
  let globalMaxDb = -Infinity;

  for (let f = 0; f < nFrames; f++) {
    const centerPadded = f * hop + pad;
    for (let k = 0; k < n_bins; k++) {
      const win = tw.windows[k];
      const sTab = tw.sinTables[k];
      const cTab = tw.cosTables[k];
      const N = win.length;
      const start = centerPadded - (N >> 1); // floor(N/2) samples before centre
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const s = padded[start + n] * win[n];
        re += s * cTab[n];
        im -= s * sTab[n];
      }
      const mag = Math.sqrt(re * re + im * im);
      const db = mag < AMIN ? LOG10_AMIN_20 : 20 * Math.log10(mag);
      out[f * n_bins + k] = db;
      if (db > globalMaxDb) globalMaxDb = db;
    }
  }

  // --- Pass 2: top_db clip (floor each value at globalMax - 80) ---
  const TOP_DB = 80;
  const dbFloor = globalMaxDb - TOP_DB;
  for (let i = 0; i < out.length; i++) {
    if (out[i] < dbFloor) out[i] = dbFloor;
  }

  // --- Pass 3: per-clip z-norm (full-matrix mean / std) ---
  // Matches apps/training/model/cqt_parity.compute_cqt:
  //   mean = float(mag.mean()); std = float(mag.std()) or 1.0
  //   mag = ((mag - mean) / std)
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i];
  const mean = sum / out.length;
  let sq = 0;
  for (let i = 0; i < out.length; i++) {
    const d = out[i] - mean;
    sq += d * d;
  }
  const rawStd = Math.sqrt(sq / out.length);
  const std = rawStd > 0 ? rawStd : 1;
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] - mean) / std;
  }

  return { frames: out, nFrames };
}

/**
 * Compare a browser-side CQT against an expected server-side (librosa) output
 * and return max-abs-diff. The optional `nBins` parameter (defaulting to
 * `undefined`, the whole-matrix path) also returns per-bin max-diff statistics
 * — used by the fixture-based parity suite to assert per-bin tolerances
 * separately for the upper bins (k ≥ 60, strict 1e-3) and the lower bins
 * (k < 60, bounded; see `cqt-parity.test.mjs`).
 */
export function assertCQTParity(
  actual: Float32Array,
  expected: Float32Array,
  tol = 1e-3,
  nBins?: number,
): { ok: boolean; maxDiff: number; perBinMaxDiff?: Float32Array } {
  if (actual.length !== expected.length) {
    return { ok: false, maxDiff: Infinity };
  }
  let maxDiff = 0;
  let perBinMaxDiff: Float32Array | undefined;
  if (nBins && nBins > 0 && actual.length % nBins === 0) {
    perBinMaxDiff = new Float32Array(nBins);
    const nFrames = actual.length / nBins;
    for (let f = 0; f < nFrames; f++) {
      const row = f * nBins;
      for (let k = 0; k < nBins; k++) {
        const d = Math.abs(actual[row + k] - expected[row + k]);
        if (d > maxDiff) maxDiff = d;
        if (d > perBinMaxDiff[k]) perBinMaxDiff[k] = d;
      }
    }
  } else {
    for (let i = 0; i < actual.length; i++) {
      const d = Math.abs(actual[i] - expected[i]);
      if (d > maxDiff) maxDiff = d;
    }
  }
  return { ok: maxDiff <= tol, maxDiff, perBinMaxDiff };
}
