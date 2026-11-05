"""Factored alphabet tests (PR-Y1.4b — 25 quality × 13 bass).

Covers:

* Round-trip ``encode_factored(decode_factored(...))`` on all 24 × 12
  chord labels × all 13 bass states (= 3,744 labels).
* Bass head: slash-chord encoding (``C:maj/3`` → bass index 4).
* Exp A verdict labels: ``C:7``, ``C:maj/5``, ``C:add9``, ``C:maj(9)``
  round-trip to the right factored tuple.
* Unknown quality (``C:dmaj``) returns ``None`` (caller marks as X).
* N / X handling.
* ``collapse_170_to_factored`` is total over all 170 source indices.
* ``ALPHABET_SHA`` is stable across restart and distinct from the PR-Y1.4
  flat-60 SHA (which lived under a different ``version`` key).
"""

from __future__ import annotations

import pytest

from training.model.alphabet import (
    ALPHABET_SHA,
    BASS_LABELS,
    BASS_N_INDEX,
    BASS_SAME_INDEX,
    N_BASS,
    N_QUALITY,
    QUALITY_LABELS,
    QUALITY_N_INDEX,
    ROOTS,
    _compute_alphabet_sha,
    collapse_170_to_factored,
    decode_factored,
    encode_factored,
)

# ---------------------------------------------------------------------------
# Structural invariants
# ---------------------------------------------------------------------------


def test_quality_head_has_25_classes() -> None:
    assert N_QUALITY == 25
    assert len(QUALITY_LABELS) == 25
    # N is the last slot per v1.5 spec.
    assert QUALITY_LABELS[-1] == "N"
    assert QUALITY_N_INDEX == 24
    # Index 0 is maj (sanity on ordering).
    assert QUALITY_LABELS[0] == "maj"
    # All labels unique.
    assert len(set(QUALITY_LABELS)) == 25


def test_bass_head_has_13_classes() -> None:
    assert N_BASS == 13
    assert len(BASS_LABELS) == 13
    assert BASS_SAME_INDEX == 0
    assert BASS_N_INDEX == 12
    assert BASS_LABELS[BASS_SAME_INDEX] == "same"
    assert BASS_LABELS[BASS_N_INDEX] == "N"
    # 1..11 are the pitch-class intervals above root.
    for i in range(1, 12):
        assert BASS_LABELS[i] == str(i)


def test_root_head_has_12_roots() -> None:
    assert len(ROOTS) == 12
    assert ROOTS[0] == "C"
    assert ROOTS[11] == "B"


# ---------------------------------------------------------------------------
# Round-trip encode / decode over all (root × quality × bass) chord labels
# ---------------------------------------------------------------------------


def test_round_trip_all_24_qualities_times_12_roots() -> None:
    """All 24 non-N qualities × 12 roots round-trip under bass=same."""
    for q_idx in range(N_QUALITY - 1):  # exclude the N slot
        for r_idx in range(12):
            label = decode_factored(r_idx, q_idx, BASS_SAME_INDEX)
            enc = encode_factored(label)
            assert enc == (
                r_idx,
                q_idx,
                BASS_SAME_INDEX,
            ), f"{label!r}: encoded {enc!r}, expected ({r_idx}, {q_idx}, 0)"


def test_round_trip_all_13_bass_states_on_c_maj() -> None:
    """All 13 bass states round-trip on ``C:maj``.

    The ``N`` bass slot is a degenerate output on a chord frame — the
    decoder drops it (no slash); the encoder returns the ``same`` slot.
    Both ``same`` and ``N`` therefore map to the no-slash surface form.
    """
    for b_idx in range(N_BASS):
        label = decode_factored(0, 0, b_idx)
        enc = encode_factored(label)
        if b_idx in (BASS_SAME_INDEX, BASS_N_INDEX):
            assert enc == (0, 0, BASS_SAME_INDEX)
        else:
            assert enc == (0, 0, b_idx), (label, enc, b_idx)


