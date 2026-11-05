"""Synthetic rendering: MusicXML / lead-sheet -> aligned audio + chord labels.

Planned path (PR-Y1.3):

1. Read PDMX (``no_license_conflict`` subset) + OpenEWLD MusicXML.
2. Convert to MIDI with ``pretty_midi``.
3. Render with ``pyFluidSynth`` through a rotating SoundFont pool (SFZ / SF2
   permissively-licensed only — documented in DATA-PROVENANCE.md at render
   time).
4. Emit per-render ``(audio_path, chord_labels_ndjson, sha256)`` triples and
   append to ``cache/MANIFEST.jsonl`` as a ``synthetic`` entry.

PR-Y1.2 ships the module shell so the import surface is stable and the
provenance doc can reference it. The renderer itself lands in PR-Y1.3.
"""

from __future__ import annotations


def render(*_args: object, **_kwargs: object) -> None:
    """Stub — see module docstring. Lands in PR-Y1.3."""
    raise NotImplementedError(
        "Synthetic rendering is not wired yet. Planned for PR-Y1.3. "
        "See apps/training/data/synthetic_render.py docstring for the full "
        "plan and apps/training/DATA-PROVENANCE.md for the attribution "
        "obligations that will apply to any SoundFont used at render time."
    )
