# ONNX int8 export + CQT parity (PR-Y1.5b)

Operational runbook for the ChordNet export pipeline the browser side
(PR-Y1.6, Variant Y) consumes.

Three things live under this doc:

1. How to turn a trained PyTorch checkpoint into a shippable int8 ONNX
   artefact.
2. The gotchas int8 quantization has for the ChordNet architecture
   specifically.
3. The librosa↔browser CQT parity workflow and its known-issue
   browser-side defects.

## 1. Export a trained checkpoint

### Prerequisites

- Both PR-Y1.3 (CQT plan) and PR-Y1.4 (ChordNet model) are merged.
- `apps/training/pyproject.toml` installed (`pip install -e
  apps/training[dev]`), which pins `onnx>=1.15` and `onnxruntime>=1.18`.
- A trained checkpoint at `apps/training/runs/<exp>/best.pt`.

### One-liner

```bash
python -m training.export_onnx \
    --checkpoint apps/training/runs/exp1/best.pt \
    --out       apps/training/dist/chordnet.int8.onnx \
    --opset     17 \
    --quantize  int8
```

What this does:

1. Loads `best.pt` into `ChordNet2E1D` (strict `load_state_dict`).
2. Exports a static-shape fp32 ONNX graph at
   `dist/chordnet.int8.fp32.onnx` (opset 17, input `cqt: (16, 128, 144)`,
   outputs `root / triad / bass_interval / has_7th`).
3. Runs the exported fp32 graph through ONNX Runtime CPU on a
   deterministic random batch and asserts `max |pytorch - onnx| <
   1e-4`. Aborts on drift.
4. Dynamic-quantizes to int8 at `dist/chordnet.int8.onnx` with
   `onnxruntime.quantization.quantize_dynamic`.
5. Runs int8 parity: `max |pytorch - onnx-int8| < 1e-2`. Aborts on
   drift.
6. Size-checks int8 ≤ 10 MB (soft target: < 5 MB; ChordNet ~1.3M params
   → int8 ~1.3 MB).

### Flags that matter

| Flag              | Default                                     | When to override |
| ----------------- | ------------------------------------------- | ---------------- |
| `--opset`         | `17`                                        | Never for ORT Web; opset 17 is the maximum stable ORT-Web contract today. |
| `--quantize`      | `int8`                                      | `none` for an fp32-only export (debugging — do not ship fp32 to users). |
| `--dynamic`       | off (static shape)                          | Only if the browser tiling scheme changes; dynamic axes hurt ORT graph optimisation on mobile. |
| `--fp32-tol`      | `1e-4`                                      | Loosen only to diagnose an export bug — never on a ship path. |
| `--int8-tol`      | `1e-2`                                      | Tighten (`5e-3`) once calibration data available; loosen at your peril. |
| `--random-init`   | off                                         | For CI parity smoke tests without a trained checkpoint. |

### What stays OUT of the ONNX graph (decision v1.3)

- **CQT** — stays in Python (training) and JS (browser). The parity
  fixtures in `apps/training/tests/fixtures/cqt_parity/` keep the two
  implementations locked.
- **CRF decoding / Viterbi smoothing** — ORT Web lacks a native CRF op.
  Browser runs hand-coded Viterbi against the head logits.
- **Argmax over heads → 62-class alphabet collapse** — done in JS so the
  browser can surface top-k alternatives for the chord-edit flywheel
  (PR-Y1.7).

## 2. Int8 quantization gotchas

### Per-tensor vs per-channel

We use **dynamic per-tensor** quantization (`QuantType.QInt8` via
`quantize_dynamic`). Per-channel quantization sometimes helps convolution
accuracy, but:

- ORT Web's per-channel kernels on WASM were buggy as recently as
  1.17.x. The 1.18 release notes still flag "`QLinearConv` per-channel
  axis=1" as a known defect on mobile Safari.
- ChordNet's conv stack is three dilated 1-D convolutions, 128 channels
  each; the per-tensor drift we observe in testing is well within the
  `1e-2` tolerance.

If accuracy on a held-out eval slips by > 2 % between fp32 and int8,
switch to **per-channel on the Linear layers only** (leave `Conv1d` on
per-tensor) and retest with `quantize_dynamic(per_channel=True,
op_types_to_quantize=['MatMul'])`.

### Layers we have seen cause trouble

- **BiGRU gates** — `QGemm` on the GRU gate matrices sometimes blows up
  parity on fp16-WASM, which is why ORT Web's default for us is fp32
  WASM with int8 weights only (`graph_optimization_level=all,
  enable_mem_pattern=False`).
