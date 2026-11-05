"""ChordSource abstraction (PR-Y1.1 — V3 Phase 2 Y1 chord model).

Single interface for every chord-recognition provider: Klangio bridge first (1
billing cycle hard cap per the Y1 decision record), our own trained model later.
The pipeline NEVER imports a provider directly — only ``get_chord_source()``, so
switching providers is a one-line env change (``CHORDS_PROVIDER``) with no
schema/contract delta downstream.

Decision record: ``claude/phase-2-y1-chord-model-decision.md`` v1.1 (hybrid path
E — Klangio bridge in parallel with own-model training).

Harte-syntax labels (``C:maj``, ``F#:7``, ``N`` for no-chord) are the on-wire
contract — enforced by ``is_valid_harte_label`` and the matching test. All three
providers in the ``provider`` field — ``klangio`` | ``replicate`` | ``internal``
— are typed here so the eval harness and downstream readers can switch on a
closed enum. Only ``klangio`` is wired in this PR; the rest raise
``NotImplementedError`` until Y1.2+.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

StemKind = Literal["mix", "instrumental", "other"]
ProviderName = Literal["klangio", "replicate", "internal"]

# Harte-subset regex for the provider contract. Root is a natural letter plus an
# OPTIONAL sharp/flat; quality is one of the Chordify-compatible 15 we care about,
# or the special labels N (no chord) / X (unrecognised). The provider MAY omit
# the quality for a bare triad — e.g. ``C`` == ``C:maj`` — which is accepted.
_HARTE_QUALITIES = (
    "maj",
    "min",
    "dim",
    "aug",
    "maj7",
    "min7",
    "7",
    "dim7",
    "hdim7",
    "sus2",
    "sus4",
    "maj6",
    "min6",
    "minmaj7",
)
HARTE_RE = re.compile(r"^(?:N|X|[A-G](?:#|b)?(?::(?:" + "|".join(_HARTE_QUALITIES) + r"))?)$")


def is_valid_harte_label(label: str) -> bool:
    """True if ``label`` is in the Harte subset the pipeline ships with."""
    return bool(HARTE_RE.match(label))


@dataclass(frozen=True)
class ChordSegment:
    """One contiguous chord region on the time axis.

    ``label`` must pass ``is_valid_harte_label``. ``confidence`` is in [0.0, 1.0];
    providers that don't surface per-segment confidence (Klangio) should set 1.0
    and the eval harness then treats the segment as "no provider signal" for
    confidence-based filtering.
    """

    start_sec: float
    end_sec: float
    label: str  # Harte, e.g. "C:maj" | "F#:7" | "N"
    confidence: float  # 0.0-1.0


@dataclass(frozen=True)
class ChordResult:
    """A full-track recognition result, provider-tagged for reproducibility."""

    segments: list[ChordSegment] = field(default_factory=list)
    key: str | None = None  # e.g. "C:major"; None if the provider doesn't return key
    provider: ProviderName = "klangio"
    provider_version: str = ""
    duration_sec: float = 0.0
    model_ms: int = 0  # wallclock inside the provider call (submit + poll + fetch)


class ChordQuotaExceeded(Exception):
    """Provider rejected the request because the paying plan's quota is exhausted.

    Raised terminally (NOT retried) so the caller surfaces it to billing / ops
    instead of burning the retry budget on 402s. This is the ONE cost signal that
    forces the Y1 Klangio-bridge decision to be reviewed before the next cycle.
    """


class ChordSource(Protocol):
    """Every provider implements exactly this one method."""

    def recognize(self, audio_path: Path, *, stem: StemKind = "mix") -> ChordResult: ...


def get_chord_source(provider: str | None = None) -> ChordSource:
    """Factory. Defaults to ``os.environ['CHORDS_PROVIDER']`` or ``'klangio'``.

    Returns the concrete implementation; the import is lazy so a missing provider
    dep never breaks the rest of the pipeline. The three provider literals are
    the SAME closed set as the ``ProviderName`` type above — any new provider
    must be added in BOTH places (M-4 type ↔ code drift rule).
    """
    name = provider or os.environ.get("CHORDS_PROVIDER", "klangio")
    if name == "klangio":
        from .chord_providers.klangio import KlangioChordSource

        return KlangioChordSource()
    if name in ("replicate", "internal"):
        raise NotImplementedError(
            f"ChordSource provider '{name}' is deferred to PR-Y1.2+ "
            f"(see claude/phase-2-y1-chord-model-decision.md)."
        )
    raise ValueError(
        f"Unknown CHORDS_PROVIDER '{name}'. Supported: klangio | replicate | internal."
    )
