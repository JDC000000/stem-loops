"""Export a trained ChordNet 2E1D's CRF transition matrix to JSON (PR-Y1.5c).

The browser-side JS-Viterbi (PR #79) loads this JSON via its
``loadTransition()`` helper to smooth per-frame ONNX predictions with the
learned transition prior.

Pre-mortem H-3 strategy (`claude/phase-2-y1-chord-model-premortem.md`):
the CRF layer itself does NOT export to ONNX. Only the per-frame logit
head and these (62, 62) transitions are shipped to the browser; the
decoder runs there.

CLI
---

.. code-block:: bash

    python -m training.export_crf_transitions \\
        --checkpoint apps/training/runs/exp1/best.pt \\
        --out apps/web/public/chord-transitions.v1.json

JSON format consumed by PR #79 ``loadTransition()``:

.. code-block:: json

    {
      "version": "v1",
      "model_sha": "<sha256 of model weights>",
      "alphabet_sha": "<alphabet.ALPHABET_SHA>",
      "n_states": 62,
      "transitions_log_prob": [[...], ...],
      "start_transitions_log_prob": [...],
      "end_transitions_log_prob": [...],
      "generated_at": "<ISO-8601 UTC>"
    }
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from .model.chordnet_2e1d import ChordNet2E1D, _sha256_of_state_dict


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.export_crf_transitions",
        description=(
            "Export a ChordNet-2E1D CRF transition matrix as JSON for the "
            "browser-side Viterbi decoder (PR #79)."
        ),
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Path to best.pt / epoch-NNN.pt written by train.py with --use-crf.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output JSON path (e.g. apps/web/public/chord-transitions.v1.json).",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="v1",
        help="Schema version tag written into the JSON (default: v1).",
    )
    return parser


def export_from_checkpoint(
    checkpoint: Path, out: Path, *, version: str = "v1"
) -> dict[str, object]:
    """Load a CRF-trained checkpoint and write the transitions JSON.

    Returns:
        The payload dict actually written.

    Raises:
        RuntimeError: If the checkpoint was not trained with ``--use-crf``.
    """
    ckpt = torch.load(checkpoint, map_location="cpu")
    if not ckpt.get("use_crf", False):
        raise RuntimeError(
            f"Checkpoint {checkpoint} was not trained with --use-crf (no CRF to export). "
            "Re-train with --use-crf and --output-mode flat170."
        )
    output_mode = ckpt.get("output_mode", "flat170")
    model = ChordNet2E1D(output_mode=output_mode, use_crf=True)
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    # Use the already-loaded state_dict for the model_sha to avoid re-computing
    # the hash from `model.state_dict()` (same tensors, same result, but cheaper
    # to pass through here explicitly).
    model_sha = _sha256_of_state_dict(ckpt["model_state"])
    payload = model.export_transitions_as_json(out, version=version, model_sha=model_sha)
    return payload


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    payload = export_from_checkpoint(args.checkpoint, args.out, version=args.version)
    print(
        json.dumps(
            {
                "wrote": str(args.out),
                "version": payload["version"],
                "n_states": payload["n_states"],
                "model_sha": payload["model_sha"],
                "alphabet_sha": payload["alphabet_sha"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
