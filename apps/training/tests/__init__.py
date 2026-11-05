"""Tests for the ChordNet training pipeline.

PR-Y1.3 ships:
- test_cqt_plan.py — serialize/deserialize + sha256 stability.
- test_pitch_shift_aug.py — Harte root arithmetic across all 12 pitch classes.
- test_synthetic_render.py — end-to-end pipeline with music21 + FluidSynth mocked.

Nothing in these tests talks to the network or runs real FluidSynth. CI runs
them in the vanilla training venv.
"""
