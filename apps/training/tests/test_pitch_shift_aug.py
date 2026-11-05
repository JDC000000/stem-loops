"""Tests for the pitch-shift augmentation (``training.data.pitch_shift_aug``).

Covers the Harte root rewriter — the only piece with non-trivial semantics.
Audio shifting is a thin librosa wrapper and is not exercised here (its
behaviour is librosa's responsibility and the wrapper takes no choices).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from training.data.pitch_shift_aug import (
    SemitoneRange,
    parse_range,
    shift_harte_symbol,
    shift_lab_file,
)

# ─────────────────────────────────────────────────────────────────────────────
# Harte root arithmetic.
# ─────────────────────────────────────────────────────────────────────────────


def test_c_up_two_is_d() -> None:
    assert shift_harte_symbol("C", 2) == "D"


def test_g_down_two_is_f() -> None:
    assert shift_harte_symbol("G", -2) == "F"


def test_f_sharp_up_two_is_g_sharp() -> None:
    """F# + 2 semitones = G# (not Ab — we always resolve to sharps)."""
    assert shift_harte_symbol("F#", 2) == "G#"


def test_a_minor_up_two_is_b_minor() -> None:
    """Quality tag is preserved verbatim through the shift."""
    assert shift_harte_symbol("A:min", 2) == "B:min"


def test_round_trip_up_two_down_two_preserves() -> None:
    """Shifting +2 and then −2 returns the original spelling for every SHARP-spelled input.

    The shifter always resolves to sharps, so a flat-spelled input won't
    round-trip to itself — it round-trips to its sharp enharmonic. This test
    uses only sharp or natural inputs to assert the invariant where it's
    defined; :func:`test_round_trip_folds_flats_onto_sharps` locks the
    enharmonic-folding behaviour separately.
    """
    for symbol in [
        "C",
        "F#",
        "A:min",
        "G:maj7",
        "A#:dim7",
        "D#:hdim7",
        "E:sus4",
    ]:
        once = shift_harte_symbol(symbol, 2)
        twice = shift_harte_symbol(once, -2)
        assert twice == symbol, f"round-trip failed for {symbol}: got {twice}"


def test_round_trip_folds_flats_onto_sharps() -> None:
    """A flat-spelled input round-trips to its sharp enharmonic.

    This is the designed behaviour (per the Y1 spec: resolve to sharps on
    ambiguity), not a regression. Locking it here keeps the shifter honest.
    """
    assert shift_harte_symbol(shift_harte_symbol("Bb:dim7", 2), -2) == "A#:dim7"
    assert shift_harte_symbol(shift_harte_symbol("Db", 5), -5) == "C#"


def test_all_twelve_pitch_classes_parse() -> None:
    """Every pitch class — sharp or flat spelling — round-trips through the shifter.

    The output always uses sharps (or a natural); that's the convention and
    we check both the sharp input and the enharmonic flat input land on the
    same shifted symbol.
    """
    sharp_inputs = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    flat_inputs = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
    for sharp, flat in zip(sharp_inputs, flat_inputs, strict=True):
        shifted_from_sharp = shift_harte_symbol(sharp, 1)
        shifted_from_flat = shift_harte_symbol(flat, 1)
        assert shifted_from_sharp == shifted_from_flat, (
            f"enharmonic spellings {sharp}/{flat} shifted to different outputs: "
            f"{shifted_from_sharp} vs {shifted_from_flat}"
        )


def test_shift_zero_is_identity_on_root() -> None:
    """Shifting by 0 semitones is identity on the root (sharp spelling normalized)."""
    assert shift_harte_symbol("C", 0) == "C"
    assert shift_harte_symbol("C:maj7", 0) == "C:maj7"
    # Flat input folds to sharp output.
    assert shift_harte_symbol("Db", 0) == "C#"


def test_shift_wraps_modulo_twelve() -> None:
    """A shift of 12 semitones returns the original pitch class (sharp spelling)."""
    for symbol in ["C", "C#", "D", "F:maj7", "A:min", "B:dim7"]:
        assert shift_harte_symbol(symbol, 12) == shift_harte_symbol(symbol, 0)


def test_n_and_x_are_passed_through() -> None:
    """Reserved Harte labels for 'no chord' (N) and 'unknown' (X) are preserved."""
    assert shift_harte_symbol("N", 7) == "N"
    assert shift_harte_symbol("X", -3) == "X"


def test_bad_root_raises() -> None:
    """A clearly bad symbol raises ValueError rather than silently emitting junk."""
    with pytest.raises(ValueError):
        shift_harte_symbol("Z:maj", 1)


def test_bass_suffix_preserved_but_not_shifted() -> None:
    """A slash-bass suffix is preserved verbatim.

    The root pitch is shifted; the bass note after the ``/`` is left alone
    because the Y1 label grammar doesn't yet model slash chords beyond the
    root — a later PR extends this if the trainer wants bass awareness.
    """
    assert shift_harte_symbol("C/G", 2) == "D/G"


# ─────────────────────────────────────────────────────────────────────────────
# .lab file rewriting.
# ─────────────────────────────────────────────────────────────────────────────


def test_shift_lab_file_rewrites_every_chord(tmp_path: Path) -> None:
    """A whole ``.lab`` file is rewritten line by line and lands at the output."""
    src = tmp_path / "song.lab"
    src.write_text(
        "0.000000\t2.000000\tC\n"
        "2.000000\t4.000000\tA:min\n"
        "4.000000\t6.000000\tF:maj7\n"
        "6.000000\t8.000000\tG\n",
        encoding="utf-8",
    )
    dst = tmp_path / "shifted" / "song.lab"
    shift_lab_file(src, 2, dst)
    lines = dst.read_text(encoding="utf-8").strip().splitlines()
    assert lines == [
        "0.000000\t2.000000\tD",
        "2.000000\t4.000000\tB:min",
        "4.000000\t6.000000\tG:maj7",
        "6.000000\t8.000000\tA",
    ]


def test_shift_lab_file_tolerates_space_separated(tmp_path: Path) -> None:
    """Space-separated .lab variants are accepted on read (tab on write)."""
    src = tmp_path / "song.lab"
    src.write_text("0.0 2.0 C\n2.0 4.0 G\n", encoding="utf-8")
    dst = tmp_path / "shifted.lab"
    shift_lab_file(src, 5, dst)
    assert dst.read_text(encoding="utf-8") == "0.0\t2.0\tF\n2.0\t4.0\tC\n"


def test_shift_lab_file_skips_empty_lines(tmp_path: Path) -> None:
    src = tmp_path / "song.lab"
    src.write_text("\n0.0\t1.0\tC\n\n1.0\t2.0\tG\n", encoding="utf-8")
    dst = tmp_path / "shifted.lab"
    shift_lab_file(src, 1, dst)
    assert dst.read_text(encoding="utf-8").strip().splitlines() == [
        "0.0\t1.0\tC#",
        "1.0\t2.0\tG#",
    ]


# ─────────────────────────────────────────────────────────────────────────────
# CLI range parsing.
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_range_accepts_negative_prefix() -> None:
    r = parse_range("-5..+6")
    assert r == SemitoneRange(-5, 6)


def test_parse_range_accepts_unsigned_bounds() -> None:
    r = parse_range("0..4")
    assert r == SemitoneRange(0, 4)


def test_parse_range_rejects_empty_range() -> None:
    import argparse

    with pytest.raises(argparse.ArgumentTypeError):
        parse_range("6..-5")


def test_parse_range_rejects_bad_syntax() -> None:
    import argparse

    with pytest.raises(argparse.ArgumentTypeError):
        parse_range("totally-not-a-range")
