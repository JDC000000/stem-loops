<<<<<<< HEAD
<<<<<<< HEAD
"""Synthetic rendering: MusicXML / lead-sheet → aligned audio + Harte chord labels.

Per the V3-Phase-2 Y1 decision (``claude/phase-2-y1-chord-model-decision.md``
v1.3 — SheetSage2 synthetic recipe), this module turns a corpus of public-
domain MusicXML scores (PDMX ``no_license_conflict`` + OpenEWLD) into the
``(audio.wav, labels.lab)`` pairs the ChordNet student trains on.

Pipeline per score::

    MusicXML
      └─▶ music21.converter.parse            (symbolic score)
            └─▶ extract <harmony> chord symbols with onset/offset in beats
                  └─▶ score.toStream().write("midi")   via music21 → .mid
                        └─▶ pyFluidSynth render at 24 kHz mono WAV
                              (soundfont picked per --soundfont or rotated)
                  └─▶ chord timeline rewritten to SECONDS via tempo map
                        └─▶ Harte-format .lab file (seconds, Harte symbol)
      └─▶ MANIFEST.jsonl entry:
            {score_file, score_sha, soundfont, soundfont_sha,
             audio_path, lab_path, duration_sec,
             score_license, soundfont_license}

**Legal bedrock** (from the decision record readout): every soundfont we
rotate through is permissively licensed — MIT, CC0, or CC-BY 3.0 with
attribution carried in :data:`SOUNDFONTS` and reproduced in
``DATA-PROVENANCE.md`` the moment any soundfont is actually fetched. No
proprietary or NC-licensed soundfont enters the rotation.

This module is offline tooling. ``apps/web`` and ``apps/worker`` do not
import it at runtime.
=======
"""Synthetic rendering: MusicXML / lead-sheet -> aligned audio + chord labels.
=======
"""Synthetic rendering: MusicXML / lead-sheet → aligned audio + Harte chord labels.
>>>>>>> origin/v3/main

Per the V3-Phase-2 Y1 decision (``claude/phase-2-y1-chord-model-decision.md``
v1.3 — SheetSage2 synthetic recipe), this module turns a corpus of public-
domain MusicXML scores (PDMX ``no_license_conflict`` + OpenEWLD) into the
``(audio.wav, labels.lab)`` pairs the ChordNet student trains on.

Pipeline per score::

<<<<<<< HEAD
PR-Y1.2 ships the module shell so the import surface is stable and the
provenance doc can reference it. The renderer itself lands in PR-Y1.3.
>>>>>>> origin/v3/main
=======
    MusicXML
      └─▶ music21.converter.parse            (symbolic score)
            └─▶ extract <harmony> chord symbols with onset/offset in beats
                  └─▶ score.toStream().write("midi")   via music21 → .mid
                        └─▶ pyFluidSynth render at 24 kHz mono WAV
                              (soundfont picked per --soundfont or rotated)
                  └─▶ chord timeline rewritten to SECONDS via tempo map
                        └─▶ Harte-format .lab file (seconds, Harte symbol)
      └─▶ MANIFEST.jsonl entry:
            {score_file, score_sha, soundfont, soundfont_sha,
             audio_path, lab_path, duration_sec,
             score_license, soundfont_license}

**Legal bedrock** (from the decision record readout): every soundfont we
rotate through is permissively licensed — MIT, CC0, or CC-BY 3.0 with
attribution carried in :data:`SOUNDFONTS` and reproduced in
``DATA-PROVENANCE.md`` the moment any soundfont is actually fetched. No
proprietary or NC-licensed soundfont enters the rotation.

This module is offline tooling. ``apps/web`` and ``apps/worker`` do not
import it at runtime.
>>>>>>> origin/v3/main
"""

from __future__ import annotations

<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
import argparse
import hashlib
import json
import logging
import os
import random
import sys
import wave
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
<<<<<<< HEAD

log = logging.getLogger("training.data.synthetic_render")

# Target audio format for rendered WAVs. 24 kHz mono matches the SheetSage2
# recipe and resamples cleanly to the CQT plan's 22 050 Hz.
RENDER_SAMPLE_RATE = 24000
RENDER_CHANNELS = 1

MANIFEST_FILENAME = "MANIFEST.jsonl"


# ─────────────────────────────────────────────────────────────────────────────
# Soundfont registry — only permissively licensed entries allowed.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SoundFont:
    """One permissively licensed soundfont we're willing to render through."""

    name: str
    """Short slug used on the CLI, e.g. ``'fluidr3'``."""

    license: str
    """SPDX-ish license tag."""

    url: str
    """Canonical download URL (not fetched here — see ``data/download.py``)."""

    attribution: str
    """Attribution text required by the license, verbatim."""


