"""ChordNet student model package.

Public surface across Y1 PRs:

- ``alphabet`` (PR-Y1.4) — single source of truth for the 60-chord label
  alphabet (plus the two boundary labels N and X, for 62 output classes).
- ``chordnet_2e1d`` (PR-Y1.4) — the 2-encoder / 1-decoder PyTorch
  architecture.
- ``cqt_plan`` (PR-Y1.3) — the frozen CQT hyper-plan shared between the
  training pipeline and the browser runtime.
- ``cqt_parity`` (PR-Y1.5b) — the librosa↔browser CQT parity fixture
  generator consumed by the browser side (PR-Y1.6).

PR-Y1.3 and PR-Y1.4 are the parallel branches each module lives on until
they merge; PR-Y1.5b uses import-guards so this package stays importable on
a fresh checkout off ``v3/main``.
"""
