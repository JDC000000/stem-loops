"""Chord-label alphabet for ChordNet Y1 (PR-Y1.4b — factored 25 × 13).

## Alphabet pin (decision-record v1.5)

Decision record v1.5 — `claude/phase-2-y1-chord-model-decision.md`, "Final
alphabet pin" — **switches** the Y1 output from the flat 60-label alphabet to
a **factored two-head alphabet**:

* **Quality head** — 25 classes:
  ``0=maj  1=min  2=dim  3=aug  4=sus2  5=sus4``
  ``6=maj6  7=min6  8=maj7  9=min7  10=7  11=dim7  12=hdim7  13=minmaj7``
  ``14=maj9  15=min9  16=9  17=11  18=13``
  ``19=add9  20=add11  21=5(power)  22=add6  23=aug7``
  ``24=N``
* **Bass head** — 13 classes:
  ``0=same-as-root (or /1)``, ``1..11=pitch-class interval above root`` (in
  semitones), ``12=N/none``.

Total output dim: ``25 + 13 = 38`` **classes** (two independent softmax
heads, *not* the Cartesian 25 × 13 = 325).

### Why the switch

Exp A (``apps/training/exp_a_alphabet_collapse.md`` on branch
``v3-phase-2/exp-a-alphabet-collapse-audit``) audited both alphabets against
124,895 McGill Billboard (ChoCo CC BY 4.0) chord tokens.

| Alphabet        | Exact  | Lossy  | X     |
| --------------- | ------ | ------ | ----- |
| Flat 60         | 60.79% | 39.04% | 0.17% |
| Factored 25 × 13 | 93.84% | 5.92%  | 0.24% |

Flat 60 demotes **39.04%** of Billboard tokens (> 30% decision threshold).
Factored only drops 5.92%. The switch is empirical, not aesthetic.

## Backward compat

The 170 → 60 flat collapse (``collapse_170_to_60``) is kept for the
``output_mode="flat170"`` path, which continues to work exactly as it did in
PR-Y1.4. The new entry point ``collapse_170_to_factored`` collapses onto the
factored heads. ``encode_label`` / ``decode_label`` remain the flat
62-class API; the factored API is ``encode_factored`` /
``decode_factored``.

## ALPHABET_SHA

``ALPHABET_SHA`` is the sha256 of the frozen label lists (roots + quality
labels + bass labels + N/X indices + version). It changes vs the PR-Y1.4
flat-60 alphabet — every checkpoint written under PR-Y1.4 is incompatible
with this file and must be retrained. The training-run manifest records
``ALPHABET_SHA`` so an inference-time mismatch fails loud.
"""

from __future__ import annotations

import hashlib
import json

# ---------------------------------------------------------------------------
# Roots (frozen — ordering is load-bearing for indices + SHA)
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
"""Chromatic roots. Index = pitch class (C=0, B=11)."""

NUM_ROOTS: int = 12
ROOT_N_INDEX: int = NUM_ROOTS
"""No-chord slot (12) in the 13-wide root head. Mirrors the constant of the
same name in ``chordnet_2e1d.py``. Deliberately NOT part of ``ALPHABET_SHA``."""

# ---------------------------------------------------------------------------
# Quality head (25 classes, v1.5 canonical ordering — index = SHA input)
# ---------------------------------------------------------------------------

QUALITY_LABELS: tuple[str, ...] = (
    "maj",
    "min",
    "dim",
    "aug",
    "sus2",
    "sus4",
    "maj6",
    "min6",
    "maj7",
    "min7",
    "7",
    "dim7",
    "hdim7",
    "minmaj7",
    "maj9",
    "min9",
    "9",
    "11",
    "13",
    "add9",
    "add11",
    "5",
    "add6",
    "aug7",
    "N",
)
"""Factored quality head labels (25 classes). Last entry is ``N`` (no-chord)."""

assert len(QUALITY_LABELS) == 25  # noqa: S101 — structural invariant
N_QUALITY: int = 25
QUALITY_N_INDEX: int = 24  # the ``N`` slot in the quality head

# ---------------------------------------------------------------------------
# Bass head (13 classes)
# ---------------------------------------------------------------------------