SOUNDFONTS: dict[str, SoundFont] = {
    "fluidr3": SoundFont(
        name="fluidr3",
        license="MIT",
        url="https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2",
        attribution="FluidR3_GM by Frank Wen, released under the MIT License.",
    ),
    "musescore_general": SoundFont(
        name="musescore_general",
        license="MIT",
        url="https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3",
        attribution=(
            "MuseScore_General by S. Christian Collins et al., released "
            "under the MIT License via the MuseScore project."
        ),
    ),
    "vsco2": SoundFont(
        name="vsco2",
        license="CC0-1.0",
        url="https://github.com/sgossner/VSCO-2-CE",
        attribution=(
            "VSCO 2 Community Edition by Simon Dalzell / VersilStudios, " "released under CC0-1.0."
        ),
    ),
    "vcsl": SoundFont(
        name="vcsl",
        license="CC0-1.0",
        url="https://github.com/sgossner/VCSL",
        attribution="Versilian Community Sample Library (VCSL), released under CC0-1.0.",
    ),
    "salamander": SoundFont(
        name="salamander",
        license="CC-BY-3.0",
        url="https://sfzinstruments.github.io/pianos/salamander/",
        attribution=(
            "Salamander Grand Piano by Alexander Holm, released under "
            "CC-BY-3.0. Credit: Alexander Holm, salamander grand piano."
        ),
    ),
}

DEFAULT_SOUNDFONT = "fluidr3"


# ─────────────────────────────────────────────────────────────────────────────
# Dataclasses + small helpers.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ChordEvent:
    """One chord with onset/offset expressed in seconds."""

    start_sec: float
    end_sec: float
    harte: str

    def to_lab_line(self) -> str:
        """Render a Harte ``.lab`` line: ``<start>\\t<end>\\t<symbol>``."""
        return f"{self.start_sec:.6f}\t{self.end_sec:.6f}\t{self.harte}"


@dataclass
class RenderResult:
    """What a single successful render produced."""

    score_file: str
    score_sha: str
    soundfont: str
    soundfont_sha: str
    audio_path: str
    lab_path: str
    duration_sec: float
    score_license: str
    soundfont_license: str
    chord_events: list[ChordEvent] = field(default_factory=list)

    def to_manifest_entry(self) -> dict[str, object]:
        """Serialize to the JSONL schema documented in the module docstring."""
        return {
            "score_file": self.score_file,
            "score_sha": self.score_sha,
            "soundfont": self.soundfont,
            "soundfont_sha": self.soundfont_sha,
            "audio_path": self.audio_path,
            "lab_path": self.lab_path,
            "duration_sec": self.duration_sec,
            "score_license": self.score_license,
            "soundfont_license": self.soundfont_license,
            "rendered_at": datetime.now(UTC).isoformat(),
        }


