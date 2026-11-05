"""Alphabet tests — see ``alphabet.py`` for the 60-vs-62 doc.

Covers:
  - Round-trip encode(decode) for all 60 chord labels.
  - ``collapse_170_to_60`` is total (no orphans across all 170 source indices).
  - ``ALPHABET_SHA`` is stable (regenerating does not change it).
  - Known Harte mappings for the 170-class reductions we promise.
"""

from __future__ import annotations

import pytest

from training.model.alphabet import (
    ALPHABET_SHA,
    LABELS,
    N_INDEX,
    NUM_CHORD_LABELS,
    NUM_LABELS,
    QUALITIES,
    ROOTS,
    X_INDEX,
    _compute_alphabet_sha,
    collapse_170_to_60,
    decode_label,
    encode_label,
)

# ---------------------------------------------------------------------------
# Structural invariants
# ---------------------------------------------------------------------------


def test_alphabet_sizes_are_60_plus_2() -> None:
    assert len(ROOTS) == 12
    assert len(QUALITIES) == 5
    assert NUM_CHORD_LABELS == 60
    assert NUM_LABELS == 62
    assert len(LABELS) == 62


def test_boundary_indices() -> None:
    assert N_INDEX == 60
    assert X_INDEX == 61
    assert LABELS[N_INDEX] == "N"
    assert LABELS[X_INDEX] == "X"


# ---------------------------------------------------------------------------
# Round-trip encode / decode for all 60 chord labels
# ---------------------------------------------------------------------------


def test_round_trip_all_60_chord_labels() -> None:
    for i in range(NUM_CHORD_LABELS):
        label = decode_label(i)
        # decode produced "ROOT:QUALITY"
        assert ":" in label
        root, quality = label.split(":")
        assert root in ROOTS
        assert quality in QUALITIES
        # encode is the inverse
        assert encode_label(label) == i


def test_round_trip_n_and_x() -> None:
    assert encode_label("N") == N_INDEX
    assert decode_label(N_INDEX) == "N"
    assert encode_label("X") == X_INDEX
    assert decode_label(X_INDEX) == "X"


# ---------------------------------------------------------------------------
# Known-answer Harte mappings
# ---------------------------------------------------------------------------


def test_known_harte_mappings() -> None:
    # C:7 collapses to C:maj (we drop the 7th at the 60-label layer).
    assert encode_label("C:7") == encode_label("C:maj")
    # C:aug stays in the aug bucket.
    assert decode_label(encode_label("C:aug")) == "C:aug"
    # N / X pass through.
    assert encode_label("N") == N_INDEX
    assert encode_label("X") == X_INDEX
    # Flat-enharmonic normalisation: Db:maj == C#:maj.
    assert encode_label("Db:maj") == encode_label("C#:maj")
    # Bare root defaults to major (Harte convention).
    assert encode_label("C") == encode_label("C:maj")
    # Sus2 and sus4 both collapse to sus.
    assert encode_label("C:sus2") == encode_label("C:sus4")
    # min7 collapses to min.
    assert encode_label("A:min7") == encode_label("A:min")
    # dim7 / hdim7 collapse to dim.
    assert encode_label("B:dim7") == encode_label("B:dim")
    assert encode_label("B:hdim7") == encode_label("B:dim")
    # Inversion suffix is ignored.
    assert encode_label("C:maj/3") == encode_label("C:maj")


def test_encode_unknown_root_raises() -> None:
    with pytest.raises(ValueError, match="Unknown root"):
        encode_label("H:maj")


def test_encode_unknown_quality_raises() -> None:
    with pytest.raises(ValueError, match="Unknown Harte quality"):
        encode_label("C:weirdchord")


# ---------------------------------------------------------------------------
# 170 -> 60 collapse is total
# ---------------------------------------------------------------------------


def test_collapse_170_covers_all_source_indices() -> None:
    for i in range(170):
        collapsed = collapse_170_to_60(i)
        assert 0 <= collapsed < NUM_LABELS


def test_collapse_170_hits_all_60_chord_labels() -> None:
    """Every 60-chord-label is reachable from some 170 index."""
    reached: set[int] = set()
    for i in range(168):  # 168-169 are N/X in the 170 scheme
        reached.add(collapse_170_to_60(i))
    # All 60 chord labels must be hit (168 / 14 qualities = 12 roots, each
    # covers all 5 collapsed qualities, so 60 is the full set).
    expected_chord_indices = set(range(NUM_CHORD_LABELS))
    assert expected_chord_indices.issubset(reached)


def test_collapse_170_n_and_x() -> None:
    assert collapse_170_to_60(168) == N_INDEX
    assert collapse_170_to_60(169) == X_INDEX


def test_collapse_170_out_of_range_raises() -> None:
    with pytest.raises(ValueError, match="out of range"):
        collapse_170_to_60(170)
    with pytest.raises(ValueError, match="out of range"):
        collapse_170_to_60(-1)


# ---------------------------------------------------------------------------
# ALPHABET_SHA stability
# ---------------------------------------------------------------------------


def test_alphabet_sha_is_hex_sha256() -> None:
    assert len(ALPHABET_SHA) == 64  # hex sha256
    assert all(c in "0123456789abcdef" for c in ALPHABET_SHA)


def test_alphabet_sha_is_reproducible() -> None:
    assert _compute_alphabet_sha() == ALPHABET_SHA
    # Recomputing yields the same value regardless of call count.
    assert _compute_alphabet_sha() == _compute_alphabet_sha()
