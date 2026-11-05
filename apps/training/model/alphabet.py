"""Chord-label alphabet for ChordNet Y1 (PR-Y1.4).

## Alphabet size: 60 chord labels + 2 boundary labels = 62 output classes

- **60 chord labels** = 12 roots × 5 qualities. These are the "real chords"
  the model is asked to recognise.

  - Roots (12): ``C C# D D# E F F# G G# A A# B`` (sharp-only enharmonics; the
    Harte encoder/decoder normalises flats on input, so ``Db`` and ``C#``
    map to the same index).
  - Qualities (5): ``maj min dim aug sus`` (sus is the collapsed 2/4 class;
    see §"170 → 60 collapse" below).

- **+2 boundary labels**: ``N`` (no-chord / silence) and ``X`` (chord
  present but outside the reduced vocabulary — e.g. a quartal voicing that
  does not reduce to a triad).

The 60-vs-62 distinction matters for two reasons:

1. When documents ("the 60-label alphabet") refer to the vocabulary, they
   mean the 60 harmonic labels. Both N and X are included in training loss
   and in ``mir_eval`` scoring — ``mir_eval`` has native support for ``N``
   and treats ``X`` as an un-scored boundary (``mir_eval.chord.weighted_accuracy``
   drops X-labelled frames from the denominator).
2. Model output layers carry **62** classes when ``output_mode == "flat170"``
   is collapsed, or 13-root × 5-triad = 65 slots in ``output_mode ==
   "structured"`` (see ``chordnet_2e1d.py``). Either way, the 60-label figure
   is the harmonic-vocabulary count.

## 170 → 60 collapse

The de-facto ISMIR 170-class alphabet is 12 roots × 14 qualities + N + X.
Many public corpora (Billboard, RWC, Isophonics) ship with 170-class Harte
annotations. For Y1 we collapse to 60 chord labels + N + X by folding:

| 170 qualities (per root)             | Collapsed quality |
|--------------------------------------|-------------------|
| ``maj maj6 maj7 7``                  | ``maj``           |
| ``min min6 min7 minmaj7``            | ``min``           |
| ``dim dim7 hdim7``                   | ``dim``           |
| ``aug``                              | ``aug``           |
| ``sus2 sus4``                        | ``sus``           |

Every 170-class quality maps to exactly one 60-class bucket — the collapse is
total, no orphans. ``collapse_170_to_60`` implements this map; the alphabet
test suite verifies completeness.

## ALPHABET_SHA

``ALPHABET_SHA`` is the sha256 of the frozen label list. Any change to roots,
qualities, N, X — or their ordering — breaks the hash and forces a retrain
(the training-run manifest records ``ALPHABET_SHA`` so an inference-time
mismatch fails loud instead of silently mis-decoding).
"""

from __future__ import annotations

import hashlib
import json

# ---------------------------------------------------------------------------
# Roots & qualities (frozen tuples — ordering is load-bearing for indices)
# ---------------------------------------------------------------------------

ROOTS: tuple[str, ...] = (
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
)
"""Chromatic roots. Index = pitch-class (C=0, B=11)."""

QUALITIES: tuple[str, ...] = ("maj", "min", "dim", "aug", "sus")
"""Collapsed 5-quality alphabet. Ordering is load-bearing (encoded in SHA)."""

N_LABEL: str = "N"
"""No-chord / silence boundary label."""

X_LABEL: str = "X"
"""Chord-present-but-out-of-vocab label (``mir_eval`` drops these from the WCSR denominator)."""

# ---------------------------------------------------------------------------
# Derived constants: label list + indices
# ---------------------------------------------------------------------------


def _build_labels() -> list[str]:
    """Build the 62-label list: 60 harmonic + N + X."""
    labels: list[str] = []
    for root in ROOTS:
        for quality in QUALITIES:
            labels.append(f"{root}:{quality}")
    labels.append(N_LABEL)
    labels.append(X_LABEL)
    return labels


LABELS: tuple[str, ...] = tuple(_build_labels())
"""All 62 output labels in canonical order. Labels 0..59 are chord labels,
60 = N, 61 = X."""

NUM_CHORD_LABELS: int = 60
"""Harmonic-vocabulary size (the "60-label alphabet" referenced in docs)."""

NUM_LABELS: int = 62
"""Total output classes including N and X."""

N_INDEX: int = NUM_CHORD_LABELS  # 60
X_INDEX: int = NUM_CHORD_LABELS + 1  # 61

# ---------------------------------------------------------------------------
# Harte-input normalisation
# ---------------------------------------------------------------------------

# Flat → sharp enharmonic map (lossy; Y1 does not retain enharmonic spelling).
_FLAT_TO_SHARP: dict[str, str] = {
    "Db": "C#",
    "Eb": "D#",
    "Fb": "E",
    "Gb": "F#",
    "Ab": "G#",
    "Bb": "A#",
    "Cb": "B",
    "E#": "F",
    "B#": "C",
}

# Map Harte-syntax qualities (170-class) → our 5-quality collapse. Every
# canonical 5-quality decoded string (``maj``, ``min``, ``dim``, ``aug``,
# ``sus``) must be a key here so ``encode_label(decode_label(i)) == i`` round-
# trips for all 60 chord labels.
_HARTE_QUALITY_TO_COLLAPSED: dict[str, str] = {
    # maj family
    "maj": "maj",
    "maj6": "maj",
    "maj7": "maj",
    "7": "maj",
    "": "maj",  # empty quality (bare root) = major by Harte convention
    # min family
    "min": "min",
    "min6": "min",
    "min7": "min",
    "minmaj7": "min",
    # dim family
    "dim": "dim",
    "dim7": "dim",
    "hdim7": "dim",
    # aug
    "aug": "aug",
    # sus
    "sus": "sus",  # canonical decoded form
    "sus2": "sus",
    "sus4": "sus",
}


