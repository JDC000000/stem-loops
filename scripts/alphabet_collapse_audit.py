#!/usr/bin/env python3
"""
Experiment A: alphabet collapse audit on McGill Billboard ground-truth.

See project doc `claude/phase-2-y1-chord-model-redteam-alphabet-cqt.md` and the
referenced "exp(y1): alphabet collapse audit on McGill Billboard (Exp A)" PR.

Compares two candidate output alphabets against Harte-labeled ground-truth:

  1. Flat 60     : 12 roots x 5 qualities {maj, min, dim, aug, sus} = 60
                   + N + X.  No 7th slot; no bass slot.  Every 7th chord is
                   demoted to its triad; every slash chord has the bass
                   dropped; every additive extension is dropped.
  2. Factored    : two heads --
                   quality head (25 classes): maj, min, dim, aug, sus2, sus4,
                     maj6, min6, maj7, min7, 7, dim7, hdim7, minmaj7, maj9,
                     min9, 9, 11, 13, add9, add11, 5, add6, aug7, N
                   bass head (13 classes): same-as-root (0) + 12 pitch-class
                     slash states (semitones 0..11).  /1 collapses onto 0.
                   Output dimension is 25 + 13 = 38 (two independent softmaxes).

The script accepts either a directory of McGill Billboard `.lab` files (one
song per file, Harte-style "<start> <end> <label>" lines) OR a directory of
ChoCo-style `.jams` files with a `chord` namespace.  It prints the four audit
tables to stdout (pipe to `apps/training/exp_a_alphabet_collapse.md` to
regenerate the report).

Usage:
    python scripts/alphabet_collapse_audit.py \\
        --jams-dir /home/claude/smashub/choco/partitions/billboard/choco/jams
    python scripts/alphabet_collapse_audit.py --lab-dir path/to/labs
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# 1. Harte parser.
#
# Harte 2010 "Symbolic representation of musical chords":
#   <chord> ::= <root> [ ":" <shorthand> [ "(" <intervals> ")" ] ] [ "/" <bass> ]
#              | <root> [ ":" "(" <intervals> ")" ] [ "/" <bass> ]
#              | "N" | "X"
# ChoCo's Billboard JAMS files preserve this surface form faithfully.
# We only need to decompose a label into (root_pc, quality_key, bass_pc, has_bass).
# ---------------------------------------------------------------------------

# Pitch-class map (natural notes); accidentals handled procedurally.
_NAT_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _parse_root(root: str) -> int | None:
    """Return pitch class (0-11) of a Harte root string, or None if unrecognized."""
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


# Harte interval -> semitones. Covers 1..13 + "same" degrees with any number of
# b / # accidentals (so "bb7" = 9 semitones, "##4" = 8, etc.).
_DEG_SEMITONES = {
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


def _parse_interval(tok: str) -> int | None:
    """Return semitones above root for a Harte interval token, or None if bogus."""
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


@dataclass
class HarteChord:
    """A minimal structured view of a Harte chord label."""

    raw: str
    root_pc: int | None  # None for N / X / unparseable
    shorthand: str | None  # 'maj', 'min7', ..., None if not given
    extras: tuple[str, ...]  # additive intervals from "(...)" (e.g. ('9',))
    bass_pc: int | None  # None if no "/..." given
    bass_interval: int | None  # semitones above root for "/..." bass, None if no slash
    is_n: bool
    is_x: bool


_LABEL_RE = re.compile(
    r"""
    ^
    (?P<root>[A-G][b#]*)
    (?:
        :
        (?:
            (?P<shorthand>[A-Za-z0-9]+)
            (?:\((?P<extras1>[^)]*)\))?
            |
            \((?P<extras2>[^)]*)\)
        )
    )?
    (?:/(?P<bass>[b#]*\d+))?
    $
    """,
    re.VERBOSE,
)


def parse_harte(label: str) -> HarteChord:
    """Parse one Harte chord label.  Non-chord markers return is_n / is_x."""
    s = label.strip()
    if s == "" or s == "N":
        return HarteChord(
            raw=label,
            root_pc=None,
            shorthand=None,
            extras=(),
            bass_pc=None,
            bass_interval=None,
            is_n=True,
            is_x=False,
        )
    if s == "X":
        return HarteChord(
            raw=label,
            root_pc=None,
            shorthand=None,
            extras=(),
            bass_pc=None,
            bass_interval=None,
            is_n=False,
            is_x=True,
        )
    m = _LABEL_RE.match(s)
    if m is None:
        return HarteChord(
            raw=label,
            root_pc=None,
            shorthand=None,
            extras=(),
            bass_pc=None,
            bass_interval=None,
            is_n=False,
            is_x=True,
        )
    root_pc = _parse_root(m.group("root"))
    shorthand = m.group("shorthand")
    extras_raw = m.group("extras1") or m.group("extras2") or ""
    extras = tuple(t.strip() for t in extras_raw.split(",") if t.strip())
    bass_tok = m.group("bass")
    bass_interval = _parse_interval(bass_tok) if bass_tok else None
    bass_pc = (
        (root_pc + bass_interval) % 12
        if root_pc is not None and bass_interval is not None
        else None
    )
    if root_pc is None:
        return HarteChord(
            raw=label,
            root_pc=None,
            shorthand=None,
            extras=(),
            bass_pc=None,
            bass_interval=None,
            is_n=False,
            is_x=True,
        )
    return HarteChord(
        raw=label,
        root_pc=root_pc,
        shorthand=shorthand,
        extras=extras,
        bass_pc=bass_pc,
        bass_interval=bass_interval,
        is_n=False,
        is_x=False,
    )


# ---------------------------------------------------------------------------
# 2. Alphabet mappings.
# ---------------------------------------------------------------------------

# Flat 60: {maj, min, dim, aug, sus}.  sus2 and sus4 both map to "sus".
_FLAT_QUALITY_MAP = {
    "maj": "maj",
    "min": "min",
    "dim": "dim",
    "aug": "aug",
    "sus2": "sus",
    "sus4": "sus",
    # 7th / 6th / extended quality shorthands collapse to their nearest triad:
    "maj6": "maj",
    "min6": "min",
    "maj7": "maj",
    "min7": "min",
    "7": "maj",
    "maj9": "maj",
    "min9": "min",
    "9": "maj",
    "11": "maj",
    "13": "maj",
    "maj11": "maj",
    "maj13": "maj",
    "min11": "min",
    "min13": "min",
    "minmaj7": "min",
    "dim7": "dim",
    "hdim7": "dim",
    "aug7": "aug",
    # Power chord / unison-like: no third, so we cannot place them on a triad
    # dimension honestly.  Mark as lossy-to-maj for parity with common
    # practice (and because they most often function as "maj with a weak
    # third"), but count the loss.
    "5": "maj",
    "1": "maj",
}

# Which flat-60 mappings are exact vs lossy (information dropped beyond the
# triad slot).  "Exact" means: no extras, no slash, quality is one of the five
# flat-60 triad shorthands.
_FLAT_EXACT_SHORTHANDS = {"maj", "min", "dim", "aug", "sus2", "sus4"}


# Factored 25 qualities (in canonical order):
FACTORED_QUALITIES: tuple[str, ...] = (
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
assert len(FACTORED_QUALITIES) == 25, len(FACTORED_QUALITIES)

# Shorthand -> factored quality for the "no extras" case.  Anything not here
# falls through to the add-extension / lossy pathway below.
_FACT_SHORTHAND_EXACT = {
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
    "5": "5",
}

# Lossy fallback for shorthands not in the 25.  Record what information gets
# dropped so the top-lossiest table is auditable.
_FACT_LOSSY_FALLBACK = {
    "maj11": ("maj9", "11-tension"),
    "maj13": ("maj9", "11-and-13-tensions"),
    "min11": ("min9", "11-tension"),
    "min13": ("min9", "11-and-13-tensions"),
    "aug7": ("aug7", ""),  # exact after all (aug + b7)
}


def _is_add9_only(extras: tuple[str, ...]) -> bool:
    return extras == ("9",) or extras == ("add9",)


def _is_add11_only(extras: tuple[str, ...]) -> bool:
    return extras == ("11",) or extras == ("add11",)


# ---------------------------------------------------------------------------
# 3. Collapse engines.
# ---------------------------------------------------------------------------


@dataclass
class CollapseOutcome:
    """Per-token decision + diagnostic trail for one alphabet."""

    label: str  # the slot the token lands on (e.g. "C:maj", or "X")
    status: str  # "exact", "lossy", "x"
    lost: tuple[str, ...]  # what information was dropped (e.g. "7th", "bass", "(9)")


def collapse_flat60(chord: HarteChord) -> CollapseOutcome:
    """Map one HarteChord onto the flat 60-label alphabet (+ N, + X)."""
    if chord.is_n:
        return CollapseOutcome(label="N", status="exact", lost=())
    if chord.is_x or chord.root_pc is None:
        return CollapseOutcome(label="X", status="x", lost=("unparseable",))

    lost: list[str] = []

    # Determine triad slot.
    shorthand = chord.shorthand
    if shorthand is None:
        # Bare "C:(b3,b7)" or "C" (chord with only extras / nothing).  The flat
        # alphabet has no way to express a pure interval set, so land on X
        # unless the extras encode a recognizable triad.
        if not chord.extras:
            # bare "C" -- treat as maj (ChoCo normalizes this; rarely seen).
            triad = "maj"
        else:
            # Try to infer triad from extras.
            exts_pc = {_parse_interval(e) for e in chord.extras}
            exts_pc.discard(None)
            has_b3 = 3 in exts_pc
            has_3 = 4 in exts_pc
            has_b5 = 6 in exts_pc
            has_s5 = 8 in exts_pc
            if has_3 and has_s5:
                triad = "aug"
            elif has_3:
                triad = "maj"
            elif has_b3 and has_b5:
                triad = "dim"
            elif has_b3:
                triad = "min"
            else:
                return CollapseOutcome(
                    label="X", status="x", lost=("no_recognizable_triad_in_extras",)
                )
            lost.append("interval-set->triad")
    elif shorthand in _FLAT_QUALITY_MAP:
        triad = _FLAT_QUALITY_MAP[shorthand]
        # Record what (if anything) the collapse dropped.
        if shorthand not in _FLAT_EXACT_SHORTHANDS:
            # e.g. "maj7" -> "maj" drops the 7th; "5" -> "maj" drops the
            # power-chord-ness (no third!).
            if shorthand.endswith("7") or shorthand in {
                "9",
                "11",
                "13",
                "maj9",
                "maj11",
                "maj13",
                "min9",
                "min11",
                "min13",
                "minmaj7",
            }:
                lost.append("7th-extension")
            elif shorthand.endswith("6"):
                lost.append("6th-extension")
            elif shorthand == "5":
                lost.append("power-chord(no-3rd)")
            elif shorthand == "1":
                lost.append("unison(no-3rd-no-5th)")
    else:
        # Unknown shorthand (e.g. "augmaj7" if it appears).  Try to be safe: X.
        return CollapseOutcome(
            label="X", status="x", lost=(f"unknown_shorthand:{shorthand}",)
        )

    # Sus2 and sus4 both go to the single "sus" slot.
    if shorthand in ("sus2", "sus4"):
        lost.append("sus2/sus4-merged")

    # Extras (parenthesized additions) are always dropped by flat-60.
    if chord.extras:
        lost.append(f"extras:({','.join(chord.extras)})")

    # Slash bass always dropped.  /1 is meaningless (same as root) so not
    # counted as information loss.
    if chord.bass_interval is not None and chord.bass_interval != 0:
        lost.append(
            "bass:/"
            + _SEMITONES_TO_HARTE.get(
                chord.bass_interval, f"{chord.bass_interval}semis"
            )
        )

    status = "exact" if not lost else "lossy"
    root_names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    label = f"{root_names[chord.root_pc]}:{triad}"
    return CollapseOutcome(label=label, status=status, lost=tuple(lost))


def collapse_factored(chord: HarteChord) -> tuple[CollapseOutcome, int]:
    """Map one HarteChord onto the factored 25 x 13 alphabet.

    Returns (quality-head outcome, bass-head state).
    bass state is 0 for "same as root (or unspecified)", 1..11 for slash
    bass at that many semitones above root, 12 for the "N / no bass" state.
    """
    if chord.is_n:
        return CollapseOutcome(label="N", status="exact", lost=()), 12
    if chord.is_x or chord.root_pc is None:
        return CollapseOutcome(label="X", status="x", lost=("unparseable",)), 12

    lost: list[str] = []
    shorthand = chord.shorthand

    # Figure out the bass state first.  bass_interval==0 means "/1" written
    # explicitly: harmonically identical to "no slash".
    if chord.bass_interval is None or chord.bass_interval == 0:
        bass_state = 0
    else:
        bass_state = chord.bass_interval  # 1..11

    # --- quality head ---
    if shorthand in _FACT_SHORTHAND_EXACT and not chord.extras:
        quality = _FACT_SHORTHAND_EXACT[shorthand]
        status = "exact"
    elif shorthand == "maj" and _is_add9_only(chord.extras):
        quality = "add9"
        status = "exact"
    elif shorthand == "maj" and _is_add11_only(chord.extras):
        quality = "add11"
        status = "exact"
    elif shorthand == "maj" and chord.extras == ("13",):
        quality = "13"
        status = "lossy"
        lost.append("maj(13)->13")
    elif shorthand == "maj6" and _is_add9_only(chord.extras):
        quality = "add6"  # maj6(9) is just a 6/9 chord.  'add6' is closest if
        # we interpret 'add6' as a maj triad with added 6 (no 7).  Collapsing
        # the (9) is lossy.
        status = "lossy"
        lost.append("maj6(9)->add6:dropped-9")
    elif shorthand == "aug" and chord.extras == ("b7",):
        quality = "aug7"
        status = "exact"
    elif shorthand == "sus4" and chord.extras == ("b7",):
        quality = "sus4"
        status = "lossy"
        lost.append("sus4(b7)->sus4:dropped-b7")
    elif shorthand == "sus4" and chord.extras == ("b7", "9"):
        quality = "sus4"
        status = "lossy"
        lost.append("sus4(b7,9)->sus4:dropped-b7-and-9")
    elif shorthand == "sus4" and chord.extras == ("9",):
        quality = "sus4"
        status = "lossy"
        lost.append("sus4(9)->sus4:dropped-9")
    elif shorthand == "sus2" and chord.extras == ("b7",):
        quality = "sus2"
        status = "lossy"
        lost.append("sus2(b7)->sus2:dropped-b7")
    elif shorthand == "5" and chord.extras == ("b7",):
        quality = "5"
        status = "lossy"
        lost.append("5(b7)->5:dropped-b7")
    elif shorthand == "7":
        # 7(b9), 7(#9), 7(#11), 7(b13), ... all collapse to plain "7"
        quality = "7"
        status = "lossy"
        lost.append(f"7({','.join(chord.extras)})->7:dropped-altered-tensions")
    elif shorthand == "min":
        if chord.extras:
            quality = "min"
            status = "lossy"
            lost.append(f"min({','.join(chord.extras)})->min:dropped-extras")
        else:
            quality = "min"
            status = "exact"
    elif shorthand == "min7":
        quality = "min7"
        status = "lossy" if chord.extras else "exact"
        if chord.extras:
            lost.append(f"min7({','.join(chord.extras)})->min7:dropped-extras")
    elif shorthand == "maj" and chord.extras:
        quality = "maj"
        status = "lossy"
        lost.append(f"maj({','.join(chord.extras)})->maj:dropped-extras")
    elif shorthand in _FACT_LOSSY_FALLBACK:
        fallback, descr = _FACT_LOSSY_FALLBACK[shorthand]
        quality = fallback
        status = "lossy" if descr else "exact"
        if descr:
            lost.append(descr)
    elif shorthand == "1":
        # Unison-only.  No equivalent in the 25-quality head; nearest
        # (no-third) quality is "5" (power).  Lossy approximation.
        quality = "5"
        status = "lossy"
        lost.append("1(unison)->5:approximated-no-5th-either")
    elif shorthand in _FACT_SHORTHAND_EXACT:
        # Known shorthand but extras are not one of the enumerated patterns
        # above.  Collapse to the base shorthand's quality slot, mark lossy.
        quality = _FACT_SHORTHAND_EXACT[shorthand]
        status = "lossy"
        lost.append(
            f"{shorthand}({','.join(chord.extras)})->" f"{quality}:dropped-extras"
        )
    elif shorthand is None and chord.extras:
        # Interval-set chord with no shorthand: e.g. "G:(b3,b7)" or "C:(11)".
        # These are rare (<0.1% of corpus) and genuinely cannot be
        # decomposed into a (quality, bass) pair without guessing, so they
        # land on X deliberately.
        return (
            CollapseOutcome(label="X", status="x", lost=("interval-set-only",)),
            bass_state,
        )
    else:
        return (
            CollapseOutcome(
                label="X", status="x", lost=(f"unknown:{shorthand}:{chord.extras}",)
            ),
            bass_state,
        )

    root_names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    label = f"{root_names[chord.root_pc]}:{quality}"
    return CollapseOutcome(label=label, status=status, lost=tuple(lost)), bass_state


# ---------------------------------------------------------------------------
# 4. Corpus I/O.
# ---------------------------------------------------------------------------


@dataclass
class Token:
    label: str
    duration: float
    source_file: str


def iter_jams(jams_dir: str) -> Iterable[Token]:
    for path in sorted(glob.glob(os.path.join(jams_dir, "*.jams"))):
        with open(path) as f:
            doc = json.load(f)
        for ann in doc.get("annotations", []):
            if ann.get("namespace") != "chord":
                continue
            for obs in ann.get("data", []):
                yield Token(
                    label=obs["value"],
                    duration=float(obs.get("duration") or 0.0),
                    source_file=os.path.basename(path),
                )
            break  # use only the first chord annotation


def iter_labs(lab_dir: str) -> Iterable[Token]:
    for path in sorted(glob.glob(os.path.join(lab_dir, "**", "*.lab"), recursive=True)):
        with open(path) as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 3:
                    continue
                try:
                    start = float(parts[0])
                    end = float(parts[1])
                except ValueError:
                    continue
                label = " ".join(parts[2:])
                yield Token(
                    label=label,
                    duration=max(0.0, end - start),
                    source_file=os.path.basename(path),
                )


# ---------------------------------------------------------------------------
# 5. Audit runner.
# ---------------------------------------------------------------------------


@dataclass
class AuditTotals:
    exact_tokens: int = 0
    lossy_tokens: int = 0
    x_tokens: int = 0
    exact_time: float = 0.0
    lossy_time: float = 0.0
    x_time: float = 0.0

    def tally(self, status: str, duration: float) -> None:
        if status == "exact":
            self.exact_tokens += 1
            self.exact_time += duration
        elif status == "lossy":
            self.lossy_tokens += 1
            self.lossy_time += duration
        else:
            self.x_tokens += 1
            self.x_time += duration


def run_audit(tokens: Iterable[Token]) -> dict:
    flat = AuditTotals()
    fact = AuditTotals()

    # For the "top lossy qualities" table we group by (shorthand, has_extras,
    # has_slash) with a human-readable key.
    lossy_bucket_flat: collections.Counter[str] = collections.Counter()
    lossy_detail_flat: dict[str, tuple[str, str]] = (
        {}
    )  # bucket -> (collapsed, info-lost)
    lossy_bucket_fact: collections.Counter[str] = collections.Counter()
    lossy_detail_fact: dict[str, tuple[str, str]] = {}

    total_tokens = 0
    total_time = 0.0

    for tok in tokens:
        chord = parse_harte(tok.label)
        total_tokens += 1
        total_time += tok.duration

        f_out = collapse_flat60(chord)
        flat.tally(f_out.status, tok.duration)
        if f_out.status == "lossy":
            # Bucket by the chord's quality + has-slash + has-extras
            # (root-independent).
            bucket = _quality_bucket(chord)
            lossy_bucket_flat[bucket] += 1
            if bucket not in lossy_detail_flat:
                lossy_detail_flat[bucket] = (
                    _collapsed_quality(f_out.label),
                    ";".join(f_out.lost),
                )

        fo_out, _bass_state = collapse_factored(chord)
        fact.tally(fo_out.status, tok.duration)
        if fo_out.status == "lossy":
            bucket = _quality_bucket(chord)
            lossy_bucket_fact[bucket] += 1
            if bucket not in lossy_detail_fact:
                lossy_detail_fact[bucket] = (
                    _collapsed_quality(fo_out.label),
                    ";".join(fo_out.lost),
                )

    return {
        "total_tokens": total_tokens,
        "total_time": total_time,
        "flat": flat,
        "fact": fact,
        "lossy_bucket_flat": lossy_bucket_flat,
        "lossy_detail_flat": lossy_detail_flat,
        "lossy_bucket_fact": lossy_bucket_fact,
        "lossy_detail_fact": lossy_detail_fact,
    }


# Map 0..11 semitones back to Harte interval notation so the bucket in the
# audit report uses the same notation a reader of the raw labels sees.
_SEMITONES_TO_HARTE = {
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


def _quality_bucket(chord: HarteChord) -> str:
    """Root-independent key describing the input chord's quality shape.

    Bass slashes are rendered back in Harte interval notation (/5, /b7, ...)
    rather than raw semitones, so that a reader of the lossy-qualities table
    sees the same string shape the ChoCo corpus uses.
    """
    if chord.is_n:
        return "N"
    if chord.is_x or chord.root_pc is None:
        return "X"
    parts: list[str] = []
    parts.append(chord.shorthand or "<no-shorthand>")
    if chord.extras:
        parts.append("(" + ",".join(chord.extras) + ")")
    if chord.bass_interval is not None and chord.bass_interval != 0:
        parts.append(
            "/"
            + _SEMITONES_TO_HARTE.get(
                chord.bass_interval, f"{chord.bass_interval}semis"
            )
        )
    return "".join(parts)


def _collapsed_quality(label: str) -> str:
    if ":" in label:
        return label.split(":", 1)[1]
    return label


# ---------------------------------------------------------------------------
# 6. Rendering.
# ---------------------------------------------------------------------------


def _pct(n: float, total: float) -> str:
    if total == 0:
        return "0.00%"
    return f"{100 * n / total:.2f}%"


def render_markdown(report: dict, source_label: str, sha256: str) -> str:
    total_tokens = report["total_tokens"]
    total_time = report["total_time"]
    flat: AuditTotals = report["flat"]
    fact: AuditTotals = report["fact"]

    flat_lossy_pct = 100 * flat.lossy_tokens / max(1, total_tokens)
    if flat_lossy_pct < 15.0:
        verdict = "KEEP"
        verdict_sentence = (
            f"Flat-60 demotes **{flat_lossy_pct:.2f}%** of Billboard tokens "
            f"(< 15% threshold). KEEP the v1 alphabet pin; re-evaluate after "
            f"PR-Y1.4 trains and we see empirical qualify-only F1."
        )
    elif flat_lossy_pct < 30.0:
        verdict = "SWITCH"
        verdict_sentence = (
            f"Flat-60 demotes **{flat_lossy_pct:.2f}%** of Billboard tokens "
            f"(15-30% range). **SWITCH** to the factored 25-quality x 13-bass "
            f"head BEFORE PR-Y1.4 merges; open follow-up PR-Y1.4b."
        )
    else:
        verdict = "SWITCH + v1.5-bump"
        verdict_sentence = (
            f"Flat-60 demotes **{flat_lossy_pct:.2f}%** of Billboard tokens "
            f"(> 30% threshold). **SWITCH** to the factored head AND flag the "
            f"decision record for a v1.5 bump."
        )

    lines: list[str] = []
    lines.append("# Experiment A - Alphabet Collapse Audit on McGill Billboard")
    lines.append("")
    lines.append(f"**Verdict:** {verdict}. {verdict_sentence}")
    lines.append("")
    lines.append(f"**Source:** {source_label}")
    lines.append(f"**Bundle sha256:** `{sha256}`")
    lines.append(
        f"**Corpus:** {total_tokens:,} chord tokens, "
        f"{total_time/60:.1f} minutes of annotated audio"
    )
    lines.append("")
    lines.append("## Table 1 - Token-level outcomes under each alphabet")
    lines.append("")
    lines.append("| Alphabet | Exact | Lossy (collapsed) | X (dropped) | Total |")
    lines.append("|---|---|---|---|---|")
    lines.append(
        f"| Flat 60 | {flat.exact_tokens:,} "
        f"({_pct(flat.exact_tokens, total_tokens)}) "
        f"| {flat.lossy_tokens:,} "
        f"({_pct(flat.lossy_tokens, total_tokens)}) "
        f"| {flat.x_tokens:,} "
        f"({_pct(flat.x_tokens, total_tokens)}) "
        f"| {total_tokens:,} (100%) |"
    )
    lines.append(
        f"| Factored 25x13 | {fact.exact_tokens:,} "
        f"({_pct(fact.exact_tokens, total_tokens)}) "
        f"| {fact.lossy_tokens:,} "
        f"({_pct(fact.lossy_tokens, total_tokens)}) "
        f"| {fact.x_tokens:,} "
        f"({_pct(fact.x_tokens, total_tokens)}) "
        f"| {total_tokens:,} (100%) |"
    )
    lines.append("")

    # Top 20 lossy qualities under Flat 60.
    lines.append("## Table 2 - Top 20 lossiest input qualities under Flat 60")
    lines.append("")
    lines.append(
        "| Rank | Original quality | Token count | % of corpus "
        "| Collapsed to | Information lost |"
    )
    lines.append("|---|---|---|---|---|---|")
    top_flat = report["lossy_bucket_flat"].most_common(20)
    for i, (bucket, count) in enumerate(top_flat, start=1):
        collapsed, info = report["lossy_detail_flat"][bucket]
        lines.append(
            f"| {i} | `{bucket}` | {count:,} "
            f"| {_pct(count, total_tokens)} | `{collapsed}` "
            f"| {info} |"
        )
    if not top_flat:
        lines.append("| - | - | - | - | - | - |")
    lines.append("")

    # Top 10 lossy qualities under factored.
    lines.append("## Table 2b - Top 10 lossiest input qualities under Factored 25x13")
    lines.append("")
    lines.append(
        "| Rank | Original quality | Token count | % of corpus "
        "| Collapsed to | Information lost |"
    )
    lines.append("|---|---|---|---|---|---|")
    top_fact = report["lossy_bucket_fact"].most_common(10)
    for i, (bucket, count) in enumerate(top_fact, start=1):
        collapsed, info = report["lossy_detail_fact"][bucket]
        lines.append(
            f"| {i} | `{bucket}` | {count:,} "
            f"| {_pct(count, total_tokens)} | `{collapsed}` "
            f"| {info} |"
        )
    if not top_fact:
        lines.append("| - | - | - | - | - | - |")
    lines.append("")

    # Table 3: information retained.
    flat_retained = 100 * flat.exact_tokens / max(1, total_tokens)
    fact_retained = 100 * fact.exact_tokens / max(1, total_tokens)
    lines.append("## Table 3 - Information retained by each alphabet (token-level)")
    lines.append("")
    lines.append("| Alphabet | Exact-match tokens | Preserved share |")
    lines.append("|---|---|---|")
    lines.append(
        f"| Flat 60 | {flat.exact_tokens:,} / {total_tokens:,} "
        f"| {flat_retained:.2f}% |"
    )
    lines.append(
        f"| Factored 25x13 | {fact.exact_tokens:,} / {total_tokens:,} "
        f"| {fact_retained:.2f}% |"
    )
    lines.append(
        f"| Full 170-class (baseline) | {total_tokens:,} / "
        f"{total_tokens:,} | 100.00% |"
    )
    lines.append("")

    # Table 4: duration-weighted (playback time).
    flat_lossy_time = 100 * flat.lossy_time / max(1e-9, total_time)
    flat_x_time = 100 * flat.x_time / max(1e-9, total_time)
    fact_lossy_time = 100 * fact.lossy_time / max(1e-9, total_time)
    fact_x_time = 100 * fact.x_time / max(1e-9, total_time)
    lines.append("## Table 4 - User-visible impact (duration-weighted)")
    lines.append("")
    lines.append("| Alphabet | Exact | Lossy | X |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| Flat 60 | {100 - flat_lossy_time - flat_x_time:.2f}% "
        f"| {flat_lossy_time:.2f}% | {flat_x_time:.2f}% |"
    )
    lines.append(
        f"| Factored 25x13 | "
        f"{100 - fact_lossy_time - fact_x_time:.2f}% "
        f"| {fact_lossy_time:.2f}% | {fact_x_time:.2f}% |"
    )
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append(
        "- Source: ChoCo (CC BY 4.0) re-packaging of McGill Billboard "
        "chord annotations, which preserve full Harte labels."
    )
    lines.append(
        "- Reproducible via "
        "`python scripts/alphabet_collapse_audit.py --jams-dir <path>`."
    )
    lines.append(
        "- See `claude/phase-2-y1-chord-model-redteam-alphabet-cqt.md` "
        "for the alphabet definitions and the thresholds this verdict "
        "uses."
    )
    return "\n".join(lines) + "\n"


def _bundle_sha256(path: str) -> str:
    import hashlib

    h = hashlib.sha256()
    if os.path.isdir(path):
        # Hash concatenation of per-file sha256 hex over sorted filename.
        for fp in sorted(glob.glob(os.path.join(path, "*"))):
            inner = hashlib.sha256()
            with open(fp, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    inner.update(chunk)
            h.update((inner.hexdigest() + "  " + os.path.basename(fp) + "\n").encode())
        return h.hexdigest()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--jams-dir", help="directory of ChoCo-style .jams files")
    g.add_argument("--lab-dir", help="directory of McGill Billboard .lab files")
    ap.add_argument("--out", default="-", help="output markdown (- for stdout)")
    ap.add_argument(
        "--source-label", default=None, help="label to embed in the report header"
    )
    args = ap.parse_args(argv)

    if args.jams_dir:
        tokens = list(iter_jams(args.jams_dir))
        source_dir = args.jams_dir
        src_label = args.source_label or f"ChoCo JAMS @ {args.jams_dir}"
    else:
        tokens = list(iter_labs(args.lab_dir))
        source_dir = args.lab_dir
        src_label = args.source_label or f"Billboard LAB @ {args.lab_dir}"

    if not tokens:
        print("ERROR: no chord tokens found", file=sys.stderr)
        return 1

    sha = _bundle_sha256(source_dir)
    report = run_audit(tokens)
    text = render_markdown(report, src_label, sha)

    if args.out == "-":
        sys.stdout.write(text)
    else:
        with open(args.out, "w") as f:
            f.write(text)
        print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
