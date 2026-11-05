"""Pitch-shift augmentation: audio + aligned Harte labels, same number of semitones.

A trained chord recognizer has to generalize across keys. Pitch-shifting
rendered audio and rewriting its chord labels the same amount is the
cheapest, highest-signal augmentation available to us: one render of
``C:maj → G:maj`` becomes twelve, covering every tonal centre, for the cost
of a librosa phase-vocoder pass and a string rewrite.

CLI::

    python -m training.data.pitch_shift_aug \\
        --in apps/training/data/cache/synthetic \\
        --range -5..+6 \\
        --prob 0.9 \\
        --seed 42

For each ``.wav`` under ``--in`` with a matching ``.lab``, with probability
``--prob`` we draw a shift from the inclusive integer range and write both
the shifted audio and the shifted labels under
``<in>/shifted/<n>_<stem>.{wav,lab}``.

The root rewriter accepts any Harte root spelled with sharps or flats
(``A``, ``F#``, ``Bb``), rewrites to sharps on ambiguity, and keeps the
quality tag (``:min``, ``:maj7``, ``:hdim7`` …) unchanged.

Offline tooling; not imported by ``apps/web`` or ``apps/worker``.
"""

from __future__ import annotations

import argparse
import logging
import random
import re
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("training.data.pitch_shift_aug")

# ─────────────────────────────────────────────────────────────────────────────
# Root pitch-class table. Index == semitone from C.
# ─────────────────────────────────────────────────────────────────────────────

