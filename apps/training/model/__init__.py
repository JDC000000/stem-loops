"""ChordNet student model package (PR-Y1.4).

Public surface:

- ``alphabet`` — single source of truth for the 60-chord label alphabet
  (plus the two boundary labels N and X, for 62 output classes total).
- ``chordnet_2e1d`` — the 2-encoder / 1-decoder PyTorch architecture.

PR-Y1.3 (parallel) owns ``cqt_plan.py`` (the frozen CQT hyper-plan).
PR-Y1.5 will add the CRF decoder + Viterbi smoothing on top of this model.
"""