def _normalise_root(root: str) -> str:
    """Return the sharp-spelled root (``Db`` → ``C#``, ``A#`` → ``A#``)."""
    return _FLAT_TO_SHARP.get(root, root)


# ---------------------------------------------------------------------------
# Public encode / decode API
# ---------------------------------------------------------------------------


def encode_label(harte: str) -> int:
    """Encode a Harte-syntax chord string to its integer label.

    Accepts the full Harte 170-class spellings; applies the 170→60 collapse
    on the quality. ``N`` and ``X`` pass through unchanged.

    Args:
        harte: Harte chord string (e.g. ``"C:maj"``, ``"G:min7"``, ``"Bb:7"``,
            ``"N"``, ``"X"``). A bare root (``"C"``) is treated as ``"C:maj"``.

    Returns:
        Integer label in ``[0, 61]``.

    Raises:
        ValueError: If the root or quality cannot be parsed.
    """
    if harte == N_LABEL:
        return N_INDEX
    if harte == X_LABEL:
        return X_INDEX

    # Strip bass-interval (we ignore inversions at the 60-label layer):
    # "C:maj/3" → "C:maj".
    if "/" in harte:
        harte = harte.split("/", 1)[0]

    # Strip optional extension list (e.g. "C:maj(9)" or "C:(1,3,5)") —
    # default to maj when no explicit quality remains.
    if "(" in harte:
        harte = harte.split("(", 1)[0]

    if ":" in harte:
        root_str, quality_str = harte.split(":", 1)
    else:
        root_str, quality_str = harte, ""

    root_str = _normalise_root(root_str)
    if root_str not in ROOTS:
        raise ValueError(f"Unknown root '{root_str}' in Harte label '{harte}'")

    collapsed = _HARTE_QUALITY_TO_COLLAPSED.get(quality_str)
    if collapsed is None:
        raise ValueError(f"Unknown Harte quality '{quality_str}' in label '{harte}'")

    root_idx = ROOTS.index(root_str)
    quality_idx = QUALITIES.index(collapsed)
    return root_idx * len(QUALITIES) + quality_idx


def decode_label(idx: int) -> str:
    """Decode an integer label to its canonical string (``"C:maj"``, ``"N"``, ``"X"``)."""
    if not 0 <= idx < NUM_LABELS:
        raise ValueError(f"Label index {idx} out of range [0, {NUM_LABELS})")
    return LABELS[idx]


# ---------------------------------------------------------------------------
# 170-class → 60-class collapse
# ---------------------------------------------------------------------------

# Canonical 170-class alphabet (12 roots × 14 qualities + N + X).
_ISMIR_170_QUALITIES: tuple[str, ...] = (
    "maj",
    "min",
    "dim",
    "aug",
    "maj7",
    "min7",
    "7",
    "dim7",
    "hdim7",
    "minmaj7",
    "maj6",
    "min6",
    "sus2",
    "sus4",
)
assert len(_ISMIR_170_QUALITIES) == 14  # noqa: S101 — structural invariant


def collapse_170_to_60(idx: int) -> int:
    """Collapse a 170-class alphabet index to our 62-class index.

    The 170-class alphabet is ordered: ``root_idx * 14 + quality_idx`` with
    indices ``168 = N`` and ``169 = X``. Every one of the 170 source indices
    maps to a 62-class index — no orphans.

    Args:
        idx: Integer in ``[0, 170)``.

    Returns:
        Integer in ``[0, 62)``.

    Raises:
        ValueError: If ``idx`` is out of range or its quality is not in the
            canonical 170-class list (which would indicate a programming
            error — the map is total).
    """
    if not 0 <= idx < 170:
        raise ValueError(f"170-class index {idx} out of range [0, 170)")
    if idx == 168:
        return N_INDEX
    if idx == 169:
        return X_INDEX

    root_idx = idx // 14
    quality_idx = idx % 14
    source_quality = _ISMIR_170_QUALITIES[quality_idx]
    collapsed = _HARTE_QUALITY_TO_COLLAPSED.get(source_quality)
    if collapsed is None:
        # This should be unreachable — every 170-class quality is covered.
        raise ValueError(f"170-class quality '{source_quality}' has no 62-class collapse (orphan)")
    collapsed_q_idx = QUALITIES.index(collapsed)
    return root_idx * len(QUALITIES) + collapsed_q_idx


# ---------------------------------------------------------------------------
# Alphabet SHA — training/inference safety hash
# ---------------------------------------------------------------------------


def _compute_alphabet_sha() -> str:
    """Hash the frozen label list — any reorder/change breaks the hash."""
    payload = json.dumps(
        {
            "version": "y1-v1",
            "roots": list(ROOTS),
            "qualities": list(QUALITIES),
            "labels": list(LABELS),
            "n_index": N_INDEX,
            "x_index": X_INDEX,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


ALPHABET_SHA: str = _compute_alphabet_sha()
"""sha256 of the frozen alphabet. Training manifests and eval reports both
record this value — inference-time mismatch fails loud."""
