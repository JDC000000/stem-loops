"""Unit tests for scripts/alphabet_collapse_audit.py.

A small synthetic corpus of 10 hand-crafted Harte labels, with the expected
outcome for each one under both candidate alphabets.  Re-running the audit on
this synthetic corpus should match the expectations in this file byte-for-byte
(modulo the order of items in some `lost` tuples).

Run from repo root:
    pytest apps/training/tests/test_alphabet_collapse_audit.py -x
"""

from __future__ import annotations

import importlib.util
import os
import sys
import typing
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
_SCRIPT = os.path.join(_REPO_ROOT, "scripts", "alphabet_collapse_audit.py")


def _import_script():
    spec = importlib.util.spec_from_file_location("alphabet_audit", _SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["alphabet_audit"] = mod
    spec.loader.exec_module(mod)
    return mod


audit = _import_script()


class TestHarteParser(unittest.TestCase):
    def test_root_only(self):
        c = audit.parse_harte("C")
        self.assertEqual(c.root_pc, 0)
        self.assertIsNone(c.shorthand)
        self.assertEqual(c.extras, ())
        self.assertFalse(c.is_n)

    def test_maj_triad(self):
        c = audit.parse_harte("D:maj")
        self.assertEqual(c.root_pc, 2)
        self.assertEqual(c.shorthand, "maj")
        self.assertIsNone(c.bass_interval)

    def test_flat_root(self):
        c = audit.parse_harte("Eb:min7")
        self.assertEqual(c.root_pc, 3)
        self.assertEqual(c.shorthand, "min7")

    def test_sharp_root(self):
        c = audit.parse_harte("F#:7")
        self.assertEqual(c.root_pc, 6)
        self.assertEqual(c.shorthand, "7")

    def test_double_flat(self):
        c = audit.parse_harte("Bbb:maj")
        self.assertEqual(c.root_pc, 9)  # Bbb = A

    def test_extras(self):
        c = audit.parse_harte("G:maj(9)")
        self.assertEqual(c.shorthand, "maj")
        self.assertEqual(c.extras, ("9",))

    def test_slash(self):
        c = audit.parse_harte("C:maj/3")
        self.assertEqual(c.root_pc, 0)
        self.assertEqual(c.bass_interval, 4)
        self.assertEqual(c.bass_pc, 4)  # C + 4 semis = E

    def test_slash_on_7th(self):
        c = audit.parse_harte("G:7/b7")
        self.assertEqual(c.shorthand, "7")
        self.assertEqual(c.bass_interval, 10)

    def test_interval_set_only(self):
        c = audit.parse_harte("A:(b3,b7)")
        self.assertIsNone(c.shorthand)
        self.assertEqual(set(c.extras), {"b3", "b7"})

    def test_N(self):
        c = audit.parse_harte("N")
        self.assertTrue(c.is_n)
        self.assertFalse(c.is_x)

    def test_X(self):
        c = audit.parse_harte("X")
        self.assertTrue(c.is_x)
        self.assertFalse(c.is_n)

    def test_garbage(self):
        c = audit.parse_harte("@@@")
        self.assertTrue(c.is_x)

    def test_bass_pc_math(self):
        # Bb:maj/3 -> bass pc = Bb (10) + 4 = D (2)
        c = audit.parse_harte("Bb:maj/3")
        self.assertEqual(c.bass_pc, 2)


class TestFlat60Collapse(unittest.TestCase):
    """10 hand-crafted labels, expected flat-60 collapse outcome."""

    CASES: typing.ClassVar[list] = [
        # (label,                 expected_status, expected_slot, must-contain in `lost`)
        ("C:maj", "exact", "C:maj", ()),
        ("A:min", "exact", "A:min", ()),
        ("G:7", "lossy", "G:maj", ("7th-extension",)),
        ("A:min7", "lossy", "A:min", ("7th-extension",)),
        ("D:maj7", "lossy", "D:maj", ("7th-extension",)),
        ("C:maj/3", "lossy", "C:maj", ("bass:/3",)),
        ("G:maj(9)", "lossy", "G:maj", ("extras:(9)",)),
        ("F#:sus4", "lossy", "F#:sus", ("sus2/sus4-merged",)),
        ("B:dim7", "lossy", "B:dim", ("7th-extension",)),
        ("N", "exact", "N", ()),
    ]

    def test_all(self):
        for label, exp_status, exp_slot, exp_lost_tokens in self.CASES:
            with self.subTest(label=label):
                ch = audit.parse_harte(label)
                out = audit.collapse_flat60(ch)
                self.assertEqual(out.label, exp_slot, f"{label}: slot was {out.label}")
                self.assertEqual(
                    out.status, exp_status, f"{label}: status was {out.status}"
                )
                for tok in exp_lost_tokens:
                    self.assertTrue(
                        any(tok in bit for bit in out.lost),
                        f"{label}: expected {tok!r} in {out.lost}",
                    )


class TestFactoredCollapse(unittest.TestCase):
    """Same 10 labels, expected factored-25x13 outcome."""

    CASES: typing.ClassVar[list] = [
        # (label,      expected_status, expected_slot, expected_bass_state)
        ("C:maj", "exact", "C:maj", 0),
        ("A:min", "exact", "A:min", 0),
        ("G:7", "exact", "G:7", 0),
        ("A:min7", "exact", "A:min7", 0),
        ("D:maj7", "exact", "D:maj7", 0),
        ("C:maj/3", "exact", "C:maj", 4),
        ("G:maj(9)", "exact", "G:add9", 0),
        ("F#:sus4", "exact", "F#:sus4", 0),
        ("B:dim7", "exact", "B:dim7", 0),
        ("N", "exact", "N", 12),
    ]

    def test_all(self):
        for label, exp_status, exp_slot, exp_bass in self.CASES:
            with self.subTest(label=label):
                ch = audit.parse_harte(label)
                out, bass = audit.collapse_factored(ch)
                self.assertEqual(out.label, exp_slot, f"{label}: slot was {out.label}")
                self.assertEqual(
                    out.status, exp_status, f"{label}: status was {out.status}"
                )
                self.assertEqual(bass, exp_bass, f"{label}: bass state was {bass}")


class TestEndToEndTally(unittest.TestCase):
    """Running run_audit on the 10 synthetic tokens should match hand counts."""

    def test_counts(self):
        labels = [c[0] for c in TestFlat60Collapse.CASES]
        tokens = [
            audit.Token(label=l, duration=1.0, source_file="synth") for l in labels
        ]
        report = audit.run_audit(tokens)
        self.assertEqual(report["total_tokens"], 10)
        # Flat-60: 3 exact (C:maj, A:min, N), 7 lossy.
        self.assertEqual(report["flat"].exact_tokens, 3)
        self.assertEqual(report["flat"].lossy_tokens, 7)
        self.assertEqual(report["flat"].x_tokens, 0)
        # Factored: all 10 exact on this hand-picked set.
        self.assertEqual(report["fact"].exact_tokens, 10)
        self.assertEqual(report["fact"].lossy_tokens, 0)
        self.assertEqual(report["fact"].x_tokens, 0)


class TestBassInterval(unittest.TestCase):
    """The 13-way bass head must encode slash intervals correctly."""

    def test_slash_intervals(self):
        for slash, expected in [
            ("/1", 0),
            ("/b2", 1),
            ("/2", 2),
            ("/b3", 3),
            ("/3", 4),
            ("/4", 5),
            ("/b5", 6),
            ("/5", 7),
            ("/b6", 8),
            ("/6", 9),
            ("/b7", 10),
            ("/7", 11),
        ]:
            with self.subTest(slash=slash):
                ch = audit.parse_harte(f"C:maj{slash}")
                _, bass = audit.collapse_factored(ch)
                # /1 collapses onto same-as-root == 0.
                self.assertEqual(bass, expected, f"{slash}: bass was {bass}")


if __name__ == "__main__":
    unittest.main()
