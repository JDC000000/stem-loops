# Modal signup prep (Y1, Jon-facing)

> Step-by-step for Jon to go from zero to a verified first Modal run. Pairs
> with `apps/training/MODAL_SETUP.md` (reference) and
> `apps/training/MODAL_BILLING.md` (verbatim pricing). Everything PR-Modal-Setup
> (#?? / scripts/modal_train.sh) needs to be usable end-to-end.

## 1. Sign up for Modal

- URL: <https://modal.com/signup>
- Choose the **Starter** plan — it includes **$30 / month in free compute
  credits** (see `MODAL_BILLING.md` §5, verbatim from pricing page
  2026-11-04).
- At L4 pricing ($0.80 / h) that is ~**37.5 L4-hours** / month, which covers
  ~**9 full 4-hour training runs** or ~**18 short 2-hour runs** before any
  dollar is charged. The Week-3 chord-model wave fits inside one month's
  credit if the dispatch lands in a single calendar month.

## 2. Install the Modal CLI

```bash
# macOS (Homebrew)
brew install modal

# OR pip (pins the SDK version the training package expects)
pip install 'modal>=0.65'
```

The repo's `apps/training/pyproject.toml` pins `modal>=0.65`; stay on or
above that.

## 3. Authenticate

```bash
modal setup
```

Opens the browser and writes a token to `~/.modal.toml`. Do **not** commit
that file. If the step is skipped you will get `ModalError: missing
credentials` on the first `modal run`.

## 4. First smoke run

The smoke run exercises the full round trip — image build, volume mount,
checkpoint write — without burning a full training wave. Target cost
**< $0.20** (one short L4 slice).

```bash
# Mock fixtures live under apps/training/tests/fixtures/
./scripts/modal_train.sh --gpu l4 --epochs 1 --seed 42
```

What happens:

1. Modal builds the training image on first invocation (~2-3 min, billed as
   part of the function run).
2. `train_chordnet` on L4 runs one epoch over the mock dataset.
3. On exit, the preemption handler (`apps/training/preemption.py`) snapshots
   the model/optimizer/RNG/epoch to `/data/checkpoints/` on the
   `chordnet-data` volume.
4. Expected wall-clock: ~5 min (dominated by image build on cold account).

> Note: a dedicated `--smoke` flag that forces the tiny fixture corpus and a
> 1-epoch budget is **not yet** wired into `scripts/modal_train.sh`. Until it
> lands, `--epochs 1` + the mock fixtures committed under
> `apps/training/tests/fixtures/` is the equivalent. See
> `apps/training/TRAIN_PY_TODO.md` for the backlog item.

## 5. Verify the checkpoint

```bash
modal volume ls chordnet-data /checkpoints/
```

Expect to see one `.pt` file named `chordnet_<unix-ts>.pt` and/or
`best.pt`.

## 6. Pull the checkpoint locally

```bash
mkdir -p ./local
modal volume get chordnet-data /checkpoints/best.pt ./local/
```

Egress is $0.04 / GiB (`MODAL_BILLING.md` §6); a chord-model checkpoint is
<200 MB, so this is a rounding-error cost (~$0.008).

## 7. When things go wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `ModalError: missing credentials` on first run | `modal setup` not run | Re-run `modal setup`; confirm `~/.modal.toml` exists. |
| Run is terminated mid-way with a SIGTERM warning in logs | GPU preemption (expected on L4 — cannot opt out, see `MODAL_BILLING.md` §3) | Modal auto-restarts on the same input; the preemption handler resumes from the last 5-min checkpoint. No action unless resume loops. |
| `ResourceExhausted / out of credits` | Starter credit used up for the billing cycle | Check <https://modal.com/settings/usage>; wait for cycle rollover or upgrade. Pre-run cost estimate: `python scripts/modal_cost_estimate.py --gpu l4 --hours 4 --runs 10`. |
| `VolumeError: quota exceeded` on `modal volume put` | Corpus + checkpoints > 1 TiB free | Prune old checkpoints: `modal volume rm chordnet-data /checkpoints/<old>.pt`. Projected footprint is <50 GiB so this should not happen in Y1. |
| `CUDA out of memory` on larger batch | Decoder + larger batch exceeds L4's 24 GB | Reduce `batch_size` in `configs/chordnet_2e1d_v1.yaml`, or escalate to A10 (edit `@app.function(gpu=...)` in `modal_app.py`). See `MODAL_SETUP.md` §3. |
| Cold boot stretches past 60 s | Image rebuild (new pinned package, or cache eviction) | Nothing to fix — subsequent runs reuse the warm image. Only the first run of a new image pays the full build. |
| `modal run` hangs at "uploading local source" | Large accidental commit in `./apps/training` | Check `.gitignore` and the `add_local_dir("./apps/training", ...)` scope in `modal_app.py`. Keep datasets in the volume, not the repo. |

## 8. After the smoke passes

Proceed to `docs/ops/y1-first-training-run.md` for the week-long first real
training run, and `docs/ops/y1-production-readiness.md` for the gates to
clear before flipping `CHORDS_PROVIDER=internal`.
