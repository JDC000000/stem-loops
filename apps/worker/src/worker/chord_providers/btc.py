"""BTC chord provider (DR-D1 option A): a self-hosted Bi-directional Transformer for Chord
recognition (Park et al., ISMIR 2019, https://github.com/jayg996/BTC-ISMIR19, code MIT).

Built after Jon's D1a (24B chat, 2026-11-27): "BTC — accepting the non-commercial-weights risk
for the unpaid beta". Selected ONLY by ``CHORDS_PROVIDER=btc``; the default stays ``klangio``
and the prod switch is Jon's.

  * ``BtcChordSource`` implements the ``ChordSource`` contract around a ``model_runner``
    (``wav path -> [(start_sec, end_sec, raw_label[, confidence]), ...]``). The default
    runner is the torch-free NumPy port in ``btc_model.py`` (CQT + 8-layer BTC, CPU).
  * label normalisation from BTC's large vocabulary (170 classes) to the Harte subset the
    pipeline ships (``is_valid_harte_label``);
  * segment cleaning (sorted, non-overlapping, no zero-length, clamped to the duration,
    adjacent equal labels merged);
  * a pinned SHA-256 check of the weights file before a byte of it is parsed.

Weights: ``btc_model_large_voca.pt`` from the BTC repo at commit 2682317, fetched at image
build by ``scripts/fetch_btc_weights.py`` (never committed, never downloaded at runtime).
Missing / mismatched weights raise ``BtcWeightsMissing``, which the pipeline hook turns into
a ``provider_failed`` tombstone.

BTC is free and self-hosted: no billing, so it never calls the per-job ``ledger`` (no DB
read or write) and has no quota. Licence caveat (DR-D1): the code is MIT but the weights are
trained on chord annotations some publishers call non-commercial; Jon accepted that risk
for the unpaid beta only (D1a). Re-decide before any paid tier uses BTC output.

This module never imports torch (the port does not need it) and the factory imports it
lazily, so a worker on ``klangio`` never loads it.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import time
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path

from ..chord_source import (
    ChordJobLedger,
    ChordResult,
    ChordSegment,
    StemKind,
    is_valid_harte_label,
)

# --------------------------------------------------------------------------- weights
# sha256 of ``test/btc_model_large_voca.pt`` at BTC-ISMIR19 commit 2682317 (12,229,576 bytes).
# Keep in sync with ``scripts/fetch_btc_weights.py`` (test_chord_btc checks they agree).
BTC_WEIGHTS_SHA256 = "1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51"
BTC_WEIGHTS_FILENAME = "btc_model_large_voca.pt"
# Feature/decode mode (BTC_CQT_MODE): "song" (default) = one contiguous CQT timed by hop / sr;
# "chunked" = upstream test.py's 10 s chunks timed by 10 s / 108 (kept as a rollback knob).
# Unknown values fall back to the default. See btc_model.cqt_features.
BTC_CQT_MODE_DEFAULT = "song"
_VERSION_SUFFIX = {"song": "song", "chunked": "chunk10"}


def cqt_mode() -> str:
    raw = os.environ.get("BTC_CQT_MODE", "").strip().lower()
    return raw if raw in _VERSION_SUFFIX else BTC_CQT_MODE_DEFAULT


def provider_version(mode: str | None = None) -> str:
    """provider_version on the wire (chord_edits.provider_version is capped at 64 chars):
    the pinned weights plus the decode mode, so rows made by either mode stay tellable apart."""
    return f"btc-large-voca@{BTC_WEIGHTS_SHA256[:12]}+{_VERSION_SUFFIX[mode or cqt_mode()]}"


BTC_PROVIDER_VERSION = provider_version(BTC_CQT_MODE_DEFAULT)
BTC_WEIGHTS_DEFAULT_PATH = Path("/app/models/btc") / BTC_WEIGHTS_FILENAME
_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

ModelRunner = Callable[[Path], Iterable[tuple]]


class BtcWeightsMissing(RuntimeError):
    """BTC was selected but the vendored weights are absent, unpinned or do not match the
    pinned SHA-256. Never downloaded at runtime: fix the image, or set CHORDS_PROVIDER back."""


def weights_path() -> Path:
    raw = os.environ.get("BTC_WEIGHTS_PATH", "").strip()
    return Path(raw) if raw else BTC_WEIGHTS_DEFAULT_PATH


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def verify_weights(path: Path, expected_sha256: str | None = None) -> str:
    """Return the file's sha256 if it matches ``expected_sha256`` (default: the pinned
    ``BTC_WEIGHTS_SHA256``, read at call time); else raise BtcWeightsMissing."""
    if expected_sha256 is None:
        expected_sha256 = BTC_WEIGHTS_SHA256
    expected = (expected_sha256 or "").strip().lower()
    if not _SHA256_HEX.match(expected):
        raise BtcWeightsMissing(
            "BTC weights checksum is not pinned (BTC_WEIGHTS_SHA256 is empty/invalid); "
            "pin the weights' sha256 before selecting CHORDS_PROVIDER=btc."
        )
    if not path.is_file():
        raise BtcWeightsMissing(
            f"BTC weights file not found at {path}; it is fetched at image build "
            "(scripts/fetch_btc_weights.py), never at runtime. Set CHORDS_PROVIDER back to "
            "klangio or rebuild the image."
        )
    actual = sha256_file(path)
    if actual != expected:
        raise BtcWeightsMissing(
            f"BTC weights checksum mismatch at {path}: got {actual[:12]}..., "
            f"expected {expected[:12]}..."
        )
    return actual


_RUNNER_CACHE: dict[tuple[str, str, str], ModelRunner] = {}


def _default_runner() -> ModelRunner:
    """The real runner: verify the pinned weights, load them once per process (~12 MB of
    float32), and return ``wav path -> [(start, end, label, confidence)]``. Pure NumPy +
    librosa on CPU; ``btc_model`` documents the port."""
    path = weights_path()
    sha = verify_weights(path)
    mode = cqt_mode()
    frame_sec_name = "HOP_SEC" if mode == "song" else "FRAME_SEC"
    cache_key = (str(path), sha, mode)
    runner = _RUNNER_CACHE.get(cache_key)
    if runner is not None:
        return runner
    from . import btc_model  # noqa: PLC0415 — only when BTC is selected

    ckpt = btc_model.load_checkpoint(path)
    model = btc_model.BtcModel(ckpt["model"])
    vocab = btc_vocabulary()
    mean, std = ckpt["mean"], ckpt["std"]

    def run(audio_path: Path) -> list[tuple[float, float, str, float]]:
        feature = btc_model.cqt_features(btc_model.load_audio(audio_path), mode=mode)
        ids, probs = btc_model.predict_frames(model, feature, mean, std)
        # The clock MUST match the features (a mismatch drifts 0.31%).
        frame_sec = getattr(btc_model, frame_sec_name)
        return btc_model.frames_to_rows(ids, probs, vocab, frame_sec=frame_sec)

    _RUNNER_CACHE.clear()  # one model per process
    _RUNNER_CACHE[cache_key] = run
    return run


# --------------------------------------------------------------------------- labels
BTC_ROOTS = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
BTC_QUALITIES = (
    "min",
    "maj",
    "dim",
    "aug",
    "min6",
    "maj6",
    "min7",
    "minmaj7",
    "maj7",
    "7",
    "dim7",
    "hdim7",
    "sus2",
    "sus4",
)


def btc_vocabulary() -> list[str]:
    """BTC's large-vocabulary output classes in index order (170): root*14 + quality, a bare
    root for ``maj`` (as BTC's ``idx2voca_chord``), then ``X`` (168) and ``N`` (169)."""
    out = []
    for i in range(len(BTC_ROOTS) * len(BTC_QUALITIES)):
        root, quality = BTC_ROOTS[i // len(BTC_QUALITIES)], BTC_QUALITIES[i % len(BTC_QUALITIES)]
        out.append(root if quality == "maj" else f"{root}:{quality}")
    return [*out, "X", "N"]


_ROOT_RE = re.compile(r"^([A-Ga-g])([#b]?)$")
# Spellings other tools use for the same quality; anything else outside the Harte set -> X.
_QUALITY_ALIASES = {"": "maj", "major": "maj", "minor": "min", "m": "min", "dom7": "7"}


def normalize_btc_label(raw: object) -> str:
    """Map one BTC/raw chord label to the Harte subset. Unknown quality or unparseable root
    -> ``X`` (unrecognised), never a crash and never an invalid label on the wire."""
    if not isinstance(raw, str):
        return "X"
    label = raw.strip()
    if label in ("N", "X"):
        return label
    if not label:
        return "N"
    head, _, bass = label.partition("/")
    root_part, sep, quality = head.partition(":")
    m = _ROOT_RE.match(root_part.strip())
    if not m:
        return "X"
    root = m.group(1).upper() + m.group(2)
    quality = quality.strip()
    quality = _QUALITY_ALIASES.get(quality, quality) if sep or quality else "maj"
    out = f"{root}:{quality}" + (f"/{bass.strip()}" if bass else "")
    return out if is_valid_harte_label(out) else "X"


# --------------------------------------------------------------------------- segments
def _confidence(item: Sequence) -> float:
    """Optional 4th element: the runner's mean frame probability. Missing / bad -> 1.0 (the
    contract's "no provider signal"); otherwise clamped to [0, 1]."""
    if len(item) < 4:
        return 1.0
    try:
        c = float(item[3])
    except (TypeError, ValueError):
        return 1.0
    return min(1.0, max(0.0, c)) if math.isfinite(c) else 1.0


def clean_segments(raw: Iterable[Sequence], duration_sec: float | None) -> list[ChordSegment]:
    """Sorted, non-overlapping, positive-length segments inside [0, duration]; adjacent
    segments with the same label are merged (confidence = duration-weighted mean).
    Non-finite times are dropped."""
    rows: list[tuple[float, float, str, float]] = []
    for item in raw:
        try:
            start, end, label = float(item[0]), float(item[1]), item[2]
        except (TypeError, ValueError, IndexError):
            continue
        if not (math.isfinite(start) and math.isfinite(end)):
            continue
        start = max(0.0, start)
        if duration_sec and duration_sec > 0:
            end = min(end, duration_sec)
        if end <= start:
            continue
        rows.append((start, end, normalize_btc_label(label), _confidence(item)))
    rows.sort(key=lambda r: (r[0], r[1]))

    out: list[list] = []
    for start, end, label, conf in rows:
        if out:
            prev = out[-1]
            start = max(start, prev[1])  # trim overlap onto the previous segment's end
            if end <= start:
                continue
            if label == prev[2] and start - prev[1] <= 1e-6:
                w_prev, w_new = prev[1] - prev[0], end - start
                prev[3] = (prev[3] * w_prev + conf * w_new) / (w_prev + w_new)
                prev[1] = end
                continue
        out.append([start, end, label, conf])
    return [
        ChordSegment(start_sec=round(s, 3), end_sec=round(e, 3), label=lab, confidence=round(c, 4))
        for s, e, lab, c in out
        if round(e, 3) > round(s, 3)
    ]


def _probe_duration(audio_path: Path) -> float | None:
    try:
        import soundfile as sf  # noqa: PLC0415 — native dep, keep lazy

        return float(sf.info(str(audio_path)).duration)
    except Exception:  # noqa: BLE001 — fall back to the last segment end
        return None


# --------------------------------------------------------------------------- provider
class BtcChordSource:
    """``ChordSource`` for the self-hosted BTC model. Free: never touches the ledger, no quota,
    no network."""

    def __init__(
        self,
        model_runner: ModelRunner | None = None,
        *,
        provider_version: str | None = None,
        duration_probe: Callable[[Path], float | None] = _probe_duration,
    ) -> None:
        self._runner = model_runner
        self._provider_version = provider_version
        self._duration_probe = duration_probe

    def recognize(
        self,
        audio_path: Path,
        *,
        stem: StemKind = "mix",
        ledger: ChordJobLedger | None = None,  # noqa: ARG002 — free provider, nothing to bill
    ) -> ChordResult:
        audio_path = Path(audio_path)
        if not audio_path.is_file():
            raise FileNotFoundError(f"BTC input audio not found: {audio_path}")
        runner = self._runner if self._runner is not None else _default_runner()
        version = self._provider_version or provider_version()
        t0 = time.monotonic()
        raw: Sequence[Sequence] = list(runner(audio_path))
        model_ms = int((time.monotonic() - t0) * 1000)
        duration = self._duration_probe(audio_path)
        segments = clean_segments(raw, duration)
        if not duration:
            duration = segments[-1].end_sec if segments else 0.0
        return ChordResult(
            segments=segments,
            key=None,
            provider="btc",
            provider_version=version,
            duration_sec=round(float(duration), 3),
            model_ms=model_ms,
        )
