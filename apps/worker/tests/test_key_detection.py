"""Musical key is detected from the SONG, not from the drums stem.

Regression for 2026-11-18: prod tagged Jon's three songs G minor / B minor / C# major
(truth: A major / A minor / G major) while the same `detect_bpm_and_key` on the original
mixes gave the right keys. `extract_and_tag` was handing the tagger the beat-reference
stem (drums whenever drums exist), which has no tonal centre.

All audio is synthesised in-test; nothing is committed (AGENTS.md §8: no audio outside
fixtures/, and no copyrighted audio at all).
"""

from __future__ import annotations

import os

import numpy as np
import pytest
import soundfile as sf

from worker import pipeline
from worker.tagger.bpm_key import detect_bpm_and_key

SR = 44100
BPM = 102.0
JOB = "00000000-0000-4000-8000-0000000cee01"
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _hz(midi: int) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _tone(midi: int, dur: float) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    env = np.minimum(1.0, t / 0.01) * np.exp(-t * 1.5)
    # A few harmonics so it reads like an instrument, not a pure sine.
    return env * sum(
        a * np.sin(2 * np.pi * _hz(midi) * k * t) for k, a in ((1, 1), (2, 0.4), (3, 0.2))
    )


def _progression(tonic_midi: int, bars: int = 16) -> tuple[np.ndarray, np.ndarray]:
    """I-IV-V-I in the major key on ``tonic_midi``: (chords stem, bass stem), one chord a bar."""
    bar = 4 * 60.0 / BPM
    chords = np.zeros(int(bars * bar * SR))
    bass = np.zeros_like(chords)
    for b in range(bars):
        root = tonic_midi + (0, 5, 7, 0)[b % 4]
        s = int(b * bar * SR)
        for iv in (0, 4, 7):  # major triad
            seg = _tone(root + iv, bar)
            chords[s : s + len(seg)] += 0.25 * seg[: len(chords) - s]
        seg = _tone(root - 12, bar)
        bass[s : s + len(seg)] += 0.4 * seg[: len(bass) - s]
    return chords.astype(np.float32), bass.astype(np.float32)


def _drums(dur_samples: int, seed: int = 0) -> np.ndarray:
    """Kick on 1/3, snare on 2/4, 8th-note hats — no pitched content to speak of."""
    rng = np.random.default_rng(seed)
    y = np.zeros(dur_samples)
    t = np.arange(int(0.2 * SR)) / SR
    kick = np.sin(2 * np.pi * np.cumsum(50 + 100 * np.exp(-t * 30)) / SR) * np.exp(-t * 12)
    snare = (0.6 * rng.standard_normal(len(t)) + 0.5 * np.sin(2 * np.pi * 190 * t)) * np.exp(
        -t * 25
    )
    hat = 0.3 * np.diff(rng.standard_normal(len(t)), prepend=0.0) * np.exp(-t * 80)
    beat = 60.0 / BPM
    for i, at in enumerate(np.arange(0.0, dur_samples / SR - 0.3, beat / 2)):
        s = int(round(at * SR))
        hit = hat if i % 2 else (kick if (i // 2) % 2 == 0 else snare)
        e = min(len(y), s + len(hit))
        y[s:e] += hit[: e - s]
    return (0.8 * y).astype(np.float32)


def _write_stems(tmp_path, tonic_midi: int) -> dict[str, str]:
    chords, bass = _progression(tonic_midi)
    stems = {"drums": _drums(len(chords)), "bass": bass, "keys": chords}
    out = {}
    for name, y in stems.items():
        p = os.path.join(tmp_path, f"{name}.wav")
        sf.write(p, y, SR)
        out[name] = p
    return out


# ------------------------------------------------------------------ the tagger itself


@pytest.mark.parametrize("tonic", [57, 55, 62], ids=["A", "G", "D"])
def test_tagger_names_the_key_of_a_major_I_IV_V_progression(tonic):
    # Several tonics, so a rolled/off-by-one profile index cannot pass by luck on one key.
    chords, bass = _progression(tonic)
    tags = detect_bpm_and_key(chords + bass, SR)
    assert tags["musical_key"] == f"{NOTES[tonic % 12]} major"


# ------------------------------------------------------------------ what the pipeline feeds it


def _no_db_no_loops(monkeypatch, written):
    monkeypatch.setattr(pipeline, "_update_job_tags", lambda _j, tags: written.append(dict(tags)))
    monkeypatch.setattr(pipeline, "extract_loops", lambda *_a, **_k: iter(()))


@pytest.mark.parametrize("requested", [None, ["drums"], ["drums", "bass"]])
def test_pipeline_tags_the_songs_key_not_the_drums(tmp_path, monkeypatch, requested):
    """End to end through extract_and_tag on real audio: A major in, A major written.

    `requested=["drums"]` is the sharpest case: the user asked only for drum loops, so the
    harmony is outside the loop filter — and it must still decide the key.
    """
    written: list[dict] = []
    _no_db_no_loops(monkeypatch, written)
    _, tags, _, _ = pipeline.extract_and_tag(JOB, _write_stems(tmp_path, 57), requested, 4)
    assert tags["musical_key"] == "A major"
    assert tags["bpm"] == BPM, "BPM still comes from the drums beat grid"
    assert written[-1]["musical_key"] == "A major"


def test_pipeline_passes_the_sum_of_all_stems_to_the_tagger(tmp_path, monkeypatch):
    """Pins the INPUT: the array handed to detect_bpm_and_key is every stem summed (the
    reconstructed mix), at the pipeline sample rate, mono — never the beat-reference stem."""
    stems = _write_stems(tmp_path, 57)
    seen: dict = {}

    def spy(y, sr, grid=None):
        seen.update(y=np.asarray(y), sr=sr, grid=grid)
        return {"bpm": 102.0, "musical_key": "A major"}

    monkeypatch.setattr(pipeline, "detect_bpm_and_key", spy)
    _no_db_no_loops(monkeypatch, [])
    pipeline.extract_and_tag(JOB, stems, ["drums"], 4)

    expected = sum(sf.read(p, dtype="float32")[0] for p in stems.values())
    drums = sf.read(stems["drums"], dtype="float32")[0]
    assert seen["sr"] == SR
    assert seen["y"].ndim == 1
    assert seen["grid"] is not None, "the drums grid must still be passed, so BPM is unchanged"
    np.testing.assert_allclose(seen["y"], expected, atol=1e-4)
    assert not np.allclose(seen["y"], drums, atol=1e-3), "the tagger was handed the drums stem"


def test_key_audio_pads_stems_of_unequal_length(tmp_path):
    a, b = os.path.join(tmp_path, "a.wav"), os.path.join(tmp_path, "b.wav")
    sf.write(a, np.full(100, 0.1, dtype=np.float32), SR)
    sf.write(b, np.full(150, 0.2, dtype=np.float32), SR)
    y = pipeline._key_audio({"a": a, "b": b}, SR)
    assert len(y) == 150
    np.testing.assert_allclose(y[:100], 0.3, atol=1e-4)
    np.testing.assert_allclose(y[100:], 0.2, atol=1e-4)