BASS_LABELS: tuple[str, ...] = tuple(["same"] + [str(i) for i in range(1, 12)] + ["N"])
"""Bass head labels (13 classes).

- ``"same"`` (index 0): bass is the chord root (or unspecified / ``/1``).
- ``"1"`` .. ``"11"`` (indices 1..11): bass is that many semitones above root.
- ``"N"`` (index 12): no bass (no-chord frames)."""

assert len(BASS_LABELS) == 13  # noqa: S101 — structural invariant
N_BASS: int = 13
BASS_SAME_INDEX: int = 0
BASS_N_INDEX: int = 12

# ---------------------------------------------------------------------------
# Backward-compat: the flat 62-class alphabet (PR-Y1.4 — kept for flat170)
# ---------------------------------------------------------------------------

QUALITIES: tuple[str, ...] = ("maj", "min", "dim", "aug", "sus")
"""Legacy flat-60 collapsed qualities. Kept for backward compat with the
``output_mode="flat170"`` path. New code should use ``QUALITY_LABELS``."""

N_LABEL: str = "N"
X_LABEL: str = "X"


def _build_flat_labels() -> list[str]:
    """Build the legacy 62-label list: 60 harmonic + N + X."""
    labels: list[str] = []
    for root in ROOTS:
        for quality in QUALITIES:
            labels.append(f"{root}:{quality}")
    labels.append(N_LABEL)
    labels.append(X_LABEL)
    return labels


LABELS: tuple[str, ...] = tuple(_build_flat_labels())
"""Legacy flat 62-label list — ``maj/min/dim/aug/sus`` × 12 roots, plus N, X.

Kept for the ``output_mode="flat170"`` path. New code uses the factored API."""

NUM_CHORD_LABELS: int = 60
NUM_LABELS: int = 62
N_INDEX: int = NUM_CHORD_LABELS  # 60
X_INDEX: int = NUM_CHORD_LABELS + 1  # 61

# ---------------------------------------------------------------------------
# Harte-input normalisation
# ---------------------------------------------------------------------------

_NAT_PC: dict[str, int] = {
    "C": 0,
    "D": 2,
    "E": 4,
    "F": 5,
    "G": 7,
    "A": 9,
    "B": 11,
}

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

# Legacy Harte-quality → flat-60 collapse (unchanged from PR-Y1.4).
_HARTE_QUALITY_TO_COLLAPSED: dict[str, str] = {
    "maj": "maj",
    "maj6": "maj",
    "maj7": "maj",
    "7": "maj",
    "": "maj",
    "min": "min",
    "min6": "min",
    "min7": "min",
    "minmaj7": "min",
    "dim": "dim",
    "dim7": "dim",
    "hdim7": "dim",
    "aug": "aug",
    "sus": "sus",
    "sus2": "sus",
    "sus4": "sus",
}


def _normalise_root(root: str) -> str:
    """Return the sharp-spelled root (``Db`` → ``C#``)."""
    return _FLAT_TO_SHARP.get(root, root)


def _parse_root_pc(root: str) -> int | None:
    """Parse any Harte root string → pitch class (0..11) or None if unparseable.

    Accepts multi-accidental spellings like ``Cbb`` or ``F##`` by running
    through the accidental tail rather than the fixed flat-to-sharp table.
    """
    if not root:
        return None
    letter = root[0].upper()
    if letter not in _NAT_PC:
        return None
    pc = _NAT_PC[letter]
    for ch in root[1:]:
        if ch == "b":
            pc -= 1
        elif ch == "#":
            pc += 1
        else:
            return None
    return pc % 12


# Harte interval → semitones above root. Covers degrees 1..13 with any number
# of ``b`` / ``#`` accidentals (so ``bb7`` = 9 semitones, ``##4`` = 8, etc.).
_DEG_SEMITONES: dict[str, int] = {
    "1": 0,
    "2": 2,
    "3": 4,
    "4": 5,
    "5": 7,
    "6": 9,
    "7": 11,
    "8": 12,
    "9": 14,
    "10": 16,
    "11": 17,
    "12": 19,
    "13": 21,
}

_SEMITONES_TO_HARTE: dict[int, str] = {
    0: "1",
    1: "b2",
    2: "2",
    3: "b3",
    4: "3",
    5: "4",
    6: "b5",
    7: "5",
    8: "b6",
    9: "6",
    10: "b7",
    11: "7",
}


