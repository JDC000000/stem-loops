"""Beat grid: precise tempo fit + beat-phase anchor (loop alignment).

Why this exists: `librosa.beat.beat_track` reports tempo as an autocorrelation *lag bin*
(hop 512 @ 44.1 kHz → 101.33, 103.36, … around 100 BPM, ~2 % apart), and the extractor
used to lay a 4/4 grid from t=0. On a steady 102.00 BPM master that put loop starts up to
±0.47 beat off the real beats, and every 4-bar repeat slipped ~62 ms.

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

Bar 1 (QA-15): bars are 4-beat groups counted from the first *musical* beat, not from
the first grid beat after t=0. A silent or non-beat lead-in used to leave bar 0 in the
silence, so loops started before the music or on its beat 4. The first musical beat is
the first grid beat with a real onset on it that the next beats confirm; it is taken as
the downbeat (4/4, no downbeat model — music almost always enters on a 1). When the
caller passes the song's audible start (``music_start``, from the full mix) and the
reference stem enters later (a drumless intro), the grid is extended back by whole bars
to cover the intro.

Tempo drift (QA-15): when librosa's tracked beats wander from the constant-tempo grid by
more than DRIFT_MAX_BEATS, the grid follows the tracked beats (each refined to its local
onset peak) instead of extrapolating one BPM: bar n starts at beat ``4 n`` of that
sequence. A steady track keeps the constant grid exactly.

See apps/worker/evals/beat_alignment/README.md for the evaluation.
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
# A grid beat counts as "played" when the onset peak within ±BEAT_PEAK_WIN_BEATS of it is
# at least this fraction of the track's typical (90th-percentile) beat strength.
FIRST_BEAT_REL = 0.25
BEAT_PEAK_WIN_BEATS = 0.1
# ...and at least this many of it and the next 3 beats are played (one stray onset in a
# lead-in is not the start of the music).
FIRST_BEAT_CONFIRM = 3
# Beats this close to t=0 are unmeasurable (see _first_musical_beat).
ONSET_EDGE_S = 0.05
# Switch to the beat-following grid when the tracked beats (median-smoothed over 5) sit
# more than this far (in beats) from the constant-tempo line. Tracker jitter on a steady
# track is ~10 ms (<0.03 beat), so steady tracks never switch.
DRIFT_MAX_BEATS = 0.15
# Refine each tracked beat to the onset peak within ±this fraction of a beat.
BEAT_REFINE_BEATS = 0.15
# Audible start of the mix: first RMS frame above this fraction of its 95th percentile.
MUSIC_START_REL = 0.05


@dataclass(frozen=True)
class BeatGrid:
    """A beat grid; bar 0 starts at ``anchor`` (the first musical downbeat).

    Constant tempo (``beats is None``): beat k is at ``anchor + k * period``.
    Beat-following (tempo drift): beat k is ``beats[k]``, extrapolated at the edge
    periods outside the sequence; ``beats[0] == anchor``.
    """

    bpm: float
    anchor: float  # bar 0 / first musical downbeat (s); may be < 0 by up to ANCHOR_WRAP_S
    tracked_beats: int  # beats found by librosa's tracker (beatless-audio guard)
    tracker_bpm: float  # librosa's own (lag-binned) tempo, for the guard and logs
    # Onset envelope at HOP, for per-loop local snapping.
    envelope: np.ndarray | None = field(default=None, repr=False, compare=False)
    sr: int = 44100
    beats: tuple[float, ...] | None = field(default=None, repr=False)

    @property
    def period(self) -> float:
        return 60.0 / self.bpm

    @property
    def bar(self) -> float:
        return 4.0 * self.period

    @property
    def follows_beats(self) -> bool:
        return self.beats is not None

    def beat_time(self, k: int) -> float:
        """Time of beat ``k`` (beat 0 = ``anchor``)."""
        if self.beats is None:
            return self.anchor + k * self.period
        b, n = self.beats, len(self.beats)
        if 0 <= k < n:
            return b[k]
        m = min(4, n - 1)
        if k < 0:
            return b[0] + k * (b[m] - b[0]) / m
        return b[-1] + (k - n + 1) * (b[-1] - b[-1 - m]) / m

    def bar_index(self, t: float) -> int:
        """Index of the grid bar nearest to time ``t`` (bar 0 starts at ``anchor``)."""
        if self.beats is None:
            return int(round((t - self.anchor) / self.bar))
        n = int(round((t - self.anchor) / self.bar))  # first guess, then walk to nearest
        while self.bar_start(n + 1) - t < t - self.bar_start(n):
            n += 1
        while n > -10_000 and t - self.bar_start(n - 1) < self.bar_start(n) - t:
            n -= 1
        return n

    def bar_start(self, index: int) -> float:
        if self.beats is None:
            return self.anchor + index * self.bar
        return self.beat_time(4 * index)

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


def estimate_beat_grid(
    y: np.ndarray, sr: int, bpm: float | None = None, music_start: float | None = None
) -> BeatGrid:
    """Fit a beat grid to mono audio ``y``.

    If ``bpm`` is given the tempo is taken as-is and only the phase is fitted.
    ``music_start`` (s): when the song is audible before the reference stem's first beat
    (e.g. the full mix vs the drum stem), bar 0 is moved back by whole bars to cover it.
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
    first = 0.0 if phase is None else phase % period
    if first > period - ANCHOR_WRAP_S:
        first -= period
    duration = len(env) * frame_s

    # Beat-following grid when the tracked beats drift off the constant-tempo line.
    seq = _follow_beats(env, frame_s, beats * 2, period)  # tracker frames are 2*HOP
    if seq is not None:
        grid_beats = seq
    else:
        grid_beats = first + period * np.arange(max(1, int((duration - first) / period) + 1))
    k0 = _first_musical_beat(env, frame_s, grid_beats, period)
    if music_start is not None and k0 > 0:
        # Drumless intro: extend back by whole bars while still inside the music.
        while k0 >= 4 and grid_beats[k0 - 4] >= music_start - period / 2:
            k0 -= 4
    if seq is None:
        return BeatGrid(
            bpm=bpm,
            anchor=float(grid_beats[k0]),
            tracked_beats=len(beats),
            tracker_bpm=tracker_bpm,
            envelope=env,
            sr=sr,
        )
    tail = tuple(float(x) for x in grid_beats[k0:])
    if len(tail) < 8:  # too little left to follow: fall back to the constant grid
        return BeatGrid(bpm, float(grid_beats[k0]), len(beats), tracker_bpm, env, sr)
    return BeatGrid(
        bpm=bpm,
        anchor=tail[0],
        tracked_beats=len(beats),
        tracker_bpm=tracker_bpm,
        envelope=env,
        sr=sr,
        beats=tail,
    )


