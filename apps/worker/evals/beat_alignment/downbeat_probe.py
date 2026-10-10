"""Can we tell which beat is bar 1? A probe — NOT used by the worker.

    python downbeat_probe.py --worker-src PATH/TO/apps/worker/src --data DATA_DIR

For each track: fit the worker's beat grid, then score the 4 possible bar phases with
two classic cues — low-band (kick) onset strength on the beat, and harmonic (chroma)
change across the beat — and pick the best. Graded against the modal bar phase of the
reference downbeats (synthetic truth, or Beat This! on real tracks). Prints the
reference's own consistency too: if the reference disagrees with itself, so be it.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import librosa
import numpy as np


def bar_phase_scores(y: np.ndarray, sr: int, anchor: float, period: float) -> np.ndarray:
    hop = 512
    S = np.abs(librosa.stft(y, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr)
    low = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S[freqs < 150]), sr=sr)
    chroma = librosa.feature.chroma_stft(S=S**2, sr=sr, hop_length=hop)
    n_beats = int((len(y) / sr - anchor) / period)
    beat_t = anchor + period * np.arange(n_beats)
    fr = np.clip(librosa.time_to_frames(beat_t, sr=sr, hop_length=hop), 0, len(low) - 1)
    kick = np.array([low[max(0, f - 2) : f + 3].max() for f in fr])
    # chroma of each beat span, change entering beat i
    spans = np.concatenate([fr, [chroma.shape[1] - 1]])
    beat_chroma = np.stack(
        [chroma[:, spans[i] : max(spans[i] + 1, spans[i + 1])].mean(axis=1) for i in range(len(fr))]
    )
    change = np.r_[0, np.linalg.norm(np.diff(beat_chroma, axis=0), axis=1)]
    z = lambda v: (v - v.mean()) / (v.std() + 1e-9)  # noqa: E731
    cue = z(kick) + z(change)
    return np.array([cue[p::4].mean() for p in range(4)])


def modal_phase(downbeats: np.ndarray, anchor: float, period: float) -> tuple[int, float]:
    idx = np.round((downbeats - anchor) / period).astype(int) % 4
    counts = np.bincount(idx, minlength=4)
    return int(np.argmax(counts)), float(counts.max() / max(1, counts.sum()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker-src", required=True)
    ap.add_argument("--data", required=True)
    args = ap.parse_args()
    sys.path.insert(0, os.path.abspath(args.worker_src))
    from worker.extractor.beat_grid import estimate_beat_grid

    sr = 44100
    hits = total = 0
    for gt_path in sorted(glob.glob(os.path.join(args.data, "synth", "*.gt.json"))) + sorted(
        glob.glob(os.path.join(args.data, "audio", "*.beatthis.json"))
    ):
        base = gt_path.rsplit(".", 2)[0]
        audio = next(p for p in (base + ".wav", base + ".mp3") if os.path.exists(p))
        y, _ = librosa.load(audio, sr=sr, mono=True)
        grid = estimate_beat_grid(y, sr)
        with open(gt_path) as f:
            ref = np.array(json.load(f)["downbeats"])
        ref_bar = float(np.median(np.diff(ref))) if len(ref) > 1 else 0.0
        if not 0.9 < ref_bar / (4 * grid.period) < 1.1:
            print(
                f"{os.path.basename(base):26s} bpm={grid.bpm:7.2f} N/A (grid bar ≠ reference bar)"
            )
            continue
        want, consistency = modal_phase(ref, grid.anchor, grid.period)
        got = int(np.argmax(bar_phase_scores(y, sr, grid.anchor, grid.period)))
        ok = got == want
        hits += ok
        total += 1
        print(
            f"{os.path.basename(base):26s} bpm={grid.bpm:7.2f} ref-phase={want} "
            f"(ref self-consistency {consistency:.0%}) probe={got} {'OK' if ok else 'MISS'}"
        )
    print(f"\nprobe agrees with reference bar phase on {hits}/{total} tracks")


if __name__ == "__main__":
    main()