_SHARP_NAMES: tuple[str, ...] = (
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

# Map every spelling we accept on input to its pitch class (0 = C). Flats
# fold onto their enharmonic sharp; the output always uses sharps.
_INPUT_NAME_TO_PITCH_CLASS: dict[str, int] = {
    "C": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "Fb": 4,
    "E#": 5,
    "F": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
    "Cb": 11,
    "B#": 0,
}

# Root is: A–G, optional # or b. The strict spelling is validated against the
# table above; the regex is just the shape.
_ROOT_PATTERN = re.compile(r"^([A-G])([#b])?")


# ─────────────────────────────────────────────────────────────────────────────
# Harte helpers.
# ─────────────────────────────────────────────────────────────────────────────


def _parse_root(symbol: str) -> tuple[str, str]:
    """Return ``(root_text, remainder)`` splitting the leading note name off.

    ``remainder`` keeps the Harte quality tag (``':min'``, ``':maj7'``, …)
    plus any bass or extension suffix (``'/G'``, ``'(9)'``), both passed
    through unchanged by the shifter.
    """
    m = _ROOT_PATTERN.match(symbol)
    if not m:
        raise ValueError(f"Not a Harte chord symbol: {symbol!r}")
    root_text = m.group(1) + (m.group(2) or "")
    remainder = symbol[m.end() :]
    return root_text, remainder


def _root_to_pitch_class(root_text: str) -> int:
    """Translate a root spelling to a pitch class, folding flats onto sharps."""
    try:
        return _INPUT_NAME_TO_PITCH_CLASS[root_text]
    except KeyError as e:
        raise ValueError(f"Unknown chord root spelling: {root_text!r}") from e


def _pitch_class_to_sharp(pc: int) -> str:
    """Return the sharp spelling of a pitch class in ``[0, 11]``."""
    return _SHARP_NAMES[pc % 12]


# Harte has a handful of reserved symbols that are not pitch-bearing; a shift
# is a no-op on them.
_NON_PITCHED = frozenset({"N", "X"})


def shift_harte_symbol(symbol: str, semitones: int) -> str:
    """Transpose a Harte chord symbol by ``semitones``.

    Pass-through for the reserved ``N`` (no chord) and ``X`` (unknown)
    labels. The quality + bass + extension tail is preserved verbatim.
    """
    base = symbol.strip()
    if base in _NON_PITCHED or base == "":
        return base
    root_text, remainder = _parse_root(base)
    pc = _root_to_pitch_class(root_text)
    new_root = _pitch_class_to_sharp(pc + semitones)
    return new_root + remainder


def shift_lab_file(lab_path: Path, semitones: int, out_path: Path) -> None:
    """Read a Harte ``.lab`` file, shift every chord symbol, write a new file."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_lines: list[str] = []
    with lab_path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) != 3:
                # Tolerate space-separated .lab variants.
                parts = line.split()
                if len(parts) != 3:
                    log.warning("ignoring malformed .lab line in %s: %r", lab_path, line)
                    continue
            start, end, symbol = parts
            out_lines.append(f"{start}\t{end}\t{shift_harte_symbol(symbol, semitones)}")
    out_path.write_text("\n".join(out_lines) + ("\n" if out_lines else ""), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Audio shifting.
# ─────────────────────────────────────────────────────────────────────────────


def shift_audio_file(audio_path: Path, semitones: int, out_path: Path) -> None:
    """Pitch-shift ``audio_path`` by ``semitones`` and write ``out_path``.

    Thin wrapper around ``librosa.effects.pitch_shift`` so the tests can mock
    it. Preserves the original sample rate.
    """
    import librosa
    import numpy as np
    import soundfile as sf

    y, sr = librosa.load(str(audio_path), sr=None, mono=True)
    shifted = librosa.effects.pitch_shift(y=y, sr=sr, n_steps=semitones)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), np.asarray(shifted, dtype=np.float32), sr)


def pitch_shift_audio_and_labels(
    audio_path: Path,
    lab_path: Path,
    semitones: int,
    out_dir: Path,
) -> tuple[Path, Path]:
    """Shift ``audio_path`` + ``lab_path`` by ``semitones`` into ``out_dir``.

    Returns the ``(new_audio_path, new_lab_path)`` tuple. Files are named
    ``<sign><abs>_<stem>.{wav,lab}`` where ``sign`` is ``p`` for positive
    shifts and ``m`` for negative — avoids filesystem-unsafe ``+``/``-``
    prefixes while staying readable.
    """
    sign_tag = f"p{semitones}" if semitones >= 0 else f"m{abs(semitones)}"
    stem = audio_path.stem
    new_audio = out_dir / f"{sign_tag}_{stem}.wav"
    new_lab = out_dir / f"{sign_tag}_{stem}.lab"
    shift_audio_file(audio_path, semitones, new_audio)
    shift_lab_file(lab_path, semitones, new_lab)
    return new_audio, new_lab


# ─────────────────────────────────────────────────────────────────────────────
# CLI driver.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SemitoneRange:
    """Inclusive integer range of semitone shifts: ``[low, high]``."""

    low: int
    high: int

    def __post_init__(self) -> None:
        if self.low > self.high:
            raise ValueError(f"empty range: {self.low}..{self.high}")

    def sample(self, rng: random.Random) -> int:
        """Return a random integer in ``[low, high]``."""
        return rng.randint(self.low, self.high)


def parse_range(spec: str) -> SemitoneRange:
    """Parse a ``'-5..+6'``-style range spec into a :class:`SemitoneRange`."""
    if ".." not in spec:
        raise argparse.ArgumentTypeError(
            f"Bad range spec {spec!r}; expected 'low..high' (e.g. '-5..+6')."
        )
    low_s, high_s = spec.split("..", 1)
    try:
        return SemitoneRange(int(low_s), int(high_s))
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"Bad range spec {spec!r}") from e


def _iter_pairs(root: Path) -> list[tuple[Path, Path]]:
    """Enumerate ``(audio, label)`` pairs under ``root`` that are both present."""
    pairs: list[tuple[Path, Path]] = []
    for wav in sorted(root.rglob("*.wav")):
        lab = wav.with_suffix(".lab")
        if lab.exists():
            pairs.append((wav, lab))
    return pairs


def build_parser() -> argparse.ArgumentParser:
    """CLI parser documented in the module docstring."""
    p = argparse.ArgumentParser(
        prog="python -m training.data.pitch_shift_aug",
        description="Pitch-shift synthetic renders and their Harte .lab files.",
    )
    p.add_argument(
        "--in",
        dest="in_dir",
        type=Path,
        required=True,
        help="Directory holding rendered (.wav, .lab) pairs.",
    )
    p.add_argument(
        "--range",
        dest="range_spec",
        type=parse_range,
        default=parse_range("-5..+6"),
        help="Inclusive integer semitone range (default '-5..+6').",
    )
    p.add_argument(
        "--prob",
        type=float,
        default=0.9,
        help="Per-file probability of generating a shifted pair (default 0.9).",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=42,
        help="RNG seed for deterministic augmentation (default 42).",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output dir; defaults to <--in>/shifted.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not args.in_dir.exists():
        print(f"No such input directory: {args.in_dir}", file=sys.stderr)
        return 2

    out_dir = args.out or (args.in_dir / "shifted")
    pairs = _iter_pairs(args.in_dir)
    if not pairs:
        print(f"No (.wav, .lab) pairs found under {args.in_dir}", file=sys.stderr)
        return 2

    rng = random.Random(args.seed)
    for wav, lab in pairs:
        if rng.random() > args.prob:
            continue
        semitones = args.range_spec.sample(rng)
        try:
            new_audio, new_lab = pitch_shift_audio_and_labels(wav, lab, semitones, out_dir)
        except Exception as e:  # noqa: BLE001 — best-effort augmentation
            log.warning("shift failed for %s (%+d): %s", wav, semitones, e)
            continue
        log.info("shifted %s by %+d → %s", wav.name, semitones, new_audio.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
