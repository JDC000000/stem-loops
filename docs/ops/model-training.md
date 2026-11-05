# ChordNet 2E1D — training, eval, and alphabet (PR-Y1.4)

**Scope**: the clean-recipe ChordNet student model that powers stem-loops V3's
chord overlay. This doc covers architecture, the training CLI, the eval ship
gate, how to add a new chord quality, and the Modal L4 run template.

Everything here lives under `apps/training/` and is **not imported** by
`apps/web/` or `apps/worker/` at runtime — the training package only ships
weights (an ONNX export + `.pt` checkpoint) that the worker loads at serve
time.

---

## 1. Architecture summary

ChordNet 2E1D = **2 encoders + 1 decoder**, trained from scratch (no BTC /
ChordMini pretrained weights loaded; MIT-licensed *architecture* only).

```
CQT (B, T, 144)
   │
   ▼                                         ┌───────────────────────┐
Linear 144 → 128    ──► Encoder-1 (CNN)  ─► Encoder-2 (Transformer) ─┼──► BiGRU (decoder)
                        3 × Conv1d k=5          4 × TxEncoder          │       │
                        dilation [1, 2, 4]      d=128, h=4, FFN=512    │       ▼
                        ReLU + BN               dropout 0.1            │   output heads
                                                                       │
                                                                       └────┐
                                                                            │
                                 ┌─ "structured" (default) ──────────────┐  │
                                 │  root: 13  triad: 5                   │◄─┘
                                 │  bass_interval: 13   has_7th: 4       │
                                 └───────────────────────────────────────┘
                                 OR
                                 ┌─ "flat170" ───────────────────────────┐
                                 │  170-class Harte alphabet             │◄─
                                 └───────────────────────────────────────┘
```

| Stage           | Shape                                 | Notes                                    |
| --------------- | ------------------------------------- | ---------------------------------------- |
| CQT input       | `(B, T, 144)` float32                 | Frozen by `cqt_plan.py` (PR-Y1.3).       |
| Input proj      | `(B, T, 128)`                         | Linear.                                  |
| Local CNN       | `(B, T, 128)`                         | Dilations 1/2/4; receptive field ≈29 frames. |
| Transformer     | `(B, T, 128)`                         | 4 layers.                                |
| BiGRU           | `(B, T, 256)`                         | 1 layer, 128 hidden × 2 directions.      |
| Heads (struct)  | 4 heads: 13 / 5 / 13 / 4              | Default output mode.                     |
| Heads (flat170) | 170 classes                           | Opt-in.                                  |

**Parameter budget**: ~1.3M (structured) / ~1.4M (flat170) — well below the
2–5M ceiling the PR-Y1.4 spec allows, in line with the single-GPU training
budget (Modal L4 / A10).

**PR-Y1.5** will add a CRF head on top of the BiGRU for Viterbi-smoothed
decoding — the 2E1D architecture itself is the invariant across Y1.4 → Y1.5.

---

## 2. The 62-class alphabet (`model/alphabet.py`)

- **60 chord labels** = 12 roots × 5 qualities (`maj`, `min`, `dim`, `aug`,
  `sus`). The "60-label alphabet" referred to in docs.
- **+2 boundary labels**: `N` (no chord / silence) and `X` (chord present
  but outside the reduced vocabulary).
- **Total output classes** = 62.

Both `N` and `X` are first-class members of the output softmax.
`mir_eval.chord.*` has native support for `N` and drops `X` from the WCSR
denominator, so they interact correctly with the eval gate.

### 170 → 60 collapse

ChordMini and Billboard-style corpora ship with 170-class Harte annotations.
We collapse at decode time:

| 170 qualities (per root)           | Y1 bucket |
| ---------------------------------- | --------- |
| `maj`, `maj6`, `maj7`, `7`         | `maj`     |
| `min`, `min6`, `min7`, `minmaj7`   | `min`     |
| `dim`, `dim7`, `hdim7`             | `dim`     |
| `aug`                              | `aug`     |
| `sus2`, `sus4`                     | `sus`     |