def _parse_interval(tok: str) -> int | None:
    """Return semitones above root for a Harte interval token, or None on error."""
    if not tok:
        return None
    shift = 0
    i = 0
    while i < len(tok) and tok[i] in "b#":
        shift += -1 if tok[i] == "b" else 1
        i += 1
    deg = tok[i:]
    if deg not in _DEG_SEMITONES:
        return None
    return (_DEG_SEMITONES[deg] + shift) % 12


# ---------------------------------------------------------------------------
# Legacy flat encode / decode (kept for flat170 path)
# ---------------------------------------------------------------------------


def encode_label(harte: str) -> int:
    """Encode a Harte-syntax chord string to its flat 62-class integer label.

    This is the PR-Y1.4 API, kept for the flat170 compat path. New code uses
    ``encode_factored``.

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

    if "/" in harte:
        harte = harte.split("/", 1)[0]
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
    """Decode a flat-62 integer label to its canonical string.

    This is the PR-Y1.4 API. New code uses ``decode_factored``.
    """
    if not 0 <= idx < NUM_LABELS:
        raise ValueError(f"Label index {idx} out of range [0, {NUM_LABELS})")
    return LABELS[idx]


# ---------------------------------------------------------------------------
# 170-class alphabet collapse (legacy flat path — unchanged from PR-Y1.4)
# ---------------------------------------------------------------------------

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
    """Collapse a 170-class alphabet index to the legacy flat 62-class index.

    Kept unchanged from PR-Y1.4 for the ``output_mode="flat170"`` path.
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
        raise ValueError(f"170-class quality '{source_quality}' has no 62-class collapse (orphan)")
    collapsed_q_idx = QUALITIES.index(collapsed)
    return root_idx * len(QUALITIES) + collapsed_q_idx


# ---------------------------------------------------------------------------
# Factored encode / decode (v1.5 canonical API)
# ---------------------------------------------------------------------------

# Direct shorthand → factored quality (no extras). Covers every one of the 24
# non-``N`` slots in ``QUALITY_LABELS`` so a ``decode_factored → encode_factored``
# round-trip is identity on all 24 × 12 chord labels.
_FACTORED_SHORTHAND_EXACT: dict[str, str] = {
    "maj": "maj",
    "min": "min",
    "dim": "dim",
    "aug": "aug",
    "sus2": "sus2",
    "sus4": "sus4",
    "maj6": "maj6",
    "min6": "min6",
    "maj7": "maj7",
    "min7": "min7",
    "7": "7",
    "dim7": "dim7",
    "hdim7": "hdim7",
    "minmaj7": "minmaj7",
    "maj9": "maj9",
    "min9": "min9",
    "9": "9",
    "11": "11",
    "13": "13",
    # Factored-head-only canonical shorthands — these are the decoder's exact
    # output strings for the slots that are not standard Harte shorthands.
    "add9": "add9",
    "add11": "add11",
    "add6": "add6",
    "aug7": "aug7",
    "5": "5",
}

# Lossy fallback for shorthands with no own slot (e.g. maj11 → maj9 drops 11th).
_FACTORED_LOSSY_FALLBACK: dict[str, str] = {
    "maj11": "maj9",
    "maj13": "maj9",
    "min11": "min9",
    "min13": "min9",
    "aug7": "aug7",  # exact: already its own slot
}


def _is_add9_only(extras: tuple[str, ...]) -> bool:
    return extras in (("9",), ("add9",))


def _is_add11_only(extras: tuple[str, ...]) -> bool:
    return extras in (("11",), ("add11",))


def _strip_parens(harte: str) -> tuple[str, tuple[str, ...]]:
    """Split ``C:maj(9,11)`` into (``C:maj``, ``("9", "11")``)."""
    if "(" not in harte:
        return harte, ()
    before, rest = harte.split("(", 1)
    if ")" not in rest:
        return harte, ()
    inside = rest.split(")", 1)[0]
    extras = tuple(t.strip() for t in inside.split(",") if t.strip())
    return before, extras


