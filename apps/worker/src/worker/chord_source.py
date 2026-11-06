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
# OPTIONAL sharp/flat; quality is one of the 24 chord qualities in
# ``training.model.alphabet.QUALITY_LABELS`` (every slot except ``N``), or the
# special labels N (no chord) / X (unrecognised). The provider MAY omit the
# quality for a bare triad — e.g. ``C`` == ``C:maj`` — which is accepted.
#
# An optional ``/<bass>`` suffix is accepted. The bass token is a Harte INTERVAL
# (scale degree), never a note name, in exactly the grammar of
# ``alphabet._parse_interval``: zero or more ``b``/``#`` accidentals followed by a
# degree 1..13 (``/3``, ``/5``, ``/b3``, ``/#5``, ``/b7``, ``/1``). N and X take no
# bass. Keep this in sync with alphabet.py (source of truth); the round-trip test
# in test_chord_source.py fails if the two drift.
_HARTE_QUALITIES = (
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
)
_HARTE_BASS = r"/[b#]*(?:1[0-3]|[1-9])"
HARTE_RE = re.compile(
    r"^(?:N|X|[A-G](?:#|b)?(?::(?:" + "|".join(_HARTE_QUALITIES) + r"))?(?:" + _HARTE_BASS + r")?)$"
)


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


class ChordSubmitUncertain(Exception):
    """A paid submission for this job may already exist but cannot be reattached.

    Raised when the per-job ledger holds the pre-POST sentinel (a previous run died
    between sending the billable POST and recording the provider job id) or another
    worker holds the claim. The safe action is to NOT submit again: chords are an
    optional overlay, a second bill is real money.
    """


class ChordJobLedger(Protocol):
    """Durable per-job record of a provider submission (the Replicate
    ``replicate_prediction_id`` pattern, for providers that bill per request).

    Contract, in the order ``recognize`` uses it:
      * ``existing()``  - the recorded provider job id, or ``None`` if nothing was ever
                          submitted. Raises ``ChordSubmitUncertain`` if a submit began
                          but its id was never recorded.
      * ``claim()``     - atomically mark "about to submit" BEFORE the billable POST.
                          Raises ``ChordSubmitUncertain`` if already claimed/recorded.
      * ``record(id)``  - persist the provider job id IMMEDIATELY after the POST,
                          before polling.
      * ``release()``   - undo ``claim()`` when nothing was sent (quota refused).
    """

    def existing(self) -> str | None: ...

    def claim(self) -> None: ...

    def record(self, provider_job_id: str) -> None: ...

    def release(self) -> None: ...


class ChordSource(Protocol):
    """Every provider implements exactly this one method."""

    def recognize(
        self,
        audio_path: Path,
        *,
        stem: StemKind = "mix",
        ledger: ChordJobLedger | None = None,
    ) -> ChordResult: ...


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