`alphabet.collapse_170_to_60` implements this; the alphabet tests verify the
collapse is total (no orphans across all 170 source indices).

### `ALPHABET_SHA`

`alphabet.ALPHABET_SHA` is a sha256 of the frozen label list. Every training
run writes it into the checkpoint; the worker verifies it on load. **Any
change to roots, qualities, or their ordering breaks the hash and forces a
retrain** — so a decoder/model mismatch fails loud instead of silently
mis-decoding.

---

## 3. Training CLI

```bash
python -m training.train \
  --data-dir apps/training/data/cache \
  --out apps/training/runs/exp1 \
  --epochs 30 \
  --batch-size 24 \
  --lr 1e-3 \
  --gpu l4 \
  --seed 42 \
  --wandb-off
```

**Required**: `--out`.

### Dataset layout

Reads `MANIFEST.jsonl` from `--data-dir`. Each line is one clip:

```json
{
  "cqt_npy":    "path/to/clip.cqt.npy",
  "labels_npy": "path/to/clip.labels.npy",
  "score_file": "billboard/0001/salami_chords.txt",
  "score_sha":  "5a1c…",
  "source":     "billboard",
  "duration_sec": 212.4
}
```

PR-Y1.3 (parallel) owns the pipeline that produces this manifest.

### Train/val/test split

**80 / 10 / 10 by `score_sha`.** Clips are grouped by their upstream score
sha first, then the shas are shuffled and assigned to splits. The same score
rendered multiple times (transpositions, instrument swaps) never crosses a
split boundary, so val/test accuracy is not inflated by near-duplicates.

### Loss

- **Optimizer**: `AdamW(lr=1e-3)`.
- **Scheduler**: `ReduceLROnPlateau(mode="max", factor=0.1, patience=2)` on
  `val_majmin`.
- **Weighted CE** with γ=0.7 tempering and a per-class cap `w_max=20`:
  `w_c = clip((n_total / (K · n_c))**γ, 1/w_max, w_max)`.
- **Grad clip**: max-norm 5.0.
- **Augmentation**: pitch-shift (±5 semitones, uniform) at data-load time
  via `data/pitch_shift_aug.py` (PR-Y1.3; import-guarded here).

### Logging

Each epoch appends a line to `--out/train_log.jsonl`:

```json
{"event": "epoch", "epoch": 7, "train_loss": 1.23, "val_majmin": 0.78,
 "val_sevenths": 0.42, "lr": 0.001}
```

Checkpoints: every epoch writes `--out/epoch-NNN.pt`, and the best-validating
one is mirrored to `--out/best.pt`.

### Weights & Biases

Off by default (`--wandb-off`). When on, uses project
`stem-loops-chordnet` and the run name is derived from `--out.name`.

---

## 4. Eval CLI

```bash
python -m training.eval \
  --checkpoint apps/training/runs/exp1/best.pt \
  --eval-songs apps/worker/tests/fixtures/chord_eval_songs.json \
  --audio-cache apps/worker/.chord-eval-cache \
  --shuffles 3 \
  --report-out apps/training/eval_reports
```

Loads the 20-song held-out eval set from PR-Y1.1
(`apps/worker/tests/fixtures/chord_eval_songs.json`). Audio is fetched on
demand into `--audio-cache` by `apps/worker/tests/test_chord_eval.py` with
`CHORD_EVAL_FETCH=1`.

### Metrics

All five `mir_eval.chord.*` metrics are computed per song, duration-weighted
via `mir_eval.chord.weighted_accuracy`:

| Metric     | mir_eval function          |
| ---------- | -------------------------- |
| `root`     | `mir_eval.chord.root`      |
| `majmin`   | `mir_eval.chord.majmin`    |
| `triads`   | `mir_eval.chord.triads`    |
| `sevenths` | `mir_eval.chord.sevenths`  |
| `mirex`    | `mir_eval.chord.mirex`     |

### Eval gate (verbatim from decision record v1.3)

> **Y1 ship gate: 3 independent shuffle runs of the 20-song eval, reporting
> mean + stddev per metric. Additionally, a per-song MajMin WCSR floor of
> 50% is a hard gate — any single song below 50% MajMin blocks the ship.**