def encode_factored(harte: str) -> tuple[int, int, int] | None:
    """Encode a Harte-syntax chord string to its (root, quality, bass) indices.

    Returns ``None`` when the label falls outside the 25-quality vocabulary
    and cannot be mapped (callers should drop or mark as ``X``).

    Special cases:
        - ``"N"`` → ``(ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX)``. The root
          head is 13-wide and index 12 is its dedicated no-chord class; pinning
          N to root 0 would train "C" on every no-chord frame.
        - ``"X"`` → ``None`` (out-of-vocab — caller must handle).

    Args:
        harte: Harte chord label (``"C:maj"``, ``"G:7/5"``, ``"A:maj(9)"``,
            ``"N"``, ``"X"``). A bare root (``"C"``) is treated as ``"C:maj"``.

    Returns:
        ``(root_idx, quality_idx, bass_idx)`` tuple, or ``None`` on unknown.
    """
    if harte == N_LABEL:
        return (ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX)
    if harte == X_LABEL:
        return None

    # Split off slash bass before stripping parens.
    bass_tok: str | None = None
    if "/" in harte:
        harte, bass_tok = harte.split("/", 1)

    body, extras = _strip_parens(harte)

    if ":" in body:
        root_str, shorthand = body.split(":", 1)
    else:
        root_str, shorthand = body, ""

    # Root: accept the full Harte spelling grammar (``Cbb``, ``F##``).
    root_pc = _parse_root_pc(root_str)
    if root_pc is None:
        # Not a valid Harte root → caller handles as X.
        return None
    root_idx = root_pc

    # Bass: /1 collapses onto "same".
    if bass_tok is None:
        bass_idx = BASS_SAME_INDEX
    else:
        semis = _parse_interval(bass_tok)
        bass_idx = BASS_SAME_INDEX if semis is None or semis == 0 else semis

    # Quality resolution with extras (ordered — most specific first).
    quality: str | None = None
    if shorthand == "" and not extras:
        # Bare root — Harte convention is major.
        quality = "maj"
    elif shorthand in _FACTORED_SHORTHAND_EXACT and not extras:
        quality = _FACTORED_SHORTHAND_EXACT[shorthand]
    elif shorthand == "maj" and _is_add9_only(extras):
        quality = "add9"
    elif shorthand == "maj" and _is_add11_only(extras):
        quality = "add11"
    elif shorthand == "maj" and extras == ("13",):
        quality = "13"
    elif shorthand == "maj6" and _is_add9_only(extras):
        quality = "add6"
    elif shorthand == "aug" and extras == ("b7",):
        quality = "aug7"
    elif shorthand == "7":
        # 7(b9), 7(#9), 7(#11), 7(b13), …: collapse onto plain 7.
        quality = "7"
    elif shorthand in _FACTORED_SHORTHAND_EXACT:
        # Known shorthand + unrecognised extras → drop extras (lossy but safe).
        quality = _FACTORED_SHORTHAND_EXACT[shorthand]
    elif shorthand in _FACTORED_LOSSY_FALLBACK:
        quality = _FACTORED_LOSSY_FALLBACK[shorthand]
    elif shorthand == "1":
        # Unison — nearest no-third slot is "5" (power).
        quality = "5"
    else:
        return None

    if quality not in QUALITY_LABELS:
        return None
    quality_idx = QUALITY_LABELS.index(quality)
    return (root_idx, quality_idx, bass_idx)


