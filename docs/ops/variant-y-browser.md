# Variant Y — browser live chord overlay

> **STATUS (2026-11-05): PAUSED.** Variant Y is off the critical path; the
> product uses a third-party chord API today.
>
> - The browser CQT (`apps/web/src/chord/cqt-frontend.ts`) is **plan v1**
>   (hop 2048, global z-norm, no high-pass). Training is **plan v2**
>   (hop 1024, per-song z-norm, 70 Hz zero-phase high-pass).
> - Parity gap measured on an attempted (uncommitted) v2 browser port: max abs
>   error **~1.2-1.7** against a **1e-3** tolerance. The ported high-pass was
>   correct (max 2.98e-8 vs `scipy.sosfiltfilt`); the divergence is in the CQT
>   itself.
> - The per-clip numeric tests in
>   `apps/web/src/chord/__tests__/cqt-parity.test.mjs` are **skipped** (visible
>   as skips in test output). Structural checks (manifest, tolerances, SHAs,
>   shapes) still run. No tolerance was loosened.
> - Unblock: a WASM librosa CQT port. Tracking: PR #114 and
>   `evals/bugs.json` `PR-Y1.qa-T2-FOLLOWUP`.

PR-Y1.6 — scaffold shipping with a stub ONNX model. The real weights land in
PR-Y1.5b; swapping them in is a one-line env change.

Decision record: `claude/phase-2-y1-chord-model-decision.md` v1.3 §1.6a
(Variant Y: free-tier live tab-capture chord overlay).

## Architecture

```
┌────────────────────────────┐
│ Browser (Chrome/Edge only) │
│                            │
│ tab-capture ──┐            │     §1.6a: audio stays in the browser.
│  getDisplayMedia           │     Nothing on this diagram leaves the tab.
│ (user click only)          │
│               │            │
│               ▼            │
│  5 s ring buffer           │
│    (Float32, 22050 Hz)     │
│               │            │
│               ▼ per 1 s    │
│  cqt-frontend ─────────┐   │
│   pure-TS CQT          │   │     plan from /cqt-plan.v1.json
│   log-amp + z-norm     │   │     sha-verified vs expected before use
│                        │   │
│                        ▼   │
│  chordnet-session          │     ORT Web, WebGPU → parity gate → WASM
│   (ONNX, opset 17)         │     Adreno 6xx/750 → forced WASM
│                        │   │
│                        ▼   │
│  viterbi.smoothChordSequence       <- PR-Y1.5a dep
│                        │   │
│                        ▼   │
│  smoother.collapseRuns             <- PR-Y1.5a dep
│                        │   │
│                        ▼   │
│  <ChordOverlay/> timeline  │     user clicks a chip → popover →
│    chord-edit popover      │     onChordEdit(payload) → PR-Y1.7 collector
└────────────────────────────┘
```

Relevant source:

| File | Role |
|---|---|
| `apps/web/src/chord/tab-capture.ts` | `getDisplayMedia` + MediaStream → ring buffer, UA-blocks |
| `apps/web/src/chord/cqt-frontend.ts` | Pure-TS CQT, plan sha verifier |
| `apps/web/src/chord/chordnet-session.ts` | ORT Web session, EP selection, parity gate |
| `apps/web/src/chord/viterbi.ts` | PR-Y1.5a dep stub (replace on merge) |
| `apps/web/src/chord/smoother.ts` | PR-Y1.5a dep stub (replace on merge) |
| `apps/web/src/chord/alphabet.ts` | PR-Y1.5a dep stub (replace on merge) |
| `apps/web/src/chord/transition.ts` | PR-Y1.5a dep stub (replace on merge) |
| `apps/web/src/components/ChordOverlay.tsx` | React component |
| `apps/web/src/components/ChordOverlay.helpers.ts` | Pure helpers (testable without jsdom) |
| `apps/web/public/chord-stub.onnx` | 783-byte stub model (Linear 144→60) |
| `apps/web/public/cqt-plan.v1.json` | Pinned v1 CQT plan (sha verified) |
| `scripts/make_stub_onnx.py` | Deterministic rebuild of the stub |

## Browser support matrix

| Browser | Status | Why |
|---|---|---|
| Chrome ≥ 110 (desktop) | Supported | `getDisplayMedia({audio:true})` works; WebGPU on supported GPUs, WASM-SIMD fallback |
| Edge ≥ 110 (desktop)   | Supported | Same |
| Firefox (any)          | **Blocked** | Audio drops silently from tab capture — TSD §5.4 block clause. Banner shown. |
| iOS Safari             | **Blocked** | `getDisplayMedia` not implemented. "Desktop only" banner. |
| Desktop Safari         | **Blocked** | Audio-only tab capture unsupported. Banner shown. |

Detection lives in `checkTabCaptureSupport()`; the Start button is disabled
until support flips to green. Users on blocked browsers never trigger the
pipeline (strict §1.6a: "don't let users mash a broken button").

