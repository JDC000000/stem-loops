"""ChordNet training entry point.

PR-Y1.4. Reads the MANIFEST.jsonl produced by ``training.data.download`` +
the synthetic-render output, builds the ``ChordNet2E1D`` graph, and trains
on a single GPU (Modal L4 / A10 per repo .env.example).
"""

from __future__ import annotations


def main() -> int:
    raise NotImplementedError(
        "Training is not wired yet. Planned for PR-Y1.4. See "
        "claude/phase-2-y1-chord-model-decision.md for scope."
    )


if __name__ == "__main__":
    raise SystemExit(main())