def decode_factored(root_idx: int, quality_idx: int, bass_idx: int) -> str:
    """Decode (root, quality, bass) indices to a Harte string.

    - ``quality_idx == QUALITY_N_INDEX`` (24) → ``"N"`` (any root, incl. ``ROOT_N_INDEX``).
    - ``root_idx == ROOT_N_INDEX`` (12) with a non-N quality is degenerate and
      raises ``ValueError`` (there is no pitch class to name).
    - ``bass_idx == BASS_SAME_INDEX`` (0) → no slash suffix.
    - ``bass_idx == BASS_N_INDEX`` (12) with chord quality → no slash suffix
      (``N`` bass with a non-N quality is a degenerate prediction; callers
      typically clamp to ``BASS_SAME_INDEX`` when the quality is non-N, but we
      decode it as a simple drop here rather than a crash).
    - ``bass_idx`` in ``[1, 11]`` → ``"/<harte-interval>"`` suffix.
    """
    if not 0 <= root_idx <= ROOT_N_INDEX:
        raise ValueError(f"root_idx {root_idx} out of range [0, {ROOT_N_INDEX}]")
    if not 0 <= quality_idx < N_QUALITY:
        raise ValueError(f"quality_idx {quality_idx} out of range [0, {N_QUALITY})")
    if not 0 <= bass_idx < N_BASS:
        raise ValueError(f"bass_idx {bass_idx} out of range [0, {N_BASS})")

    if quality_idx == QUALITY_N_INDEX:
        return N_LABEL
    if root_idx == ROOT_N_INDEX:
        raise ValueError("root_idx ROOT_N_INDEX requires quality_idx == QUALITY_N_INDEX")

    root = ROOTS[root_idx]
    quality = QUALITY_LABELS[quality_idx]
    label = f"{root}:{quality}"
    if bass_idx in (BASS_SAME_INDEX, BASS_N_INDEX):
        return label
    return f"{label}/{_SEMITONES_TO_HARTE[bass_idx]}"


def collapse_170_to_factored(idx: int) -> tuple[int, int, int]:
    """Collapse an ISMIR 170-class index onto the factored (root, quality, bass).

    The 170 scheme has no slash notation, so ``bass`` is always
    ``BASS_SAME_INDEX`` for chord frames and ``BASS_N_INDEX`` for ``N`` / ``X``.

    Args:
        idx: Integer in ``[0, 170)``.

    Returns:
        ``(root_idx, quality_idx, bass_idx)``. For ``idx == 168`` (N) and
        ``idx == 169`` (X) we return
        ``(ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX)``.
    """
    if not 0 <= idx < 170:
        raise ValueError(f"170-class index {idx} out of range [0, 170)")
    if idx in (168, 169):
        return (ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX)

    root_idx = idx // 14
    quality_idx = idx % 14
    source_quality = _ISMIR_170_QUALITIES[quality_idx]
    # Every 170-class source quality has its own slot in the factored head.
    if source_quality not in QUALITY_LABELS:
        raise ValueError(f"170-class quality '{source_quality}' has no factored slot")
    return (root_idx, QUALITY_LABELS.index(source_quality), BASS_SAME_INDEX)


# ---------------------------------------------------------------------------
# Alphabet SHA — training/inference safety hash
# ---------------------------------------------------------------------------


def _compute_alphabet_sha() -> str:
    """Hash the frozen label lists. Any reorder/change breaks the hash."""
    payload = json.dumps(
        {
            "version": "y1-v1.5-factored",
            "roots": list(ROOTS),
            "quality_labels": list(QUALITY_LABELS),
            "bass_labels": list(BASS_LABELS),
            "quality_n_index": QUALITY_N_INDEX,
            "bass_same_index": BASS_SAME_INDEX,
            "bass_n_index": BASS_N_INDEX,
            # Legacy flat alphabet kept in the hash so flat170 checkpoints
            # are invalidated too — one hash guards the whole module.
            "legacy_qualities": list(QUALITIES),
            "legacy_labels": list(LABELS),
            "legacy_n_index": N_INDEX,
            "legacy_x_index": X_INDEX,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


ALPHABET_SHA: str = _compute_alphabet_sha()
"""sha256 of the frozen factored + legacy alphabet. Training manifests and
eval reports both record this value — inference-time mismatch fails loud."""


__all__ = [
    # Factored API (v1.5 canonical)
    "QUALITY_LABELS",
    "BASS_LABELS",
    "N_QUALITY",
    "N_BASS",
    "QUALITY_N_INDEX",
    "BASS_SAME_INDEX",
    "BASS_N_INDEX",
    "encode_factored",
    "decode_factored",
    "collapse_170_to_factored",
    # Shared
    "ROOTS",
    "NUM_ROOTS",
    "ROOT_N_INDEX",
    "ALPHABET_SHA",
    # Legacy flat API (backward compat)
    "QUALITIES",
    "LABELS",
    "NUM_LABELS",
    "NUM_CHORD_LABELS",
    "N_INDEX",
    "X_INDEX",
    "N_LABEL",
    "X_LABEL",
    "encode_label",
    "decode_label",
    "collapse_170_to_60",
]