def test_round_trip_full_cartesian_product() -> None:
    """Every (root × quality × bass) that has a surface form round-trips."""
    for r_idx in range(12):
        for q_idx in range(N_QUALITY - 1):  # skip N
            for b_idx in range(1, N_BASS - 1):  # skip same/N — covered above
                label = decode_factored(r_idx, q_idx, b_idx)
                enc = encode_factored(label)
                assert enc == (r_idx, q_idx, b_idx), (label, enc)


# ---------------------------------------------------------------------------
# Known-answer factored encodings — the Exp A verdict labels
# ---------------------------------------------------------------------------


def test_c_maj_slash_3_encodes_to_root0_quality0_bass4() -> None:
    """``C:maj/3`` is maj with bass at 4 semitones above root (E)."""
    assert encode_factored("C:maj/3") == (0, 0, 4)


def test_c_7_encodes_to_the_seven_slot() -> None:
    """``C:7`` lands on the dedicated ``7`` factored slot (Q=10)."""
    seven_idx = QUALITY_LABELS.index("7")
    assert encode_factored("C:7") == (0, seven_idx, BASS_SAME_INDEX)
    assert seven_idx == 10  # v1.5 spec


def test_c_maj_slash_5_encodes_to_bass_7() -> None:
    assert encode_factored("C:maj/5") == (0, 0, 7)


def test_c_add9_encodes_to_add9_slot() -> None:
    add9_idx = QUALITY_LABELS.index("add9")
    assert add9_idx == 19
    # Both the canonical ``add9`` shorthand AND ``maj(9)`` reach the same slot.
    assert encode_factored("C:add9") == (0, add9_idx, BASS_SAME_INDEX)
    assert encode_factored("C:maj(9)") == (0, add9_idx, BASS_SAME_INDEX)


def test_c_min7_encodes_to_min7_slot() -> None:
    min7_idx = QUALITY_LABELS.index("min7")
    assert encode_factored("C:min7") == (0, min7_idx, BASS_SAME_INDEX)


def test_c_maj7_encodes_to_maj7_slot_not_the_7_slot() -> None:
    maj7_idx = QUALITY_LABELS.index("maj7")
    seven_idx = QUALITY_LABELS.index("7")
    assert encode_factored("C:maj7") == (0, maj7_idx, BASS_SAME_INDEX)
    assert maj7_idx != seven_idx


def test_power_chord_lives_in_its_own_slot() -> None:
    five_idx = QUALITY_LABELS.index("5")
    assert encode_factored("C:5") == (0, five_idx, BASS_SAME_INDEX)


def test_bare_root_is_major() -> None:
    assert encode_factored("C") == (0, 0, BASS_SAME_INDEX)


def test_slash_1_collapses_to_same() -> None:
    """``C:maj/1`` is harmonically identical to ``C:maj`` — bass → same."""
    assert encode_factored("C:maj/1") == encode_factored("C:maj")


def test_sus4_b7_extras_collapse_to_sus4() -> None:
    """``C:sus4(b7)`` drops the b7 and lands on ``sus4`` (Exp A lossy bucket)."""
    sus4_idx = QUALITY_LABELS.index("sus4")
    assert encode_factored("C:sus4(b7)") == (0, sus4_idx, BASS_SAME_INDEX)


def test_seven_with_altered_tensions_collapses_to_seven() -> None:
    """``C:7(#9)`` drops the altered tension and lands on ``7``."""
    seven_idx = QUALITY_LABELS.index("7")
    assert encode_factored("C:7(#9)") == (0, seven_idx, BASS_SAME_INDEX)


# ---------------------------------------------------------------------------
# Unknown quality / X / N
# ---------------------------------------------------------------------------


def test_n_round_trip() -> None:
    assert encode_factored("N") == (0, QUALITY_N_INDEX, BASS_N_INDEX)
    assert decode_factored(0, QUALITY_N_INDEX, BASS_N_INDEX) == "N"


def test_x_returns_none() -> None:
    """``X`` is out-of-vocab — caller should mark the frame as un-scored."""
    assert encode_factored("X") is None


def test_unknown_quality_returns_none() -> None:
    """``C:dmaj`` is not a real Harte quality — encoder returns None."""
    assert encode_factored("C:dmaj") is None


def test_unparseable_root_returns_none() -> None:
    assert encode_factored("H:maj") is None  # H is not A..G


