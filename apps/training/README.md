# apps/training — ChordNet training

Trains the clean-recipe **ChordNet student** (2-encoder / 1-decoder) that powers
stem-loops V3's chord overlay. Per the V3-Phase-2 Y1 decision
(`claude/phase-2-y1-chord-model-decision.md` v1.1), this directory holds the
end-to-end pipeline: data acquisition from permissively licensed corpora,
synthetic rendering, model definition, training, and offline evaluation.

This is a lifestyle-business training pipeline, not an MLOps platform.
Expected shape:

- Runs on a single GPU (Modal L4 / A10, see `TRAINING_MODAL_GPU_ARCH` in
  the repo `.env.example`).
- Produces a single `chordnet-y1.onnx` + weights artifact.
- If the artifact passes the 20-song held-out eval (per the decision record),
  Jon open-sources the weights under **Apache-2.0**, with full attribution
  to every upstream corpus documented in `DATA-PROVENANCE.md`.

## Not the web/worker apps

Nothing in `apps/training/` is imported by `apps/web/` or `apps/worker/` at
runtime. Training outputs the ONNX artifact; the worker loads that artifact
at serve time. The web and worker Docker images do **not** install this
package.

## Status (PR-Y1.2)

This PR ships **scaffolding only**:

- `data/sources.py` — manifest of all 7 approved source corpora.
- `data/download.py` — CLI shell; writes a SHA-256 manifest on download.
- `data/synthetic_render.py` — stub (PR-Y1.3).
- `model/chordnet_2e1d.py`, `train.py`, `eval.py` — stubs (PR-Y1.4).
- `DATA-PROVENANCE.md` — living attribution + audit trail.

No datasets are downloaded by this PR. See `DATA-PROVENANCE.md` for the
cease-and-desist defense trail Jon maintains as the pipeline fills in.

## Quick reference

```bash
# (from repo root, after installing training deps)
python -m training.data.download --list
python -m training.data.download --source guitarset --confirm
```

Downloads cache to `apps/training/data/cache/` (gitignored). Every file is
SHA-256'd on arrival and appended to `cache/MANIFEST.jsonl`. Re-running the
CLI is idempotent: files already present with a matching hash are skipped.
