"""Synthesize drum tracks with exact ground-truth beats/downbeats.

    python synth.py OUT_DIR

Writes OUT_DIR/<name>.wav (44.1 kHz mono) + OUT_DIR/<name>.gt.json
({"beats": [...], "downbeats": [...], "bpm": float, "source": "synthetic"}).
Deterministic (fixed seeds). No audio is committed to the repo — generate on demand.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import soundfile as sf

SR = 44100


def _kick(rng):
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    f = 50 + 100 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 12)


def _snare(rng):
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    return (0.6 * rng.standard_normal(n) + 0.5 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 25)


def _hat(rng):
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    x = np.diff(x, prepend=0.0)  # crude high-pass
    return 0.35 * x * np.exp(-t * 80)


def _click(rng, accent=False):
    n = int(0.02 * SR)
    t = np.arange(n) / SR
    return (
        (1.0 if accent else 0.6)
        * np.sin(2 * np.pi * (1500 if accent else 1000) * t)
        * np.exp(-t * 300)
    )


def _place(y, sample, t):
    s = int(round(t * SR))
    if s < 0 or s >= len(y):
        return
    e = min(len(y), s + len(sample))
    y[s:e] += sample[: e - s]


def _pad(y, beats, rng):
    """Quiet sustained chord per bar so the track isn't drums-only (harmonic context)."""
    roots = [110.0, 87.31, 98.0, 130.81]
    for b in range(0, len(beats) - 4, 4):
        s, e = int(beats[b] * SR), int(beats[b + 4] * SR)
        t = np.arange(e - s) / SR
        f = roots[(b // 4) % 4]
        tone = sum(np.sin(2 * np.pi * f * m * t) for m in (1, 1.26, 1.5)) / 3
        y[s:e] += 0.08 * tone * np.minimum(1, t * 20)


def beat_times(bpm, first, dur, drift_to=None):
    """Beat times from ``first``; optional linear tempo ramp to ``drift_to`` BPM."""
    out, t, i = [], first, 0
    while t < dur - 0.3:
        out.append(t)
        cur = bpm if drift_to is None else bpm + (drift_to - bpm) * (t / dur)
        t += 60.0 / cur
        i += 1
    return np.array(out)


def render(name, bpm, first, dur, pattern, seed=0, drift_to=None, jitter_ms=0.0, swing=0.0):
    rng = np.random.default_rng(seed)
    beats = beat_times(bpm, first, dur, drift_to)
    y = np.zeros(int(dur * SR))
    kick, snare, hat = _kick(rng), _snare(rng), _hat(rng)

    def at(t):
        return t + (rng.normal(0, jitter_ms / 1000) if jitter_ms else 0.0)

    for i, b in enumerate(beats):
        nxt = beats[i + 1] if i + 1 < len(beats) else b + 60.0 / bpm
        ibi = nxt - b
        pos = i % 4
        if pattern == "click":
            _place(y, _click(rng, accent=pos == 0), b)
            continue
        if pattern in ("rock", "swing"):
            if pos in (0, 2):
                _place(y, kick, at(b))
            if pos in (1, 3):
                _place(y, snare, at(b))
            off = (2 / 3) if pattern == "swing" else 0.5
            if pattern == "swing" and swing:
                off = swing
            _place(y, hat, at(b))
            _place(y, 0.7 * hat, at(b + off * ibi))
            if pos == 0:
                _place(y, 0.6 * snare[::-1][: int(0.05 * SR)], at(b))  # crash-ish accent bar 1
        elif pattern == "syncopated":
            if pos == 0 or pos == 2:
                _place(y, kick, at(b))
            if pos == 1:
                _place(y, 0.8 * kick, at(b + 0.5 * ibi))  # kick on the "and" of 2
            if pos in (1, 3):
                _place(y, snare, at(b))
            for k in range(4):
                _place(y, (0.8 if k == 0 else 0.5) * hat, at(b + k * ibi / 4))
        elif pattern == "halftime":
            # Trap feel: beats at bpm, 16th hats, kick on 1 + "a" of 2, snare only on beat 3.
            if pos == 0:
                _place(y, kick, at(b))
            if pos == 1:
                _place(y, 0.8 * kick, at(b + 0.75 * ibi))
            if pos == 2:
                _place(y, snare, at(b))
            for k in range(4):
                _place(y, (0.6 if k == 0 else 0.4) * hat, at(b + k * ibi / 4))
        elif pattern == "dnb":
            if pos == 0:
                _place(y, kick, at(b))
            if pos == 2:
                _place(y, 0.9 * kick, at(b + 0.5 * ibi))
            if pos in (1, 3):
                _place(y, snare, at(b))
            _place(y, hat, at(b))
            _place(y, 0.6 * hat, at(b + 0.5 * ibi))
    if pattern != "click":
        _pad(y, beats, rng)
    y = 0.8 * y / np.max(np.abs(y))
    return y, beats


TRACKS = [
    # name, bpm, first-beat s, duration s, pattern, kwargs
    ("syn_click_101.7", 101.7, 0.237, 150, "click", {}),
    ("syn_rock_102_humanized", 102.0, 0.120, 214, "rock", {"jitter_ms": 6}),
    ("syn_swing_92", 92.0, 0.610, 150, "swing", {"jitter_ms": 4}),
    ("syn_sync16_128", 128.0, 0.050, 150, "syncopated", {"jitter_ms": 3}),
    ("syn_halftime_140", 140.0, 0.400, 120, "halftime", {"jitter_ms": 3}),
    ("syn_dnb_174", 174.0, 0.300, 120, "dnb", {"jitter_ms": 3}),
    ("syn_rock_77", 77.0, 0.900, 180, "rock", {"jitter_ms": 5}),
    ("syn_drift_99_to_101", 99.0, 0.200, 180, "rock", {"jitter_ms": 5, "drift_to": 101.0}),
]


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for i, (name, bpm, first, dur, pattern, kw) in enumerate(TRACKS):
        y, beats = render(name, bpm, first, dur, pattern, seed=i, **kw)
        sf.write(os.path.join(out_dir, f"{name}.wav"), y.astype(np.float32), SR)
        gt = {
            "source": "synthetic",
            "bpm": bpm if "drift_to" not in kw else None,
            "beats": [round(float(b), 6) for b in beats],
            "downbeats": [round(float(b), 6) for b in beats[::4]],
        }
        with open(os.path.join(out_dir, f"{name}.gt.json"), "w") as f:
            json.dump(gt, f)
        print(f"{name}: {len(beats)} beats")


if __name__ == "__main__":
    main(sys.argv[1])
