"""Generate deterministic synthetic WAV fixtures for the Phase 0 spikes.

These let S3/S4/S5 spike code run on a fresh checkout / in CI with no ffmpeg and
no operator audio. They are stand-ins that prove the algorithms RUN and the unit
tests pass — they are NOT a substitute for musical-quality judgement on real
audio, which the operator does at Gate 0.

Run: python apps/worker/spikes/fixtures/make_synthetic_fixtures.py
"""

import json
import os

import numpy as np
import soundfile as sf

SR = 44100
HERE = os.path.dirname(__file__)

# Equal-tempered note frequencies (A4 = 440 Hz).
_NOTE_SEMITONES = {
    "C": -9,
    "C#": -8,
    "D": -7,
    "D#": -6,
    "E": -5,
    "F": -4,
    "F#": -3,
    "G": -2,
    "G#": -1,
    "A": 0,
    "A#": 1,
    "B": 2,
}


def _freq(note: str, octave: int = 4) -> float:
    semis = _NOTE_SEMITONES[note] + 12 * (octave - 4)
    return 440.0 * (2 ** (semis / 12.0))


def _chord(notes, dur_s, amp, octave=4):
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for note in notes:
        sig += np.sin(2 * np.pi * _freq(note, octave) * t)
    sig = sig / max(1, len(notes))
    return (amp * sig).astype(np.float32)


def make_golden_loop() -> str:
    """8s, 120 BPM (4 bars), Hann-enveloped 220 Hz tone.

    The Hann envelope guarantees near-silent endpoints so zero-crossing alignment
    and the micro-crossfade leave the seam click-free (S5 tests assert <0.05).
    """
    dur_s = 8.0
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    env = np.hanning(n)
    y = (0.4 * env * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
    path = os.path.join(HERE, "golden_loop.wav")
    sf.write(path, y, SR)
    return path


def make_labeled_song() -> tuple[str, str]:
    """48s track, six 8s sections with abrupt pitch+energy changes at boundaries."""
    sections = [
        ("intro", ["C", "E", "G"], 0.15),
        ("verse", ["A", "C", "E"], 0.45),
        ("chorus", ["F", "A", "C"], 0.75),
        ("verse2", ["D", "F", "A"], 0.45),
        ("bridge", ["G", "B", "D"], 0.65),
        ("outro", ["C", "E", "G"], 0.20),
    ]
    seg_s = 8.0
    audio = np.concatenate([_chord(notes, seg_s, amp) for _, notes, amp in sections])
    song_path = os.path.join(HERE, "labeled_song.wav")
    sf.write(song_path, audio, SR)

    gt = {
        "sections": [
            {"label": label, "start": i * seg_s} for i, (label, _, _) in enumerate(sections)
        ]
    }
    gt_path = os.path.join(HERE, "labeled_song_ground_truth.json")
    with open(gt_path, "w") as f:
        json.dump(gt, f, indent=2)
    return song_path, gt_path


def make_neosoul_keys() -> str:
    """16s Rhodes-ish progression in A minor: Am7 - Dm7 - G7 - Cmaj7."""
    prog = [
        (["A", "C", "E", "G"], 0.5),  # Am7
        (["D", "F", "A", "C"], 0.5),  # Dm7
        (["G", "B", "D", "F"], 0.5),  # G7
        (["C", "E", "G", "B"], 0.5),  # Cmaj7
    ]
    audio = np.concatenate([_chord(notes, 4.0, amp, octave=4) for notes, amp in prog])
    path = os.path.join(HERE, "neosoul_keys.wav")
    sf.write(path, audio, SR)
    return path


if __name__ == "__main__":
    print("golden_loop.wav        ->", make_golden_loop())
    song, gt = make_labeled_song()
    print("labeled_song.wav       ->", song)
    print("labeled_song_ground... ->", gt)
    print("neosoul_keys.wav       ->", make_neosoul_keys())
    print("intended key (neosoul) : A minor")