- **Transformer LayerNorm** — never quantize LayerNorm scale/bias
  tensors; the `exclude_nodes` pattern should filter them if a new
  version of ORT ever flips the default.
- **Softmax** — downstream of the heads; stays in JS. Nothing to
  quantize here, listed for completeness.

### ONNX opset 17 pitfalls

- `nn.Transformer` exports fine at opset 17 (we assert this in
  `test_export_onnx.py`). At opset 18+ the `scaled_dot_product_attention`
  decomposition changes; do not bump opset without re-running the
  parity gate.
- `nn.GRU` export uses `Loop` → `LSTM`-family nodes; ORT Web supports
  these, but the first inference on a cold session can be slow
  (<100 ms) due to subgraph JIT. The browser runtime warms up on
  app-load, not on first chord click.

## 3. librosa ↔ browser CQT parity

### The point of the fixtures

Different FFT implementations produce slightly different magnitudes.
librosa uses `scipy.signal.get_window` and a numpy FFT; the browser uses
either `fft-js` (WASM) or a Web Audio `AnalyserNode` wrapper. The
decision record calls this "the single highest-severity load-bearing
assumption of the whole chord-model program." If librosa CQT frames
disagree with the browser's CQT frames by more than ~1 % per bin, the
model (which was trained on librosa CQT) sees input it has never seen
and silently predicts garbage.

We test this by freezing 20 synthetic clips with known inputs, computing
their CQTs with librosa (the ground-truth), and committing the
`(audio.wav, cqt.npy, cqt_sha256)` triples to the repo. The browser
consumes them and asserts its own CQT output matches within tolerance.

### Regenerating the fixtures

The fixtures live at `apps/training/tests/fixtures/cqt_parity/`. To
regenerate from scratch:

```bash
python -m training.model.cqt_parity \
    --out apps/training/tests/fixtures/cqt_parity
```

The generator is **deterministic**: every stochastic kind seeds its RNG
from `ClipSpec.seed`, every timestamp is excluded, every JSON is sorted.
`test_cqt_parity.py::test_generate_fixtures_is_deterministic` enforces
this invariant in CI.

### Tolerances

| Tier    | `max |librosa - browser|` | Who enforces it |
| ------- | ------------------------- | ---------------- |
| Desktop | `1e-3`                    | PR-Y1.6 JS test, WASM/WebGPU backends |
| Mobile  | `1e-2`                    | PR-Y1.6 JS test, Adreno/Mali WASM fallback |
| Hard fail | > `1e-2`                | Do not ship.    |

Default is `1e-3`. Pass `--mobile-tolerance` in the browser test runner
to relax to `1e-2` on devices where the browser has fallen back to WASM
due to a known GPU defect.

### Known issues

- **Adreno 6xx / 750 (Qualcomm)** — Red-team flagged a `Transpose /
  MatMul` ordering bug in Chrome's WebGPU backend on these GPUs through
  Chrome 131. Symptom: CQT magnitudes off by ~3 % on the mid-frequency
  bins only. Mitigation: `apps/web` detects `GPUAdapter.info.vendor ===
  'Qualcomm'` on app load and forces `webgpu=false` so ORT Web falls
  back to WASM. Parity fixtures then pass under the mobile tolerance.
- **Mali G-72 (older Android Samsung)** — Similar story, different
  defect. Same mitigation path.
- **iOS Safari < 17.4** — `OfflineAudioContext.decodeAudioData` resamples
  to the device's hardware rate, not 22050 Hz, so we must resample in JS
  before CQT. The fixture test clip at 22050 Hz catches this: if the
  browser skipped the resample, every fixture CQT fails by orders of
  magnitude.

### Workflow when parity breaks

1. Check the manifest `sha256` field hasn't drifted on `main` since the
   last PR-Y1.6 build (`git log -- apps/training/tests/fixtures/cqt_parity/manifest.json`).
2. If the Python side rebuilt the fixtures: run
   `test_cqt_parity.py::test_committed_fixtures_match_current_sha`. If
   that passes, the Python side is fine and the browser side regressed.
3. If the browser side regressed: bisect against ORT Web upgrades,
   `fft-js` upgrades, and Chrome/Safari point releases. Add a new
   `KNOWN_ISSUES` entry here.
4. Never **both** regenerate the Python fixtures AND loosen the browser
   tolerance in the same PR — the regression gate works only if
   exactly one of those changes happens at a time.
