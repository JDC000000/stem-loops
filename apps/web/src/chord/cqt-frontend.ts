// Browser-side CQT (constant-Q transform) frontend for Chordnet.
//
// Must stay in parity with `apps/training/model/cqt_plan.py` v2 (PR-Y1.3b)
// and its librosa pipeline in `apps/training/model/cqt_parity.py`:
//   sr 22050, hop 1024, fmin 32.70 Hz, n_bins 144, bins_per_octave 24,
//   pre-CQT 70 Hz 4th-order Butterworth high-pass, applied zero-phase
//   (forward-backward, == scipy.signal.sosfiltfilt),
//   log-amp via amplitude_to_db(ref=np.max, amin=1e-5, top_db=80),
//   per-song z-norm (each clip against its own full-matrix mean/std).
//   The parity suite in `src/chord/__tests__/cqt-parity.test.mjs` is the gate.
//
// v1 -> v2 deltas: hop 2048 -> 1024; z_norm "global" -> "per_song";
// hpf_hz absent -> 70.0. A model trained on v1 cannot be scored with v2.
//
// FOLLOW-UP (outside this PR's file allowlist): the plan *delivery* layer
// (`loadCqtPlan`, `public/cqt-plan.v1.json`, `EXPECTED_CQT_PLAN_SHA256`) is
// still the v1 JSON + sha gate, and `ChordOverlay.tsx` derives `frameSec`
// from that v1 plan (`plan.hop / plan.sr` = 2048/22050). `computeCQT` no
// longer reads hop/hpf from that object: it uses `CQT_PLAN_V2` below, which
// mirrors `cqt_plan.PLAN`. A follow-up must ship `public/cqt-plan.v2.json`
// (+ sha), retarget the loader, and fix `frameSec` to 1024/22050.
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

/**
 * The v2 plan the CQT core implements. Hand-maintained mirror of
 * `cqt_plan.PLAN` (and `_LOCAL_PLAN` in `cqt_parity.py`); the parity suite
 * asserts it equals the fixture manifest's plan field by field.
 */
export interface CqtPlanV2 {
  version: 'v2';
  sample_rate: number;
  hop_length: number;
  fmin_hz: number;
  n_bins: number;
  bins_per_octave: number;
  log_amplitude: boolean;
  z_norm: 'per_song';
  hpf_hz: number;
}

export const CQT_PLAN_V2: Readonly<CqtPlanV2> = Object.freeze({
  version: 'v2',
  sample_rate: 22050,
  hop_length: 1024,
  fmin_hz: 32.7,
  n_bins: 144,
  bins_per_octave: 24,
  log_amplitude: true,
  z_norm: 'per_song',
  hpf_hz: 70.0,
});

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

