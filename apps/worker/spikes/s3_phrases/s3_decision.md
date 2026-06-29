# S3 Decision Record — Phrase-Boundary Detection

## Heuristic Results (MEASURED on synthetic labeled track)
Run: `python test_boundaries.py` (see `s3_results.json`)
- Boundaries detected: **7** (pass bar ≥5: **YES**)
- Boundary accuracy vs ground truth: **100%** (5/5 transitions within 500ms) (pass bar ≥70%: **YES**)
- Detector runtime: <2s on a 48s track.

⚠️ **Caveat:** measured on a deterministic **synthetic** track (`make_synthetic_fixtures.py`) with
clean, abrupt section changes — it proves the energy + harmonic-novelty heuristic RUNS and detects
boundaries correctly, but it is not a musical-quality judgement on real audio. The operator should
re-run on a real labeled track at the gate. The dev sandbox has no ffmpeg, so the fixture is WAV
(detector is format-agnostic via librosa).

## Decision
[ ] A: Ship heuristic (`boundary_detector.py`) — accuracy meets bar, defer allin1
[ ] B: Adopt allin1 now — heuristic failed

## Developer recommendation
**Ship the heuristic (A)** with the documented allin1 upgrade trigger. Zero added dependency, small
image, fast cold start. T13 (Phase 2 loop extraction) builds on this heuristic from scratch (per the
parent's T13 guidance — V1 code is reference-only and not recovered).

## allin1 Upgrade Trigger
Upgrade to allin1 if, in production, **≥20% of jobs return <5 loops/stem** OR users report
"loops don't feel musical":
- Install: `pip install allin1`
- Replace `boundary_detector.detect_boundaries()` with `allin1.analyze()`
- Cost: ~+200MB worker image, ~+3s latency/job

## Operator actions to open this gate
1. Provide a real labeled track + ground truth (`labeled_song.*` + `labeled_song_ground_truth.json`).
2. Re-run `test_boundaries.py`; confirm musically plausible section labels.

## Gate 0 Status
[ ] APPROVED by operator
