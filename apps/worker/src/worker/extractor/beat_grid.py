"""Beat grid: precise tempo fit + beat-phase anchor (loop alignment).

Why this exists: `librosa.beat.beat_track` reports tempo as an autocorrelation *lag bin*
(hop 512 @ 44.1 kHz → 101.33, 103.36, … around 100 BPM, ~2 % apart), and the extractor
used to lay a 4/4 grid from t=0. On a steady 102.00 BPM master that put loop starts up to
±0.47 beat off the real beats, and every 4-bar repeat slipped ~62 ms
(documents/stem-loops-landing/demo-assets/LOOP-ALIGNMENT.md).

Method (no new dependency; numpy + the librosa already in the image):
  1. Onset-strength envelope at hop 256 (5.8 ms frames) from one mel spectrogram; its
     even frames are exactly the hop-512 envelope the old beat_track path used.
  2. Coarse tempo = librosa's beat_track tempo on the hop-512 envelope — bit-identical
     to the old BPM, so the metrical level (half/double-time choice) is unchanged.
  3. Fine tempo = argmax over a ±3 % window of the summed magnitude of the envelope's
     Fourier coefficients at the beat rate and its first 3 harmonics (8ths/triplets/16ths).
     For a steady pulse this peaks at the exact rate; resolution is not bin-limited.
  4. Phase = peak of the envelope folded at the fitted beat period (the beat-synchronous
     onset profile), parabolically interpolated. Folding — not the Fourier phase — so
     syncopated hits can't drag the phase off the dominant on-beat pulse.
  5. Per-loop: the same fold restricted to the loop's own window snaps each loop start
     to the locally detected beat (tracks mild drift; bounded to ±0.1 beat).

Bar 1 / downbeat is NOT detected: the grid's "bars" are 4-beat groups counted from the
first beat. See apps/worker/evals/beat_alignment/README.md for the evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import librosa
import numpy as np

HOP = 256
# Fine search window around the tracker's lag-binned tempo. Hop-512 lag bins are ~2 %
# apart near 100 BPM and ~4.8 % at 250 BPM (the guard's ceiling), so ±3 % covers at
# least half a bin everywhere — and a full bin below ~140 BPM — without letting a
# pulse-less track wander to an unrelated rate.
FINE_SEARCH_FRAC = 0.03
COARSE_STEP_BPM = 0.05  # coarse pass: harmonics 1-2 only
FINE_STEP_BPM = 0.005  # fine pass: ±1 coarse step, harmonics 1-4
HARMONICS = (1, 2, 3, 4)
# Report a whole-number tempo when the fit is this close to one. Productions are almost
# always made at an integer DAW tempo, and a 0.05-BPM rounding error is <5 ms over 4 bars
# at 100 BPM — well under the alignment target — while "102bpm" is what the producer set.
INTEGER_SNAP_BPM = 0.05
# Max distance a loop start may move to the locally detected beat (fraction of a beat).
# 0.1 beat: absorbs mild drift; ±0.25 also let a sparse trap intro pull one start
# 175 ms onto a wrong peak (evals/beat_alignment).
LOCAL_SNAP_MAX_BEATS = 0.1
# The local beat profile is folded over at least this many beats (1-bar loops are too
# short on their own for a stable phase).
LOCAL_WINDOW_MIN_BEATS = 16
# A first beat estimated just before t=0 stays there (start clamps to 0) instead of
# wrapping a whole beat later.
ANCHOR_WRAP_S = 0.015
# Bias of the onset-envelope peak vs the true onset, measured on synthetic ground truth
# (evals/beat_alignment: +7.4..+10.0 ms late across 7 patterns at 77-174 BPM).
# Subtracted from every detected beat phase; a late start would clip the transient.
ONSET_LATENCY_S = 0.009


@dataclass(frozen=True)
class BeatGrid:
    """A constant-tempo beat grid: beat k is at ``anchor + k * period``."""

    bpm: float
    anchor: float  # first grid beat (s); within (-ANCHOR_WRAP_S, period - ANCHOR_WRAP_S]
    tracked_beats: int  # beats found by librosa's tracker (beatless-audio guard)
    tracker_bpm: float  # librosa's own (lag-binned) tempo, for the guard and logs
    # Onset envelope at HOP, for per-loop local snapping.
    envelope: np.ndarray | None = field(default=None, repr=False, compare=False)
    sr: int = 44100

    @property
    def period(self) -> float:
        return 60.0 / self.bpm

    @property
    def bar(self) -> float:
        return 4.0 * self.period

    def bar_index(self, t: float) -> int:
        """Index of the grid bar nearest to time ``t`` (bar 0 starts at ``anchor``)."""
        return int(round((t - self.anchor) / self.bar))

    def bar_start(self, index: int) -> float:
        return self.anchor + index * self.bar

    def snap_to_bar(self, t: float) -> float:
        return self.bar_start(self.bar_index(t))

    def local_beat(self, t: float, window: float) -> float:
        """Snap ``t`` to the beat detected inside ``[t, t + window]``.

        Folds the onset envelope of that window at the grid period and moves ``t`` to the
        nearest peak of the local beat profile, by at most LOCAL_SNAP_MAX_BEATS of a beat.
        Falls back to ``t`` when there is no envelope or the window has no clear pulse.
        """
        if self.envelope is None:
            return t
        frame_s = HOP / self.sr
        window = max(window, LOCAL_WINDOW_MIN_BEATS * self.period)
        lo = max(0, int(t / frame_s))
        hi = min(len(self.envelope), int((t + window) / frame_s) + 1)
        if hi - lo < int(4 * self.period / frame_s):
            return t
        phase = _fold_peak_phase(self.envelope[lo:hi], lo * frame_s, self.period, frame_s)
        if phase is None:
            return t
        # Nearest beat of the local grid to t (signed distance wrapped to ±period/2).
        delta = (phase - t + self.period / 2) % self.period - self.period / 2
        if abs(delta) > LOCAL_SNAP_MAX_BEATS * self.period:
            return t
        return t + delta


def onset_envelopes(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """(envelope at HOP, envelope at 2*HOP) from one mel spectrogram.

    Every other HOP frame is exactly the hop-512 spectrogram that ``beat_track(y=...)``
    computes; with its median aggregation the 2*HOP envelope reproduces the old tracker
    (tempo, metrical level, beat count) exactly.
    """
    S = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=sr, hop_length=HOP))
    env = librosa.onset.onset_strength(S=S, sr=sr, hop_length=HOP)
    env_track = librosa.onset.onset_strength(
        S=S[:, ::2], sr=sr, hop_length=2 * HOP, aggregate=np.median
    )
    return env, env_track


def estimate_beat_grid(y: np.ndarray, sr: int, bpm: float | None = None) -> BeatGrid:
    """Fit a beat grid to mono audio ``y``.

    If ``bpm`` is given the tempo is taken as-is and only the phase is fitted.
    Deterministic: no randomness, fixed search grids.
    """
    env, env_track = onset_envelopes(y, sr)
    # librosa's tracker (the old BPM source) picks the metrical level — half/double-time
    # behaviour is unchanged — and its beat count is the beatless-audio guard.
    tracker_tempo, beats = librosa.beat.beat_track(
        onset_envelope=env_track, sr=sr, hop_length=2 * HOP
    )
    tracker_bpm = float(np.atleast_1d(tracker_tempo)[0])

    if bpm is None:
        bpm = tracker_bpm
        if tracker_bpm > 0:
            bpm = fit_tempo(env_track, 2 * HOP / sr, tracker_bpm)
            if abs(bpm - round(bpm)) <= INTEGER_SNAP_BPM:
                bpm = float(round(bpm))
        bpm = round(bpm, 2)
    if bpm <= 0:
        return BeatGrid(bpm, 0.0, len(beats), tracker_bpm, env, sr)

    frame_s = HOP / sr
    period = 60.0 / bpm
    phase = _fold_peak_phase(env, 0.0, period, frame_s)
    anchor = 0.0 if phase is None else phase % period
    if anchor > period - ANCHOR_WRAP_S:
        anchor -= period
    return BeatGrid(
        bpm=bpm,
        anchor=anchor,
        tracked_beats=len(beats),
        tracker_bpm=tracker_bpm,
        envelope=env,
        sr=sr,
    )


def fit_tempo(env: np.ndarray, frame_s: float, coarse_bpm: float) -> float:
    """Refine ``coarse_bpm`` to the rate that maximises harmonic beat-rate energy.

    Returns ``coarse_bpm`` unchanged if the best fit sits on the edge of the search
    window (no real peak inside it — don't trade a binned tempo for a wrong one).
    """
    x = env - env.mean()
    t = np.arange(len(x)) * frame_s
    lo, hi = coarse_bpm * (1 - FINE_SEARCH_FRAC), coarse_bpm * (1 + FINE_SEARCH_FRAC)
    cands = np.arange(lo, hi + COARSE_STEP_BPM / 2, COARSE_STEP_BPM)
    coarse_scores = _harmonic_score(x, t, cands, HARMONICS[:2])
    k = int(np.argmax(coarse_scores))
    if k in (0, len(cands) - 1):
        return coarse_bpm
    cands = np.arange(cands[k] - COARSE_STEP_BPM, cands[k] + COARSE_STEP_BPM, FINE_STEP_BPM)
    scores = _harmonic_score(x, t, cands, HARMONICS)
    i = int(np.argmax(scores))
    if 0 < i < len(scores) - 1:  # parabolic interpolation of the peak
        a, b, c = scores[i - 1], scores[i], scores[i + 1]
        denom = a - 2 * b + c
        if denom < 0:
            return float(cands[i] + 0.5 * (a - c) / denom * FINE_STEP_BPM)
    return float(cands[i])


def _harmonic_score(
    x: np.ndarray, t: np.ndarray, bpms: np.ndarray, harmonics: tuple[int, ...], chunk: int = 16
) -> np.ndarray:
    """Sum over harmonics of |Fourier coefficient| of ``x`` at each candidate beat rate."""
    out = np.empty(len(bpms))
    for s in range(0, len(bpms), chunk):
        f = bpms[s : s + chunk] / 60.0
        acc = np.zeros(len(f))
        for h in harmonics:
            ph = np.exp(-2j * np.pi * np.outer(h * f, t))
            acc += np.abs(ph @ x)
        out[s : s + chunk] = acc
    return out


def _fold(env: np.ndarray, t0: float, period: float, frame_s: float) -> np.ndarray:
    """Beat-synchronous onset profile: env summed into phase bins of width ~frame_s."""
    nbins = max(8, int(round(period / frame_s)))
    t = t0 + np.arange(len(env)) * frame_s
    idx = np.floor((t % period) / period * nbins).astype(int) % nbins
    w = np.maximum(env - np.median(env), 0.0)
    prof = np.bincount(idx, weights=w, minlength=nbins)
    # Circular smoothing (~1 bin σ) so a single noisy frame can't win.
    k = np.array([0.25, 0.5, 1.0, 0.5, 0.25])
    return np.convolve(np.concatenate([prof[-2:], prof, prof[:2]]), k / k.sum(), mode="valid")


def _fold_peak_phase(env: np.ndarray, t0: float, period: float, frame_s: float) -> float | None:
    prof = _fold(env, t0, period, frame_s)
    if not np.any(prof > 0):
        return None
    n = len(prof)
    i = int(np.argmax(prof))
    a, b, c = prof[(i - 1) % n], prof[i], prof[(i + 1) % n]
    denom = a - 2 * b + c
    off = 0.5 * (a - c) / denom if denom < 0 else 0.0
    # Bin i covers [i, i+1) * period/n; the onset sits at the bin centre.
    phase = ((i + 0.5 + off) / n) * period - ONSET_LATENCY_S
    return phase % period