def _sha256_of(path: Path) -> str:
    """SHA-256 of a file (streamed, 1 MiB chunks)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# Harte-label extraction and tempo-map resolution.
# ─────────────────────────────────────────────────────────────────────────────


# Deliberate, self-contained translation of music21's ChordSymbol figure
# into the Harte `.lab` grammar the Billboard / BTC families use. The full
# Harte grammar is larger; this subset covers every quality music21 emits by
# default and is where follow-up PRs will extend coverage.
_HARTE_QUALITY_MAP: dict[str, str] = {
    "major": "maj",
    "major-seventh": "maj7",
    "major-sixth": "maj6",
    "minor": "min",
    "minor-seventh": "min7",
    "minor-sixth": "min6",
    "minor-major-seventh": "minmaj7",
    "dominant": "7",
    "dominant-seventh": "7",
    "augmented": "aug",
    "augmented-seventh": "aug7",
    "diminished": "dim",
    "diminished-seventh": "dim7",
    "half-diminished": "hdim7",
    "suspended-fourth": "sus4",
    "suspended-second": "sus2",
    "power": "5",
    "pedal": "1",
    "other": "maj",
}


def chord_symbol_to_harte(root_name: str, quality_tag: str) -> str:
    """Translate a (root, quality_tag) pair to a Harte-format chord symbol.

    ``root_name`` is spelled in music21's natural convention (e.g. ``'C'``,
    ``'F#'``, ``'Bb'``). ``quality_tag`` is one of the keys of
    :data:`_HARTE_QUALITY_MAP`. Unknown qualities fall through to ``'maj'``
    rather than failing — the rendered audio is still useful for downstream
    augmentation, and the log line records the fallback so we can audit.
    """
    harte_quality = _HARTE_QUALITY_MAP.get(quality_tag)
    if harte_quality is None:
        log.warning(
            "unknown chord quality %r — falling back to 'maj'. Add it to "
            "_HARTE_QUALITY_MAP when safe.",
            quality_tag,
        )
        harte_quality = "maj"
    if harte_quality == "maj":
        return root_name
    return f"{root_name}:{harte_quality}"


def extract_chord_events(
    score: object,  # a music21.stream.Score; typed as object to avoid an import
) -> list[ChordEvent]:
    """Extract Harte-labelled chord events in SECONDS from a parsed music21 score.

    Walks the score for ``<harmony>`` entries (``music21.harmony.ChordSymbol``),
    resolves each offset/duration to wall-clock seconds via the score's tempo
    map, and produces a dense timeline with no gaps.

    The caller is expected to have already parsed the score with
    ``music21.converter.parse(...)``. This function does no I/O itself,
    which is what lets the tests mock it with a trivial stand-in.
    """
    # Local import keeps this module importable without music21 installed, which
    # matters for the tests that mock the whole pipeline.
    from music21 import harmony  # type: ignore[import-not-found]

    flat = score.flatten()
    chord_symbols = [el for el in flat.getElementsByClass(harmony.ChordSymbol)]
    if not chord_symbols:
        return []

    total_quarter_length = float(flat.highestTime)
    events: list[ChordEvent] = []

    for i, cs in enumerate(chord_symbols):
        onset_ql = float(cs.offset)
        if i + 1 < len(chord_symbols):
            offset_ql = float(chord_symbols[i + 1].offset)
        else:
            offset_ql = total_quarter_length
        if offset_ql <= onset_ql:
            # Degenerate / zero-length chord entry — skip rather than emit a
            # bad frame; this is extremely rare in PDMX / OpenEWLD content.
            continue
        start_sec = _quarter_length_to_seconds(score, onset_ql)
        end_sec = _quarter_length_to_seconds(score, offset_ql)
        root_name = cs.root().name if cs.root() is not None else "C"
        quality_tag = (cs.chordKind or "major").lower()
        harte = chord_symbol_to_harte(root_name, quality_tag)
        events.append(ChordEvent(start_sec=start_sec, end_sec=end_sec, harte=harte))
    return events


def _quarter_length_to_seconds(score: object, quarter_length: float) -> float:
    """Resolve a quarter-length offset to seconds using ``score``'s tempo map.

    music21 exposes ``score.secondsMap`` which maps elements to seconds; for
    a bare offset we evaluate the local tempo in effect at that offset and
    convert. The helper is isolated so the tests can replace it with a flat
    120 BPM mapping without touching the rest of the pipeline.
    """
    try:
        from music21 import tempo  # type: ignore[import-not-found]
    except ImportError:
        # Fallback used in test paths that have not installed music21.
        return quarter_length * 0.5  # 120 BPM equivalent

    metronomes = score.flatten().getElementsByClass(tempo.MetronomeMark)
    if not metronomes:
        # Default music21 tempo is 120 BPM = 0.5 s per quarter note.
        return quarter_length * 0.5

    # Walk the tempo map, accumulating seconds for each segment up to our
    # target offset. This is O(n_tempo_changes) and fine for scores with
    # at most a handful of tempo changes (PDMX typical).
    seconds = 0.0
    prev_offset = 0.0
    prev_bpm = 120.0
    for mm in metronomes:
        mm_offset = float(mm.offset)
        if mm_offset >= quarter_length:
            break
        seconds += (mm_offset - prev_offset) * (60.0 / prev_bpm)
        prev_offset = mm_offset
        prev_bpm = float(mm.number or 120.0)
    seconds += (quarter_length - prev_offset) * (60.0 / prev_bpm)
    return seconds


def write_lab_file(path: Path, events: list[ChordEvent]) -> None:
    """Write Harte ``.lab`` lines to ``path`` (tab-separated, one per line)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ev in events:
            f.write(ev.to_lab_line() + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# Audio rendering — pyFluidSynth wrapped so the tests can mock it cheaply.
# ─────────────────────────────────────────────────────────────────────────────


def render_midi_to_wav(
    midi_path: Path,
    soundfont_path: Path,
    audio_path: Path,
    *,
    sample_rate: int = RENDER_SAMPLE_RATE,
) -> float:
    """Render ``midi_path`` through ``soundfont_path`` into a mono WAV.

    Returns the rendered duration in seconds. The pyFluidSynth driver is
    imported lazily so this module is importable on CI where FluidSynth is
    not installed.
    """
    import numpy as np  # local import — see module docstring
    import pretty_midi  # type: ignore[import-not-found]

    # pyFluidSynth is imported as `fluidsynth` at the module level, so this
    # local import keeps the rest of the training package happy without it.
    try:
        import fluidsynth  # type: ignore[import-not-found]  # noqa: F401
    except ImportError as e:  # pragma: no cover - exercised only in prod envs
        raise RuntimeError(
            "pyFluidSynth is not installed; install the training extras "
            "(pip install -e apps/training) and ensure libfluidsynth is "
            "available on the system."
        ) from e

    midi = pretty_midi.PrettyMIDI(str(midi_path))
    audio = midi.fluidsynth(fs=sample_rate, sf2_path=str(soundfont_path))
    # Mix to mono if needed; pretty_midi.fluidsynth returns mono float64.
    audio = np.asarray(audio, dtype=np.float32)
    duration_sec = len(audio) / float(sample_rate)
    _write_mono_wav(audio_path, audio, sample_rate)
    return duration_sec


def _write_mono_wav(path: Path, audio: object, sample_rate: int) -> None:
    """Write ``audio`` (float32 in [-1, 1]) to ``path`` as a 16-bit mono WAV."""
    import numpy as np

    arr = np.asarray(audio, dtype=np.float32)
    # Clip and convert to int16.
    clipped = np.clip(arr, -1.0, 1.0)
    int16 = (clipped * 32767.0).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(RENDER_CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(int16.tobytes())


# ─────────────────────────────────────────────────────────────────────────────
# Top-level per-score render routine.
# ─────────────────────────────────────────────────────────────────────────────


def _parse_score(score_path: Path) -> object:
    """Thin seam around ``music21.converter.parse``.

    Isolated at module scope so the tests can replace it wholesale without
    needing music21 importable. Production code imports music21 lazily
    inside this function.
    """
    from music21 import converter  # type: ignore[import-not-found]

    return converter.parse(str(score_path))


def render_score(
    score_path: Path,
    out_dir: Path,
    *,
    soundfont_name: str,
    soundfont_path: Path,
    score_license: str,
    sample_rate: int = RENDER_SAMPLE_RATE,
) -> RenderResult:
    """Render one MusicXML score to WAV + Harte .lab under ``out_dir``.

    The output filenames are derived from the score's stem (so re-rendering
    a given score deterministically overwrites its last outputs). The MIDI
    intermediate is written next to the audio as ``<stem>.mid`` for
    debugging — it's cheap and eases human spot-checking.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = score_path.stem
    midi_path = out_dir / f"{stem}.mid"
    audio_path = out_dir / f"{stem}.wav"
    lab_path = out_dir / f"{stem}.lab"

    log.info("rendering score %s with soundfont %s", score_path, soundfont_name)
    score = _parse_score(score_path)

    # 1. Chord-event timeline in seconds.
    events = extract_chord_events(score)
    write_lab_file(lab_path, events)

    # 2. MIDI render (music21 → .mid) and FluidSynth render (.mid → .wav).
    score.write("midi", fp=str(midi_path))
    duration_sec = render_midi_to_wav(
        midi_path,
        soundfont_path,
        audio_path,
        sample_rate=sample_rate,
    )

    soundfont = SOUNDFONTS[soundfont_name]
    return RenderResult(
        score_file=str(score_path),
        score_sha=_sha256_of(score_path),
        soundfont=soundfont_name,
        soundfont_sha=_sha256_of(soundfont_path),
        audio_path=str(audio_path),
        lab_path=str(lab_path),
        duration_sec=duration_sec,
        score_license=score_license,
        soundfont_license=soundfont.license,
        chord_events=events,
    )


def append_manifest(manifest_path: Path, result: RenderResult) -> None:
    """Append ``result`` to ``manifest_path`` as one JSON line."""
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    entry = result.to_manifest_entry()
    with manifest_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# CLI.
# ─────────────────────────────────────────────────────────────────────────────


def _pick_soundfont(name: str | None, rng: random.Random) -> str:
    """Resolve ``--soundfont`` to a concrete slug, rotating when unset."""
    if name is None:
        return rng.choice(list(SOUNDFONTS.keys()))
    if name not in SOUNDFONTS:
        raise SystemExit(f"Unknown soundfont {name!r}. Known: {sorted(SOUNDFONTS.keys())}")
    return name


def _iter_score_files(score_root: Path) -> list[Path]:
    """Return all MusicXML files under ``score_root`` (sorted for determinism)."""
    if not score_root.exists():
        return []
    patterns = ("*.musicxml", "*.mxl", "*.xml")
    found: list[Path] = []
    for pattern in patterns:
        found.extend(score_root.rglob(pattern))
    return sorted(found)


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argparse surface documented in the module docstring."""
    p = argparse.ArgumentParser(
        prog="python -m training.data.synthetic_render",
        description="Render MusicXML scores to aligned audio + Harte chord labels.",
    )
    p.add_argument(
        "--count",
        type=int,
        default=1000,
        help="Maximum number of scores to render (default: 1000).",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=Path("apps/training/data/cache/synthetic"),
        help="Output directory for rendered audio/labels/manifest.",
    )
    p.add_argument(
        "--scores",
        type=Path,
        default=None,
        help=(
            "Root directory of MusicXML scores. Defaults to the "
            "PDMX no_license_conflict subset under the training cache."
        ),
    )
    p.add_argument(
        "--soundfont",
        default=None,
        help=(
            "Soundfont slug (fluidr3, musescore_general, vsco2, vcsl, "
            "salamander). Omitted = rotate randomly per score."
        ),
    )
    p.add_argument(
        "--soundfont-path",
        type=Path,
        default=None,
        help="Path to the .sf2 file. Defaults to TRAINING_SOUNDFONT_PATH env.",
    )
    p.add_argument(
        "--score-license",
        default="CC-BY-4.0",
        help="SPDX-ish license tag for the score corpus (default PDMX CC-BY-4.0).",
    )
    p.add_argument(
        "--jobs",
        type=int,
        default=int(os.environ.get("TRAINING_RENDER_JOBS", "1")),
        help=(
            "Parallel worker count (reserved for a future pool; the current " "CLI runs serially)."
        ),
    )
    p.add_argument(
        "--seed",
        type=int,
        default=0,
        help="RNG seed for soundfont rotation. Deterministic rendering.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; returns a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    rng = random.Random(args.seed)

    scores_root = args.scores or Path("apps/training/data/cache/pdmx/no_license_conflict")
    score_files = _iter_score_files(scores_root)[: args.count]
    if not score_files:
        print(
            f"No MusicXML files found under {scores_root}. "
            "Run `python -m training.data.download --source pdmx --confirm` "
            "first.",
            file=sys.stderr,
        )
        return 2

    soundfont_path = args.soundfont_path or Path(
        os.environ.get("TRAINING_SOUNDFONT_PATH", "apps/training/data/cache/soundfonts/fluidr3.sf2")
    )
    if not soundfont_path.exists():
        print(f"Soundfont not found at {soundfont_path}.", file=sys.stderr)
        return 3

    manifest_path = args.out / MANIFEST_FILENAME
    for score_path in score_files:
        sf_name = _pick_soundfont(args.soundfont, rng)
        try:
            result = render_score(
                score_path,
                args.out,
                soundfont_name=sf_name,
                soundfont_path=soundfont_path,
                score_license=args.score_license,
            )
        except Exception as e:  # noqa: BLE001 — render failures logged but non-fatal
            log.warning("render failed for %s: %s", score_path, e)
            continue
        append_manifest(manifest_path, result)
        log.info("rendered %s (%.1fs, %s)", score_path.name, result.duration_sec, sf_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
=======
=======
>>>>>>> origin/v3/main

log = logging.getLogger("training.data.synthetic_render")

# Target audio format for rendered WAVs. 24 kHz mono matches the SheetSage2
# recipe and resamples cleanly to the CQT plan's 22 050 Hz.
RENDER_SAMPLE_RATE = 24000
RENDER_CHANNELS = 1

MANIFEST_FILENAME = "MANIFEST.jsonl"


# ─────────────────────────────────────────────────────────────────────────────
# Soundfont registry — only permissively licensed entries allowed.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SoundFont:
    """One permissively licensed soundfont we're willing to render through."""

    name: str
    """Short slug used on the CLI, e.g. ``'fluidr3'``."""

    license: str
    """SPDX-ish license tag."""

    url: str
    """Canonical download URL (not fetched here — see ``data/download.py``)."""

    attribution: str
    """Attribution text required by the license, verbatim."""


SOUNDFONTS: dict[str, SoundFont] = {
    "fluidr3": SoundFont(
        name="fluidr3",
        license="MIT",
        url="https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2",
        attribution="FluidR3_GM by Frank Wen, released under the MIT License.",
    ),
    "musescore_general": SoundFont(
        name="musescore_general",
        license="MIT",
        url="https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3",
        attribution=(
            "MuseScore_General by S. Christian Collins et al., released "
            "under the MIT License via the MuseScore project."
        ),
    ),
    "vsco2": SoundFont(
        name="vsco2",
        license="CC0-1.0",
        url="https://github.com/sgossner/VSCO-2-CE",
        attribution=(
            "VSCO 2 Community Edition by Simon Dalzell / VersilStudios, " "released under CC0-1.0."
        ),
    ),
    "vcsl": SoundFont(
        name="vcsl",
        license="CC0-1.0",
        url="https://github.com/sgossner/VCSL",
        attribution="Versilian Community Sample Library (VCSL), released under CC0-1.0.",
    ),
    "salamander": SoundFont(
        name="salamander",
        license="CC-BY-3.0",
        url="https://sfzinstruments.github.io/pianos/salamander/",
        attribution=(
            "Salamander Grand Piano by Alexander Holm, released under "
            "CC-BY-3.0. Credit: Alexander Holm, salamander grand piano."
        ),
    ),
}

DEFAULT_SOUNDFONT = "fluidr3"


# ─────────────────────────────────────────────────────────────────────────────
# Dataclasses + small helpers.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ChordEvent:
    """One chord with onset/offset expressed in seconds."""

    start_sec: float
    end_sec: float
    harte: str

    def to_lab_line(self) -> str:
        """Render a Harte ``.lab`` line: ``<start>\\t<end>\\t<symbol>``."""
        return f"{self.start_sec:.6f}\t{self.end_sec:.6f}\t{self.harte}"


@dataclass
class RenderResult:
    """What a single successful render produced."""

    score_file: str
    score_sha: str
    soundfont: str
    soundfont_sha: str
    audio_path: str
    lab_path: str
    duration_sec: float
    score_license: str
    soundfont_license: str
    chord_events: list[ChordEvent] = field(default_factory=list)

    def to_manifest_entry(self) -> dict[str, object]:
        """Serialize to the JSONL schema documented in the module docstring."""
        return {
            "score_file": self.score_file,
            "score_sha": self.score_sha,
            "soundfont": self.soundfont,
            "soundfont_sha": self.soundfont_sha,
            "audio_path": self.audio_path,
            "lab_path": self.lab_path,
            "duration_sec": self.duration_sec,
            "score_license": self.score_license,
            "soundfont_license": self.soundfont_license,
            "rendered_at": datetime.now(UTC).isoformat(),
        }


def _sha256_of(path: Path) -> str:
    """SHA-256 of a file (streamed, 1 MiB chunks)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# Harte-label extraction and tempo-map resolution.
# ─────────────────────────────────────────────────────────────────────────────


# Deliberate, self-contained translation of music21's ChordSymbol figure
# into the Harte `.lab` grammar the Billboard / BTC families use. The full
# Harte grammar is larger; this subset covers every quality music21 emits by
# default and is where follow-up PRs will extend coverage.
_HARTE_QUALITY_MAP: dict[str, str] = {
    "major": "maj",
    "major-seventh": "maj7",
    "major-sixth": "maj6",
    "minor": "min",
    "minor-seventh": "min7",
    "minor-sixth": "min6",
    "minor-major-seventh": "minmaj7",
    "dominant": "7",
    "dominant-seventh": "7",
    "augmented": "aug",
    "augmented-seventh": "aug7",
    "diminished": "dim",
    "diminished-seventh": "dim7",
    "half-diminished": "hdim7",
    "suspended-fourth": "sus4",
    "suspended-second": "sus2",
    "power": "5",
    "pedal": "1",
    "other": "maj",
}


def chord_symbol_to_harte(root_name: str, quality_tag: str) -> str:
    """Translate a (root, quality_tag) pair to a Harte-format chord symbol.

    ``root_name`` is spelled in music21's natural convention (e.g. ``'C'``,
    ``'F#'``, ``'Bb'``). ``quality_tag`` is one of the keys of
    :data:`_HARTE_QUALITY_MAP`. Unknown qualities fall through to ``'maj'``
    rather than failing — the rendered audio is still useful for downstream
    augmentation, and the log line records the fallback so we can audit.
    """
    harte_quality = _HARTE_QUALITY_MAP.get(quality_tag)
    if harte_quality is None:
        log.warning(
            "unknown chord quality %r — falling back to 'maj'. Add it to "
            "_HARTE_QUALITY_MAP when safe.",
            quality_tag,
        )
        harte_quality = "maj"
    if harte_quality == "maj":
        return root_name
    return f"{root_name}:{harte_quality}"


def extract_chord_events(
    score: object,  # a music21.stream.Score; typed as object to avoid an import
) -> list[ChordEvent]:
    """Extract Harte-labelled chord events in SECONDS from a parsed music21 score.

    Walks the score for ``<harmony>`` entries (``music21.harmony.ChordSymbol``),
    resolves each offset/duration to wall-clock seconds via the score's tempo
    map, and produces a dense timeline with no gaps.

    The caller is expected to have already parsed the score with
    ``music21.converter.parse(...)``. This function does no I/O itself,
    which is what lets the tests mock it with a trivial stand-in.
    """
    # Local import keeps this module importable without music21 installed, which
    # matters for the tests that mock the whole pipeline.
    from music21 import harmony  # type: ignore[import-not-found]

    flat = score.flatten()
    chord_symbols = [el for el in flat.getElementsByClass(harmony.ChordSymbol)]
    if not chord_symbols:
        return []

    total_quarter_length = float(flat.highestTime)
    events: list[ChordEvent] = []

    for i, cs in enumerate(chord_symbols):
        onset_ql = float(cs.offset)
        if i + 1 < len(chord_symbols):
            offset_ql = float(chord_symbols[i + 1].offset)
        else:
            offset_ql = total_quarter_length
        if offset_ql <= onset_ql:
            # Degenerate / zero-length chord entry — skip rather than emit a
            # bad frame; this is extremely rare in PDMX / OpenEWLD content.
            continue
        start_sec = _quarter_length_to_seconds(score, onset_ql)
        end_sec = _quarter_length_to_seconds(score, offset_ql)
        root_name = cs.root().name if cs.root() is not None else "C"
        quality_tag = (cs.chordKind or "major").lower()
        harte = chord_symbol_to_harte(root_name, quality_tag)
        events.append(ChordEvent(start_sec=start_sec, end_sec=end_sec, harte=harte))
    return events


def _quarter_length_to_seconds(score: object, quarter_length: float) -> float:
    """Resolve a quarter-length offset to seconds using ``score``'s tempo map.

    music21 exposes ``score.secondsMap`` which maps elements to seconds; for
    a bare offset we evaluate the local tempo in effect at that offset and
    convert. The helper is isolated so the tests can replace it with a flat
    120 BPM mapping without touching the rest of the pipeline.
    """
    try:
        from music21 import tempo  # type: ignore[import-not-found]
    except ImportError:
        # Fallback used in test paths that have not installed music21.
        return quarter_length * 0.5  # 120 BPM equivalent

    metronomes = score.flatten().getElementsByClass(tempo.MetronomeMark)
    if not metronomes:
        # Default music21 tempo is 120 BPM = 0.5 s per quarter note.
        return quarter_length * 0.5

    # Walk the tempo map, accumulating seconds for each segment up to our
    # target offset. This is O(n_tempo_changes) and fine for scores with
    # at most a handful of tempo changes (PDMX typical).
    seconds = 0.0
    prev_offset = 0.0
    prev_bpm = 120.0
    for mm in metronomes:
        mm_offset = float(mm.offset)
        if mm_offset >= quarter_length:
            break
        seconds += (mm_offset - prev_offset) * (60.0 / prev_bpm)
        prev_offset = mm_offset
        prev_bpm = float(mm.number or 120.0)
    seconds += (quarter_length - prev_offset) * (60.0 / prev_bpm)
    return seconds


def write_lab_file(path: Path, events: list[ChordEvent]) -> None:
    """Write Harte ``.lab`` lines to ``path`` (tab-separated, one per line)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ev in events:
            f.write(ev.to_lab_line() + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# Audio rendering — pyFluidSynth wrapped so the tests can mock it cheaply.
# ─────────────────────────────────────────────────────────────────────────────


def render_midi_to_wav(
    midi_path: Path,
    soundfont_path: Path,
    audio_path: Path,
    *,
    sample_rate: int = RENDER_SAMPLE_RATE,
) -> float:
    """Render ``midi_path`` through ``soundfont_path`` into a mono WAV.

    Returns the rendered duration in seconds. The pyFluidSynth driver is
    imported lazily so this module is importable on CI where FluidSynth is
    not installed.
    """
    import numpy as np  # local import — see module docstring
    import pretty_midi  # type: ignore[import-not-found]

    # pyFluidSynth is imported as `fluidsynth` at the module level, so this
    # local import keeps the rest of the training package happy without it.
    try:
        import fluidsynth  # type: ignore[import-not-found]  # noqa: F401
    except ImportError as e:  # pragma: no cover - exercised only in prod envs
        raise RuntimeError(
            "pyFluidSynth is not installed; install the training extras "
            "(pip install -e apps/training) and ensure libfluidsynth is "
            "available on the system."
        ) from e

    midi = pretty_midi.PrettyMIDI(str(midi_path))
    audio = midi.fluidsynth(fs=sample_rate, sf2_path=str(soundfont_path))
    # Mix to mono if needed; pretty_midi.fluidsynth returns mono float64.
    audio = np.asarray(audio, dtype=np.float32)
    duration_sec = len(audio) / float(sample_rate)
    _write_mono_wav(audio_path, audio, sample_rate)
    return duration_sec


def _write_mono_wav(path: Path, audio: object, sample_rate: int) -> None:
    """Write ``audio`` (float32 in [-1, 1]) to ``path`` as a 16-bit mono WAV."""
    import numpy as np

    arr = np.asarray(audio, dtype=np.float32)
    # Clip and convert to int16.
    clipped = np.clip(arr, -1.0, 1.0)
    int16 = (clipped * 32767.0).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(RENDER_CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(int16.tobytes())


# ─────────────────────────────────────────────────────────────────────────────
# Top-level per-score render routine.
# ─────────────────────────────────────────────────────────────────────────────


def _parse_score(score_path: Path) -> object:
    """Thin seam around ``music21.converter.parse``.

    Isolated at module scope so the tests can replace it wholesale without
    needing music21 importable. Production code imports music21 lazily
    inside this function.
    """
    from music21 import converter  # type: ignore[import-not-found]

    return converter.parse(str(score_path))


def render_score(
    score_path: Path,
    out_dir: Path,
    *,
    soundfont_name: str,
    soundfont_path: Path,
    score_license: str,
    sample_rate: int = RENDER_SAMPLE_RATE,
) -> RenderResult:
    """Render one MusicXML score to WAV + Harte .lab under ``out_dir``.

    The output filenames are derived from the score's stem (so re-rendering
    a given score deterministically overwrites its last outputs). The MIDI
    intermediate is written next to the audio as ``<stem>.mid`` for
    debugging — it's cheap and eases human spot-checking.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = score_path.stem
    midi_path = out_dir / f"{stem}.mid"
    audio_path = out_dir / f"{stem}.wav"
    lab_path = out_dir / f"{stem}.lab"

    log.info("rendering score %s with soundfont %s", score_path, soundfont_name)
    score = _parse_score(score_path)

    # 1. Chord-event timeline in seconds.
    events = extract_chord_events(score)
    write_lab_file(lab_path, events)

    # 2. MIDI render (music21 → .mid) and FluidSynth render (.mid → .wav).
    score.write("midi", fp=str(midi_path))
    duration_sec = render_midi_to_wav(
        midi_path,
        soundfont_path,
        audio_path,
        sample_rate=sample_rate,
    )
<<<<<<< HEAD
>>>>>>> origin/v3/main
=======

    soundfont = SOUNDFONTS[soundfont_name]
    return RenderResult(
        score_file=str(score_path),
        score_sha=_sha256_of(score_path),
        soundfont=soundfont_name,
        soundfont_sha=_sha256_of(soundfont_path),
        audio_path=str(audio_path),
        lab_path=str(lab_path),
        duration_sec=duration_sec,
        score_license=score_license,
        soundfont_license=soundfont.license,
        chord_events=events,
    )


def append_manifest(manifest_path: Path, result: RenderResult) -> None:
    """Append ``result`` to ``manifest_path`` as one JSON line."""
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    entry = result.to_manifest_entry()
    with manifest_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# CLI.
# ─────────────────────────────────────────────────────────────────────────────


def _pick_soundfont(name: str | None, rng: random.Random) -> str:
    """Resolve ``--soundfont`` to a concrete slug, rotating when unset."""
    if name is None:
        return rng.choice(list(SOUNDFONTS.keys()))
    if name not in SOUNDFONTS:
        raise SystemExit(f"Unknown soundfont {name!r}. Known: {sorted(SOUNDFONTS.keys())}")
    return name


def _iter_score_files(score_root: Path) -> list[Path]:
    """Return all MusicXML files under ``score_root`` (sorted for determinism)."""
    if not score_root.exists():
        return []
    patterns = ("*.musicxml", "*.mxl", "*.xml")
    found: list[Path] = []
    for pattern in patterns:
        found.extend(score_root.rglob(pattern))
    return sorted(found)


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argparse surface documented in the module docstring."""
    p = argparse.ArgumentParser(
        prog="python -m training.data.synthetic_render",
        description="Render MusicXML scores to aligned audio + Harte chord labels.",
    )
    p.add_argument(
        "--count",
        type=int,
        default=1000,
        help="Maximum number of scores to render (default: 1000).",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=Path("apps/training/data/cache/synthetic"),
        help="Output directory for rendered audio/labels/manifest.",
    )
    p.add_argument(
        "--scores",
        type=Path,
        default=None,
        help=(
            "Root directory of MusicXML scores. Defaults to the "
            "PDMX no_license_conflict subset under the training cache."
        ),
    )
    p.add_argument(
        "--soundfont",
        default=None,
        help=(
            "Soundfont slug (fluidr3, musescore_general, vsco2, vcsl, "
            "salamander). Omitted = rotate randomly per score."
        ),
    )
    p.add_argument(
        "--soundfont-path",
        type=Path,
        default=None,
        help="Path to the .sf2 file. Defaults to TRAINING_SOUNDFONT_PATH env.",
    )
    p.add_argument(
        "--score-license",
        default="CC-BY-4.0",
        help="SPDX-ish license tag for the score corpus (default PDMX CC-BY-4.0).",
    )
    p.add_argument(
        "--jobs",
        type=int,
        default=int(os.environ.get("TRAINING_RENDER_JOBS", "1")),
        help=(
            "Parallel worker count (reserved for a future pool; the current " "CLI runs serially)."
        ),
    )
    p.add_argument(
        "--seed",
        type=int,
        default=0,
        help="RNG seed for soundfont rotation. Deterministic rendering.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; returns a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    rng = random.Random(args.seed)

    scores_root = args.scores or Path("apps/training/data/cache/pdmx/no_license_conflict")
    score_files = _iter_score_files(scores_root)[: args.count]
    if not score_files:
        print(
            f"No MusicXML files found under {scores_root}. "
            "Run `python -m training.data.download --source pdmx --confirm` "
            "first.",
            file=sys.stderr,
        )
        return 2

    soundfont_path = args.soundfont_path or Path(
        os.environ.get("TRAINING_SOUNDFONT_PATH", "apps/training/data/cache/soundfonts/fluidr3.sf2")
    )
    if not soundfont_path.exists():
        print(f"Soundfont not found at {soundfont_path}.", file=sys.stderr)
        return 3

    manifest_path = args.out / MANIFEST_FILENAME
    for score_path in score_files:
        sf_name = _pick_soundfont(args.soundfont, rng)
        try:
            result = render_score(
                score_path,
                args.out,
                soundfont_name=sf_name,
                soundfont_path=soundfont_path,
                score_license=args.score_license,
            )
        except Exception as e:  # noqa: BLE001 — render failures logged but non-fatal
            log.warning("render failed for %s: %s", score_path, e)
            continue
        append_manifest(manifest_path, result)
        log.info("rendered %s (%.1fs, %s)", score_path.name, result.duration_sec, sf_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
>>>>>>> origin/v3/main
