# apps/training — Data & code provenance

This file records the external data and model-code dependencies this
training pipeline relies on, so trained weights carry a clear license
trail. Data-corpus provenance is populated by PR-Y1.3; this file is also
where **model-code licensing** lives (PR-Y1.4 forward).

## Model code

| Component | Provenance | License |
|-----------|------------|---------|
| ChordNet 2E1D architecture (`model/chordnet_2e1d.py`) | Clean-room implementation inspired by ChordMini 2E1D (Jiang et al., ISMIR 2024); NO pretrained weights loaded. Trained from scratch on this repo's Y1 corpus. | This repo (Apache-2.0 trained weights). |
| CRF layer (`model/crf.py`, PR-Y1.5c) | Thin wrapper around `pytorch-crf` 0.7.2 (`torchcrf.CRF`). See https://github.com/kmkurn/pytorch-crf . | **MIT** (copyright 2017 Kemal Kurniawan; LICENSE.txt in the wheel's dist-info). Compatible with this repo's license. The PR-Y1.5c spec doc mis-cited this as Apache-2.0; the installed package metadata declares MIT, which is strictly less restrictive. |

## Data corpora

(Populated by PR-Y1.3 — Billboard, RWC, Isophonics, GuitarSet, FMA synthetic.
Each row names the corpus, its license, and the per-corpus hash that
training-run manifests record.)

| Corpus | Scope | License | Attribution required |
|--------|-------|---------|----------------------|
| _TBD by PR-Y1.3_ | | | |
