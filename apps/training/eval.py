"""ChordNet offline evaluation.

PR-Y1.4. Runs the trained model against the 20-song held-out eval set and
reports mir_eval chord metrics (WCSR at root / majmin / sevenths).

Per the decision record: if the artifact passes this eval, Jon open-sources
the weights under Apache-2.0 with full attribution per DATA-PROVENANCE.md.
"""

from __future__ import annotations


def main() -> int:
    raise NotImplementedError(
        "Eval is not wired yet. Planned for PR-Y1.4. See "
        "claude/phase-2-y1-chord-model-decision.md §eval."
    )


if __name__ == "__main__":
    raise SystemExit(main())
