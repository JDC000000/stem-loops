# Y1 first real training run (week-long runbook)

> Day-by-day plan for the FIRST real training wave after the Modal smoke
> run from `modal-signup-prep.md` has passed. Pairs with
> `apps/training/MODAL_BILLING.md` for cost numbers and
> `y1-production-readiness.md` for what "done" looks like.

**Budget:** $30-$80 (first full wave at L4, per decision record v1.3). The
$30/mo Starter credit covers a full 10-run L4 wave at 2h/run; plan dispatch
to land in a single calendar month.

---

## Day 1 — AM: download real-chord datasets

```bash
# Billboard (McGill) — ChoCo CC BY 4.0
python -m training.data.download --source billboard --confirm

# AAM
python -m training.data.download --source aam --confirm

# GuitarSet
python -m training.data.download --source guitarset --confirm
```

Each `--confirm` acknowledges the license readout for that source. Hashes
land in `apps/training/DATA-PROVENANCE.md` (see §3 of
`y1-production-readiness.md` — provenance rows must be complete before the
provider flip).

## Day 1 — PM: render ~10k synthetic songs

```bash
python -m training.data.synthetic_render \
    --sources pdmx openewld \
    --n-songs 10000 \
    --out ./apps/training/data/cache/synthetic
```

Runs CPU-only (`pyFluidSynth` + `music21`). Expect **~2 hours** on a
modern laptop. FluidR3 soundfont SHA is enforced by
`test_fluidr3_sha_guard.py` — if that test is red, stop and fix before
rendering.

## Day 2 — smoke train on ~100 songs

Before paying for the full wave, verify the pipeline converges on a small
subset.

```bash
# Upload the cache
modal volume put chordnet-data ./apps/training/data/cache /

# ~100-song subset config (edit configs/chordnet_2e1d_v1.yaml or clone it)
./scripts/modal_train.sh --gpu l4 --epochs 5 --seed 42 \
    --config configs/chordnet_2e1d_v1_smoke100.yaml
```

Pass criterion: training loss drops monotonically over the 5 epochs and
MajMin on the eval subset is ≥ 40%. If either fails, debug locally before
spending the wave budget.

## Days 3-5 — full training wave on Modal L4

```bash
# One command per shuffle seed; let Modal queue them
for seed in 42 1337 2718; do
    ./scripts/modal_train.sh --gpu l4 --epochs 30 --seed "$seed"
done
```

- Expected wall-clock: **2-4 h per run**; 3-10 runs over 2-3 days.
- Expected cost: **$8-$32** at L4 (see `MODAL_BILLING.md` §9).
- Preemption: Modal's SIGTERM handler + `preemption.py` snapshots every
  5 min. A preempted run auto-restarts on the same input; no manual
  action unless resume loops more than twice.

Pull the best checkpoint from each run at end of day:

```bash
modal volume get chordnet-data /checkpoints/ ./local/checkpoints/
```

## Day 6 — ONNX export + parity validation

```bash
# Export the best checkpoint to int8 ONNX
python -m training.export_onnx \
    --checkpoint ./local/checkpoints/best.pt \
    --out        apps/training/dist/chordnet.int8.onnx \
    --opset      17 \
    --quantize   int8

# CQT parity (<1e-3 vs librosa reference)
pytest apps/training/tests/test_cqt_parity.py

# Full export test suite
pytest apps/training/tests/test_export_onnx.py
```

Hard gates (see `y1-production-readiness.md` §2): ONNX file must be
≤ 10 MB, and all parity tests must be green. If not, do **not** advance to
staging — re-train with a different seed or widen the eval.

## Day 7 — staging deploy, model OFF

Deploy the export to staging with `CHORDS_PROVIDER=klangio` still set as
primary (i.e. the model is available in the worker but not routed to):

```bash
# Build and deploy worker to staging
make deploy-worker STAGE=staging
```

Then run an A/B smoke that calls the internal chord model directly (not via
the provider selector) and compares the top-line MajMin numbers against the
Klangio baseline on the 20-song eval:

```bash
# Direct internal-model eval (bypasses the provider selector)
python -m training.eval \
    --checkpoint ./local/checkpoints/best.pt \
    --manifest   apps/training/data/eval/20song_manifest.jsonl \
    --report     ./local/eval/day7_report.json

# Klangio baseline (reads the same 20-song manifest, calls Klangio API)
python -m training.eval \
    --provider klangio \
    --manifest apps/training/data/eval/20song_manifest.jsonl \
    --report   ./local/eval/day7_klangio_baseline.json
```

If the model clears every gate in `y1-production-readiness.md`, Day 8
becomes the flip PR (`CHORDS_PROVIDER=internal`). If not, the gap between
day-7 numbers and the gates tells you what to fix in the next wave —
alphabet coverage, more synthetic data, a different seed, or a larger-GPU
re-run.