- `--shuffles 3` runs the eval three times with independent deterministic
  seeds; results are pooled over (songs × shuffles) for the aggregate mean
  and stddev.
- `--per-song-floor 0.50` is the hard gate. Below this, the eval raises
  `EvalGateFailure` and exits non-zero. The CI pipeline that calls this
  script treats non-zero as ship-blocking.

### Report schema

Written to `--report-out/eval_<model_version>.json`:

```json
{
  "model_version": "v3-y1-exp1",
  "alphabet_sha":  "…",
  "cqt_plan_version": "v1",
  "dataset_sha":   "…",
  "n_shuffles":    3,
  "per_song": {
    "<song_id>": {
      "majmin":   [0.82, 0.83, 0.81],
      "sevenths": [...],
      "triads":   [...],
      "root":     [...],
      "mirex":    [...]
    }
  },
  "aggregate": {
    "majmin":   {"mean": 0.82, "std": 0.009},
    "...":      {...}
  },
  "per_song_floor_majmin": 0.50,
  "per_song_floor_violated": []
}
```

### Baseline comparison (optional)

`--compare-provider klangio` loads
`apps/worker/tests/fixtures/chord_eval_baseline_klangio.json` and reports a
per-metric delta (model mean − baseline mean) at the bottom of the report.
If the fixture is missing, the field is left `null` with a
`baseline_warning` string — the eval does not fail on a missing baseline.

---

## 5. Adding a new chord quality

The 5-quality collapse is intentionally minimal for Y1. To add a sixth
quality (say, `quartal`):

1. **Edit `apps/training/model/alphabet.py`**: add `"quartal"` to
   `QUALITIES`, update `_HARTE_QUALITY_TO_COLLAPSED` with the mapping, and
   add any new 170-class source qualities to `_ISMIR_170_QUALITIES` if they
   are not already present.
2. **Re-run `_compute_alphabet_sha`** — this happens automatically on import,
   so `ALPHABET_SHA` changes. All existing checkpoints become incompatible.
3. **Bump `output_mode="structured"` `triad` head width** by increasing the
   `len(QUALITIES)` factor in `chordnet_2e1d._StructuredHeads`.
4. **Add test cases** in `tests/test_alphabet.py` covering the new quality
   round-trip and 170-collapse.
5. **Retrain from scratch**. There is no transfer-learning path for a wider
   triad head in Y1.

---

## 6. Modal L4 run template

```python
# apps/training/modal_run.py  (not part of PR-Y1.4 — sketch for PR-Y1.6)
import modal

image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch>=2.1", "torchaudio>=2.1", "librosa>=0.10.2",
    "mir_eval>=0.7", "numpy>=1.26", "pretty_midi>=0.2.10", "pyFluidSynth>=1.3.3",
)

app = modal.App("stem-loops-chordnet-y1")

@app.function(gpu="L4", image=image, timeout=6 * 60 * 60)
def train_remote(seed: int = 42, epochs: int = 30) -> str:
    from training.train import train
    from pathlib import Path
    best = train(
        data_dir=Path("/data/cache"),
        out=Path(f"/runs/exp-{seed}"),
        epochs=epochs,
        batch_size=24,
        lr=1e-3,
        seed=seed,
        output_mode="structured",
        augment_pitch_shift=True,
        wandb_off=False,
        max_steps_per_epoch=0,
        num_workers=4,
        gpu_profile="l4",
    )
    return str(best)
```

Mount `/data/cache` as a Modal volume populated by PR-Y1.3's data pipeline,
mount `/runs` as a volume you can download from, and fire with
`modal run apps/training/modal_run.py::train_remote --seed 42 --epochs 30`.

---

## 7. Decision-record pointers

- `claude/phase-2-y1-chord-model-decision.md` v1.3 — architecture + eval gate
  (**source of truth** for anything this doc summarises).
- `claude/phase-2-y1-chord-model-synthesis.md` — research that fed v1.3.
- `apps/training/DATA-PROVENANCE.md` — license audit trail for the open-
  source weights release.