function buildTwiddles(plan: CqtPlanV2): Twiddles {
  const sr = plan.sample_rate;
  const fmin = plan.fmin_hz;
  const { n_bins, bins_per_octave } = plan;
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

// ---------------- zero-phase 70 Hz high-pass (v2) ----------------
//
// Port of `cqt_plan.apply_hpf`:
//   sos = butter(4, hpf_hz / (sr/2), btype="highpass", output="sos")
//   sosfiltfilt(sos, y)
// `sosfiltfilt` is NOT a single forward IIR pass. It (1) odd-extends the
// signal by `padlen` samples at both ends, (2) filters forward with the
// steady-state initial state scaled by the first extended sample, (3)
// filters the reversed result again, state scaled by ITS first sample, and
// (4) reverses back and strips the padding. The two passes cancel each
// other's phase response (net response |H|^2, zero phase).
// Everything runs in float64 like scipy; the result is rounded to float32
// to mirror `.astype(np.float32)`.

/** Second-order section [b0, b1, b2, a1, a2] (a0 normalised to 1). */
type Sos = [number, number, number, number, number];

/**
 * 4th-order Butterworth high-pass as 2 biquads (bilinear transform with
 * pre-warping). `fcNorm` is the corner as a fraction of Nyquist, i.e. what
 * scipy's `butter(4, Wn, 'highpass')` takes. Section pairing/order differs
 * from scipy's `zpk2sos`, but the cascade is the same filter.
 */
export function butterHighpass4Sos(fcNorm: number): Sos[] {
  const order = 4;
  const K = Math.tan((Math.PI * fcNorm) / 2);
  const K2 = K * K;
  const sections: Sos[] = [];
  for (let i = 0; i < order / 2; i++) {
    // Analog prototype biquad s^2 + c*s + 1, c = 2 sin((2i+1)pi / (2n)).
    const c = 2 * Math.sin(((2 * i + 1) * Math.PI) / (2 * order));
    const norm = 1 + c * K + K2;
    sections.push([
      1 / norm,
      -2 / norm,
      1 / norm,
      (2 * (K2 - 1)) / norm,
      (1 - c * K + K2) / norm,
    ]);
  }
  return sections;
}

/**
 * Per-section steady-state state for a unit-step input to the whole cascade
 * (scipy `sosfilt_zi`): `lfilter_zi` of each biquad, times the running DC
 * gain of the preceding sections (0 for a high-pass after section 0, so
 * only the first section carries state).
 */
function sosfiltZi(sos: Sos[]): [number, number][] {
  const zis: [number, number][] = [];
  let scale = 1;
  for (const [b0, b1, b2, a1, a2] of sos) {
    const dc = (b0 + b1 + b2) / (1 + a1 + a2);
    zis.push([(dc - b0) * scale, (b2 - a2 * dc) * scale]);
    scale *= dc;
  }
  return zis;
}

/** One causal pass of the biquad cascade (DF2T), in place; state = zi * x0. */
function sosfiltInPlace(sos: Sos[], x: Float64Array, zis: [number, number][]): void {
  const x0 = x[0];
  for (let s = 0; s < sos.length; s++) {
    const [b0, b1, b2, a1, a2] = sos[s];
    let z0 = zis[s][0] * x0;
    let z1 = zis[s][1] * x0;
    for (let n = 0; n < x.length; n++) {
      const xn = x[n];
      const yn = b0 * xn + z0;
      z0 = b1 * xn - a1 * yn + z1;
      z1 = b2 * xn - a2 * yn;
      x[n] = yn;
    }
  }
}

/**
 * Zero-phase forward-backward Butterworth high-pass: the algorithm of
 * `scipy.signal.sosfiltfilt` with defaults (padtype='odd',
 * padlen = 3 * (2 * n_sections + 1) = 15). Returns the input unchanged when
 * `hpfHz <= 0` or `hpfHz >= sr / 2` (same fallbacks as `cqt_plan.apply_hpf`).
 */
export function zeroPhaseHighpass(
  audio: Float32Array,
  hpfHz: number,
  sr: number,
): Float32Array {
  const nyquist = sr / 2;
  if (hpfHz <= 0 || hpfHz >= nyquist) return audio;
  const sos = butterHighpass4Sos(hpfHz / nyquist);
  const padlen = 3 * (2 * sos.length + 1);
  const n = audio.length;
  if (n <= padlen) {
    // scipy raises ValueError here; the training path never feeds such clips.
    throw new Error(`zeroPhaseHighpass: need > ${padlen} samples, got ${n}`);
  }
  // Odd extension: 2*x[0] - x[padlen..1] | x | 2*x[-1] - x[-2..-padlen-1]
  const ext = new Float64Array(n + 2 * padlen);
  for (let i = 0; i < padlen; i++) ext[i] = 2 * audio[0] - audio[padlen - i];
  for (let i = 0; i < n; i++) ext[padlen + i] = audio[i];
  for (let i = 0; i < padlen; i++) {
    ext[padlen + n + i] = 2 * audio[n - 1] - audio[n - 2 - i];
  }
  const zis = sosfiltZi(sos);
  sosfiltInPlace(sos, ext, zis); // forward
  ext.reverse();
  sosfiltInPlace(sos, ext, zis); // backward (state scaled by reversed[0])
  ext.reverse();
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ext[padlen + i];
  return out;
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
 * Compute a log-amplitude, per-song z-normalised CQT of the input audio
 * (v2 pipeline: HPF -> CQT -> dB -> per-song z-norm).
 *
 * `audio` must be mono Float32 PCM at plan.sample_rate (22050). Resampling is the
 * caller's problem — tab-capture resamples before feeding this.
 *
 * Framing / normalisation match `apps/training/model/cqt_parity.py`'s
 * librosa pipeline, which is the training-side ground truth:
 *
 * 0. 70 Hz 4th-order Butterworth high-pass, zero-phase (forward-backward,
 *    scipy `sosfiltfilt` semantics) — see `zeroPhaseHighpass`.
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
 * 4. Per-song z-norm: subtract the full-matrix mean, divide by the
 *    full-matrix (population, ddof=0) std (or 1 if std is zero — matches the Python reference
 *    which uses `std = float(mag.std()) or 1.0`).
 *
 *
 * Output layout: row-major `(nFrames, n_bins)` Float32Array with
 * `nFrames = 1 + floor(audio.length / plan.hop_length)`. Empty input → empty output.
 *
 * Known parity caveat (Option B, tracked in evals/bugs.json): the lowest
 * ~60 bins (k < 60, f_k < ~184 Hz) use a window truncated to 4096 samples;
 * see `CQT_WINDOW_CAP_SAMPLES`. The strict 1e-3 librosa tolerance holds
 * on bins k ≥ 60; on bins k < 60 a looser bound applies (see the
 * `cqt-parity.test.mjs` suite for the exact numbers).
 */
export async function computeCQT(
  audio: Float32Array,
  plan: CqtPlanV2 = CQT_PLAN_V2,
): Promise<{ frames: Float32Array; nFrames: number }> {
  if (plan.version !== 'v2') {
    throw new Error(
      `computeCQT: plan version ${String((plan as { version?: unknown }).version)} ` +
        'is not v2; this build implements the v2 plan only.',
    );
  }
  if (!twiddles) twiddles = buildTwiddles(plan);
  const tw = twiddles;
  const hop = plan.hop_length;
  const n_bins = plan.n_bins;

  if (audio.length === 0) {
    return { frames: new Float32Array(0), nFrames: 0 };
  }

  // v2 step 1: zero-phase high-pass BEFORE the CQT (cqt_plan.apply_hpf).
  audio = zeroPhaseHighpass(audio, plan.hpf_hz, plan.sample_rate);

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

  // --- Pass 3: per-song z-norm (full-matrix mean / std) ---
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