def detect_music_start(y: np.ndarray, sr: int) -> float:
    """Audible start of ``y`` (s): first RMS frame above MUSIC_START_REL of its loud level."""
    if y.size == 0:
        return 0.0
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    loud = float(np.percentile(rms, 95))
    if loud <= 0:
        return 0.0
    idx = np.flatnonzero(rms >= MUSIC_START_REL * loud)
    return float(idx[0] * HOP / sr) if idx.size else 0.0


def _beat_strengths(env: np.ndarray, frame_s: float, times: np.ndarray, period: float):
    w = max(1, int(round(BEAT_PEAK_WIN_BEATS * period / frame_s)))
    base = np.maximum(env - np.median(env), 0.0)
    out = np.zeros(len(times))
    for i, t in enumerate(times):
        c = int(round(t / frame_s))
        lo, hi = max(0, c - w), min(len(base), c + w + 1)
        if lo < hi:
            out[i] = base[lo:hi].max()
    return out


def _first_musical_beat(env: np.ndarray, frame_s: float, times: np.ndarray, period: float) -> int:
    """Index of the first grid beat that is played and confirmed by the next beats."""
    s = _beat_strengths(env, frame_s, times, period)
    if not np.any(s > 0):
        return 0
    played = s >= FIRST_BEAT_REL * float(np.percentile(s, 90))
    # The onset envelope has no flux in its first frames (nothing before t=0 to differ
    # from), so a beat there can't be measured: let the following beats decide.
    played |= times < ONSET_EDGE_S
    for k in range(len(times)):
        if played[k] and int(played[k : k + 4].sum()) >= min(FIRST_BEAT_CONFIRM, len(times) - k):
            return k
    return 0


def _follow_beats(
    env: np.ndarray, frame_s: float, frames: np.ndarray, period: float
) -> np.ndarray | None:
    """Per-beat times when the tracked beats drift off a constant tempo, else None.

    Tracked beats (``frames`` at HOP) are refined to their local onset peak, put on a
    beat index (skipped beats interpolated, doubles dropped), and compared with their
    least-squares constant-tempo line. Only a drift larger than DRIFT_MAX_BEATS (after
    a 5-beat median, so tracker jitter can't trigger it) returns a sequence; it is
    extended at the local edge period to cover the whole track.
    """
    if len(frames) < 16:
        return None
    w = max(1, int(round(BEAT_REFINE_BEATS * period / frame_s)))
    t = np.empty(len(frames))
    for i, f in enumerate(frames):
        lo, hi = max(0, int(f) - w), min(len(env), int(f) + w + 1)
        j = lo + int(np.argmax(env[lo:hi]))
        off = 0.0
        if 0 < j < len(env) - 1:
            a, b, c = env[j - 1], env[j], env[j + 1]
            d = a - 2 * b + c
            off = 0.5 * (a - c) / d if d < 0 else 0.0
        t[i] = (j + off) * frame_s - ONSET_LATENCY_S
    t = np.sort(t)
    k = np.zeros(len(t), dtype=int)
    for i in range(1, len(t)):
        k[i] = k[i - 1] + int(round((t[i] - t[i - 1]) / period))
    keep = np.concatenate([[True], np.diff(k) > 0])
    t, k = t[keep], k[keep]
    if len(t) < 16:
        return None
    slope, icpt = np.polyfit(k, t, 1)
    resid = t - (icpt + slope * k)
    smooth = np.array([np.median(resid[max(0, i - 2) : i + 3]) for i in range(len(resid))])
    if np.max(np.abs(smooth)) <= DRIFT_MAX_BEATS * period:
        return None
    seq = np.interp(np.arange(k[-1] + 1), k, t)  # fill skipped beats
    duration = len(env) * frame_s
    p0 = (seq[4] - seq[0]) / 4
    p1 = (seq[-1] - seq[-5]) / 4
    head = seq[0] - p0 * np.arange(int(seq[0] / p0 + 1e-9), 0, -1)
    tail = seq[-1] + p1 * np.arange(1, int((duration - seq[-1]) / p1) + 1)
    return np.concatenate([head, seq, tail])


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