## Execution provider selection

On every first load of the session:

1. **Detect Adreno** via `WEBGL_debug_renderer_info` (6xx / 750 ship with
   numeric drift on some operators; parity gate catches it but fast-path).
   On match → use WASM-SIMD.
2. **Detect WebGPU** via `navigator.gpu`. If missing → WASM-SIMD.
3. **Parity gate** — create both WASM and WebGPU sessions, run a
   deterministic 32-frame fixture through both, compute max-abs-diff. If
   > 1e-3 → log warning, set `stem-loops.chordnet.webgpu-disabled-v1=1`
   in `sessionStorage`, use WASM for this session.
4. **WebGPU create fails** (driver flaky, out of VRAM) → same fallback.

The sessionStorage flag is session-scoped on purpose: the user can refresh
to re-try WebGPU after a driver update; we don't want a sticky disable.

## Model URL

Resolved via `NEXT_PUBLIC_CHORDNET_MODEL_URL` env var (build-time embedded
by Next.js), falling back to the committed `/chord-stub.onnx`.

When PR-Y1.5b lands real trained weights:

1. Upload the real `.onnx` to R2 (bucket + key TBD in PR-Y1.5b).
2. Set `NEXT_PUBLIC_CHORDNET_MODEL_URL=https://<r2 CDN>/chordnet-vN.onnx` in
   `.env.example`, `.env.local.example`, and Vercel project env.
3. Delete `apps/web/public/chord-stub.onnx` and `scripts/make_stub_onnx.py`.
4. The IO contract is already locked (`(1, N, 144)` Float32 → `(1, N, 60)`
   Float32) — no code change in the browser layer.

## CQT parity

`apps/web/public/cqt-plan.v1.json` mirrors the training-side plan written
by `apps/training/model/cqt_plan.py` v1 (PR-Y1.3). The browser re-computes
a canonical sha256 and asserts it matches `EXPECTED_CQT_PLAN_SHA256` in
`cqt-frontend.ts` before using the plan. **Any drift fails fast at load
time.** When the training-side plan changes, both the JSON file and the
hard-coded sha update in the same PR.

The actual parity gate for the CQT output itself (browser vs librosa on
the same fixture) ships with the training renderer in PR-Y1.3 via
`assertCQTParity()`; a fixture is not yet committed (there is no real
audio corpus until PR-Y1.2 lands).

### Performance TODO

The pure-TS CQT is ~8 kB and runs comfortably under budget on the stub
(sub-5 ms per 1-s window on mid-tier laptops). If the real model (deeper
features, wider window) pushes this over a 20 ms per-second ceiling,
swap to a WASM librosa port (~400 kB WASM download). The hook is already
there — `computeCQT()` returns a `{frames, nFrames}` tuple and nothing
about the public contract depends on the implementation.

## iOS Safari smoke test (manual QA)

Playwright is not yet wired up in this repo; the stub at
`apps/web/e2e/chord-overlay-safari.spec.ts` documents the steps Jon runs
on a real iPhone before shipping PR-Y1.5b.

Steps:

1. On a real iPhone running the latest stable iOS, open
   `https://stem-loops.com` in Safari.
2. Navigate to the chord overlay surface.
3. Confirm the banner "Live chord overlay is desktop-only" renders.
4. Confirm the "Start live overlay" button is **disabled**.
5. Connect Web Inspector over USB. Confirm no `AudioContext` is created,
   no `getDisplayMedia` prompt appears.
6. Confirm the page does not crash under Low Power Mode.

Any failure → DO NOT SHIP, file a repro in `evals/bugs.json`.

### Memory ceiling

iOS Safari's WASM heap caps at roughly 2 GB in iOS 17.x (WebKit bug
[#240128](https://bugs.webkit.org/show_bug.cgi?id=240128)). Our steady-
state target is **< 500 MB** resident so the user's other tabs have
headroom and the real Chordnet weights (expected ≤ 20 MB in PR-Y1.5b)
fit comfortably. The committed stub uses negligible memory; the real
guard will be the Playwright-driven smoke test against the real model.

### AudioWorklet

Not available in iOS Safari for user-captured streams. The
`getDisplayMedia` check happens first, so iOS Safari never reaches the
AudioContext construction path anyway. When Playwright coverage lands we
feature-detect `audioWorklet` explicitly and surface a clear error.

## Future work (out of scope for PR-Y1.6)

- **PR-Y1.5a** (in flight): replace the four stub files under
  `apps/web/src/chord/{alphabet,viterbi,transition,smoother}.ts` with the
  real Viterbi + Harte alphabet + transition matrix. Imports do not change.
- **PR-Y1.5b**: swap the stub ONNX for the trained weights (see above).
- **PR-Y1.7**: AudioWorklet replacement for ScriptProcessorNode; edit-
  collector that consumes `onChordEdit` into a durable store.
- **Observability**: Sentry breadcrumbs on EP fallback + parity failures.