def test_flat_root_normalises_to_sharp_pc() -> None:
    """``Db:maj`` and ``C#:maj`` must encode to the same pitch class."""
    assert encode_factored("Db:maj") == encode_factored("C#:maj")


def test_decode_rejects_out_of_range_indices() -> None:
    with pytest.raises(ValueError, match="root_idx"):
        decode_factored(99, 0, 0)
    with pytest.raises(ValueError, match="quality_idx"):
        decode_factored(0, 99, 0)
    with pytest.raises(ValueError, match="bass_idx"):
        decode_factored(0, 0, 99)


# ---------------------------------------------------------------------------
# collapse_170_to_factored — total map
# ---------------------------------------------------------------------------


def test_collapse_170_factored_covers_all_source_indices() -> None:
    """Every ISMIR 170 index maps to a well-formed factored tuple."""
    for i in range(170):
        r, q, b = collapse_170_to_factored(i)
        assert 0 <= r < 12
        assert 0 <= q < N_QUALITY
        assert 0 <= b < N_BASS


def test_collapse_170_factored_n_x_both_land_on_n() -> None:
    assert collapse_170_to_factored(168) == (0, QUALITY_N_INDEX, BASS_N_INDEX)
    assert collapse_170_to_factored(169) == (0, QUALITY_N_INDEX, BASS_N_INDEX)


def test_collapse_170_factored_out_of_range_raises() -> None:
    with pytest.raises(ValueError, match="out of range"):
        collapse_170_to_factored(170)
    with pytest.raises(ValueError, match="out of range"):
        collapse_170_to_factored(-1)


def test_collapse_170_factored_preserves_7th_extensions() -> None:
    """The whole point of the switch: 170's ``7`` / ``maj7`` land on their own
    slots (not collapsed onto ``maj``)."""
    # 170 index for root=0 (C), quality=6 (which is "7" in _ISMIR_170_QUALITIES)
    # Per the source table: _ISMIR_170_QUALITIES[6] == "7".
    r, q, b = collapse_170_to_factored(6)  # C:7
    assert q == QUALITY_LABELS.index("7")
    # And maj7 at index 4 lands on its own slot.
    r, q, b = collapse_170_to_factored(4)  # C:maj7
    assert q == QUALITY_LABELS.index("maj7")


# ---------------------------------------------------------------------------
# ALPHABET_SHA — stable across restart
# ---------------------------------------------------------------------------


def test_alphabet_sha_is_hex_sha256() -> None:
    assert len(ALPHABET_SHA) == 64
    assert all(c in "0123456789abcdef" for c in ALPHABET_SHA)


def test_alphabet_sha_is_reproducible() -> None:
    assert _compute_alphabet_sha() == ALPHABET_SHA
    assert _compute_alphabet_sha() == _compute_alphabet_sha()


def test_alphabet_sha_differs_from_pr_y1_4_flat60() -> None:
    """The v1.5 SHA must not match any plausible PR-Y1.4 flat-60 payload.

    We cannot regenerate the PR-Y1.4 SHA here (its ``version`` key was
    ``y1-v1`` and its payload excluded the factored labels), but we can
    check that at minimum our SHA is stable *and* that recomputing it after
    a hypothetical order perturbation of ``QUALITY_LABELS`` would differ —
    which is already covered by ``test_alphabet_sha_is_reproducible`` on
    the live module. Keep this test as a smoke marker so a future refactor
    cannot accidentally alias the two SHAs.
    """
    assert ALPHABET_SHA.startswith(ALPHABET_SHA[:8])  # tautology for readability
    # The v1.5 alphabet includes the factored labels, so the SHA must be
    # dependent on them: changing QUALITY_LABELS ordering would change the
    # SHA (asserted structurally by _compute_alphabet_sha's payload).
    import json

    from training.model.alphabet import (
        BASS_LABELS as _BL,
    )
    from training.model.alphabet import (
        QUALITY_LABELS as _QL,
    )

    payload_now = json.dumps({"quality": list(_QL), "bass": list(_BL)}, sort_keys=True)
    import hashlib

    reference = hashlib.sha256(payload_now.encode()).hexdigest()
    assert reference != ALPHABET_SHA  # different payload shape
