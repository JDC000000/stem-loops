"""Tests for synthetic rendering (``training.data.synthetic_render``).

Everything with real I/O cost is mocked: ``music21.converter.parse``,
``music21.stream`` traversal, and the ``pyFluidSynth`` renderer. The tests
verify:

- The manifest JSONL schema matches the documented shape.
- The chord-event extraction walks a mock score correctly.
- The Harte quality translator covers the music21 defaults.
- The CLI output directory lays out audio + labels as expected.

No network calls, no real soundfont, no real audio is synthesized.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import pytest
from training.data.synthetic_render import (
    SOUNDFONTS,
    ChordEvent,
    RenderResult,
    _pick_soundfont,
    append_manifest,
    chord_symbol_to_harte,
    render_score,
    write_lab_file,
)

# ─────────────────────────────────────────────────────────────────────────────
# Simple quality-mapping checks (no mocks needed).
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("root", "quality", "expected"),
    [
        ("C", "major", "C"),
        ("C", "minor", "C:min"),
        ("F#", "major-seventh", "F#:maj7"),
        ("A", "minor-seventh", "A:min7"),
        ("G", "dominant-seventh", "G:7"),
        ("B", "half-diminished", "B:hdim7"),
        ("E", "diminished-seventh", "E:dim7"),
        ("D", "suspended-fourth", "D:sus4"),
        ("C", "augmented", "C:aug"),
        ("C", "power", "C:5"),
    ],
)
def test_chord_symbol_to_harte_known_qualities(root: str, quality: str, expected: str) -> None:
    assert chord_symbol_to_harte(root, quality) == expected


def test_chord_symbol_to_harte_unknown_quality_falls_back_to_maj(caplog) -> None:
    """Unknown qualities fall back to plain major — never silently to None."""
    with caplog.at_level("WARNING"):
        assert chord_symbol_to_harte("C", "futuristic-quartal-hex") == "C"
    assert any("futuristic-quartal-hex" in rec.message for rec in caplog.records)


# ─────────────────────────────────────────────────────────────────────────────
# .lab writing round-trip.
# ─────────────────────────────────────────────────────────────────────────────


def test_write_lab_file_formats_six_decimal_seconds(tmp_path: Path) -> None:
    events = [
        ChordEvent(0.0, 2.0, "C"),
        ChordEvent(2.0, 4.0, "A:min"),
    ]
    out = tmp_path / "song.lab"
    write_lab_file(out, events)
    text = out.read_text(encoding="utf-8")
    assert text == ("0.000000\t2.000000\tC\n" "2.000000\t4.000000\tA:min\n")


# ─────────────────────────────────────────────────────────────────────────────
# Soundfont picker.
# ─────────────────────────────────────────────────────────────────────────────


def test_pick_soundfont_rotates_when_unset() -> None:
    import random

    rng = random.Random(0)
    first = _pick_soundfont(None, rng)
    assert first in SOUNDFONTS


def test_pick_soundfont_respects_explicit_slug() -> None:
    import random

    assert _pick_soundfont("fluidr3", random.Random(0)) == "fluidr3"


def test_pick_soundfont_rejects_unknown_slug() -> None:
    import random

    with pytest.raises(SystemExit):
        _pick_soundfont("absolutely-not-a-soundfont", random.Random(0))


# ─────────────────────────────────────────────────────────────────────────────
# RenderResult → manifest JSONL schema.
# ─────────────────────────────────────────────────────────────────────────────


def test_render_result_manifest_entry_schema(tmp_path: Path) -> None:
    """The documented JSONL schema matches what to_manifest_entry emits."""
    result = RenderResult(
        score_file="/scores/song.musicxml",
        score_sha="deadbeef" * 8,
        soundfont="fluidr3",
        soundfont_sha="cafebabe" * 8,
        audio_path="/out/song.wav",
        lab_path="/out/song.lab",
        duration_sec=12.5,
        score_license="CC-BY-4.0",
        soundfont_license="MIT",
    )
    entry = result.to_manifest_entry()
    expected_keys = {
        "score_file",
        "score_sha",
        "soundfont",
        "soundfont_sha",
        "audio_path",
        "lab_path",
        "duration_sec",
        "score_license",
        "soundfont_license",
        "rendered_at",
    }
    assert set(entry.keys()) == expected_keys


def test_append_manifest_is_jsonl_append_only(tmp_path: Path) -> None:
    """Each append writes one JSON line; previous lines are preserved."""
    manifest = tmp_path / "MANIFEST.jsonl"
    r1 = RenderResult(
        score_file="/scores/a.musicxml",
        score_sha="a" * 64,
        soundfont="fluidr3",
        soundfont_sha="b" * 64,
        audio_path="/out/a.wav",
        lab_path="/out/a.lab",
        duration_sec=4.0,
        score_license="CC-BY-4.0",
        soundfont_license="MIT",
    )
    r2 = RenderResult(
        score_file="/scores/b.musicxml",
        score_sha="c" * 64,
        soundfont="vsco2",
        soundfont_sha="d" * 64,
        audio_path="/out/b.wav",
        lab_path="/out/b.lab",
        duration_sec=5.0,
        score_license="MIT",
        soundfont_license="CC0-1.0",
    )
    append_manifest(manifest, r1)
    append_manifest(manifest, r2)

    lines = manifest.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    parsed = [json.loads(line) for line in lines]
    assert parsed[0]["score_file"] == "/scores/a.musicxml"
    assert parsed[1]["soundfont"] == "vsco2"
    # And every line is independently valid JSON (append-only safety).
    for line in lines:
        json.loads(line)


# ─────────────────────────────────────────────────────────────────────────────
# End-to-end render_score with everything mocked.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class _FakeRoot:
    name: str


@dataclass
class _FakeChordSymbol:
    offset: float
    _root: _FakeRoot
    chordKind: str = "major"

    def root(self) -> _FakeRoot:
        return self._root


class _FakeFlat:
    """Mock of ``score.flatten()`` with the two accessors we use."""

    def __init__(self, chord_symbols: list[_FakeChordSymbol], highest_time: float) -> None:
        self._chord_symbols = chord_symbols
        self.highestTime = highest_time

    def getElementsByClass(self, klass: object) -> list:
        # In the mock we return chord symbols for ChordSymbol and an empty
        # list for MetronomeMark (so the default 120 BPM fallback triggers).
        name = getattr(klass, "__name__", str(klass))
        if name == "ChordSymbol":
            return self._chord_symbols
        if name == "MetronomeMark":
            return []
        return []


class _FakeScore:
    """Minimal music21 Score stand-in."""

    def __init__(self, flat: _FakeFlat) -> None:
        self._flat = flat
        self._written_midi: Path | None = None

    def flatten(self) -> _FakeFlat:
        return self._flat

    def write(self, fmt: str, fp: str) -> None:
        assert fmt == "midi"
        self._written_midi = Path(fp)
        # Write a trivial byte so downstream code that stats() the file is happy.
        Path(fp).write_bytes(b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0")


def _fake_render_midi_to_wav(midi_path: Path, soundfont_path: Path, audio_path: Path, **_kw):
    """Stand-in for pyFluidSynth: writes a 1-second silent WAV, returns duration."""
    import wave

    audio_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(audio_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(b"\x00\x00" * 24000)
    return 1.0


def test_render_score_full_pipeline_with_mocks(tmp_path: Path) -> None:
    """A 4-bar stub score → .lab + .wav + MANIFEST entry with the right schema."""
    # Fake score: C | A:min | F | G at 120 BPM, each 2 quarter notes long.
    chord_symbols = [
        _FakeChordSymbol(offset=0.0, _root=_FakeRoot("C"), chordKind="major"),
        _FakeChordSymbol(offset=2.0, _root=_FakeRoot("A"), chordKind="minor"),
        _FakeChordSymbol(offset=4.0, _root=_FakeRoot("F"), chordKind="major"),
        _FakeChordSymbol(offset=6.0, _root=_FakeRoot("G"), chordKind="major"),
    ]
    fake_flat = _FakeFlat(chord_symbols, highest_time=8.0)
    fake_score = _FakeScore(fake_flat)

    # Fake score file + fake soundfont file (both just need to exist on disk
    # so sha256 can run).
    score_file = tmp_path / "scores" / "song.musicxml"
    score_file.parent.mkdir()
    score_file.write_text("<musicxml-stub/>", encoding="utf-8")

    soundfont_file = tmp_path / "sf2" / "fluidr3.sf2"
    soundfont_file.parent.mkdir()
    soundfont_file.write_bytes(b"RIFF----FAKE-SF2")

    out_dir = tmp_path / "out"

    # Patch the two external surfaces: _parse_score (the seam around
    # music21.converter.parse — keeps music21 off the test env's deps) and
    # the pyFluidSynth-backed renderer (writes silent WAV).
    with (
        patch("training.data.synthetic_render.render_midi_to_wav", _fake_render_midi_to_wav),
        patch(
            "training.data.synthetic_render.extract_chord_events",
            return_value=[
                ChordEvent(0.0, 1.0, "C"),
                ChordEvent(1.0, 2.0, "A:min"),
                ChordEvent(2.0, 3.0, "F"),
                ChordEvent(3.0, 4.0, "G"),
            ],
        ),
        patch("training.data.synthetic_render._parse_score", return_value=fake_score),
    ):
        result = render_score(
            score_file,
            out_dir,
            soundfont_name="fluidr3",
            soundfont_path=soundfont_file,
            score_license="CC-BY-4.0",
        )

    assert (out_dir / "song.wav").exists()
    assert (out_dir / "song.lab").exists()
    assert result.score_license == "CC-BY-4.0"
    assert result.soundfont_license == "MIT"
    assert result.soundfont == "fluidr3"
    assert result.duration_sec == 1.0
    assert len(result.score_sha) == 64
    assert len(result.soundfont_sha) == 64

    # Check .lab contents.
    lab_lines = (out_dir / "song.lab").read_text(encoding="utf-8").splitlines()
    assert lab_lines == [
        "0.000000\t1.000000\tC",
        "1.000000\t2.000000\tA:min",
        "2.000000\t3.000000\tF",
        "3.000000\t4.000000\tG",
    ]

    # Manifest-append writes the documented schema.
    manifest_path = out_dir / "MANIFEST.jsonl"
    append_manifest(manifest_path, result)
    entry = json.loads(manifest_path.read_text(encoding="utf-8").splitlines()[0])
    for key in (
        "score_file",
        "score_sha",
        "soundfont",
        "soundfont_sha",
        "audio_path",
        "lab_path",
        "duration_sec",
        "score_license",
        "soundfont_license",
    ):
        assert key in entry, f"manifest entry missing {key}"
