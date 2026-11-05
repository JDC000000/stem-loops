"""ChordNet student: 2 encoders (CQT + chromagram) + 1 decoder.

PR-Y1.4 lands the real architecture per the chord-model research synthesis
(``claude/phase-2-y1-chord-model-synthesis.md``). This stub keeps the import
surface stable for ``train.py`` / ``eval.py`` scaffolding in PR-Y1.2.
"""

from __future__ import annotations


class ChordNet2E1D:
    """2-encoder / 1-decoder chord student. PR-Y1.4."""

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise NotImplementedError(
            "ChordNet2E1D will be implemented in PR-Y1.4. See the chord-model "
            "research synthesis in the project folder for the target "
            "architecture and hyperparameters."
        )
