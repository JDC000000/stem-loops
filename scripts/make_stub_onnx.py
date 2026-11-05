#!/usr/bin/env python3
"""Build a tiny stub ONNX model for PR-Y1.6 Variant Y browser integration.

The stub is a single Linear(144, 60) that matches the IO shape Chordnet will
expose once PR-Y1.4 trains the real model:
    input:  (1, N, 144)  Float32   # N CQT frames, 144 bins per frame
    output: (1, N, 60)   Float32   # Per-frame logits over the 60-chord alphabet

Opset 17. Deterministic weight init so the committed asset is reproducible
byte-for-byte (so CI diffs are meaningful).

Usage:
    python3 scripts/make_stub_onnx.py --out apps/web/public/chord-stub.onnx

When PR-Y1.5b lands the real trained weights this script becomes obsolete —
delete it along with the `.onnx` blob and replace with the R2-hosted model
URL via NEXT_PUBLIC_CHORDNET_MODEL_URL.

Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §1.6a (Variant Y).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
import torch.nn as nn


class ChordnetStub(nn.Module):
    """Minimum viable stub.

    Real Chordnet (per decision v1.3): CNN+GRU with log-CQT frontend and HMM
    decoder in JS. The stub collapses that to a per-frame Linear so the
    browser path can be built & tested without the training pipeline landing.
    Weights are deterministic (seeded) so the committed .onnx is reproducible.
    """

    def __init__(self, in_bins: int = 144, n_chords: int = 60) -> None:
        super().__init__()
        self.proj = nn.Linear(in_bins, n_chords)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # pragma: no cover (traced)
        # x: (B, T, bins) → (B, T, chords)
        return self.proj(x)


def build(out_path: Path) -> None:
    torch.manual_seed(0x7357C0DE)  # "TESTCODE"
    model = ChordnetStub().eval()
    # Dummy input with a representative frame count (128). The exported graph
    # marks the time axis as dynamic so inference with any N works.
    dummy = torch.zeros(1, 128, 144, dtype=torch.float32)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Export to a temporary path first; the new PyTorch ONNX exporter may
    # split weights into an external .data file, which breaks the browser's
    # single-file fetch. We post-process to inline everything.
    tmp_path = out_path.with_suffix(".tmp.onnx")
    torch.onnx.export(
        model,
        dummy,
        str(tmp_path),
        input_names=["cqt"],
        output_names=["logits"],
        dynamic_axes={
            "cqt": {1: "n_frames"},
            "logits": {1: "n_frames"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    # Re-save with all tensors inlined so there is no companion .data file.
    import onnx  # noqa: PLC0415 — deferred so the error is clearer than torch's
    from onnx.external_data_helper import load_external_data_for_model

    model_proto = onnx.load(str(tmp_path), load_external_data=False)
    load_external_data_for_model(model_proto, str(tmp_path.parent))
    for init in model_proto.graph.initializer:
        # Reset the data_location so onnx.save writes the bytes inline.
        init.data_location = onnx.TensorProto.DEFAULT
    onnx.save(model_proto, str(out_path))
    # Clean up tmp files the exporter dropped next to it.
    tmp_path.unlink(missing_ok=True)
    for sibling in tmp_path.parent.iterdir():
        if sibling.name.startswith(tmp_path.stem):
            sibling.unlink()
    # Also sweep any stray .data companion left by a prior run of the real
    # exporter (chord-stub.onnx.data).
    data_sibling = out_path.with_name(out_path.name + ".data")
    data_sibling.unlink(missing_ok=True)

    size = out_path.stat().st_size
    print(f"wrote {out_path} ({size} bytes)", file=sys.stderr)
    if size > 1_000_000:
        print(
            f"WARNING: stub exceeds 1 MB ({size}); brief requires <1 MB",
            file=sys.stderr,
        )
        sys.exit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("apps/web/public/chord-stub.onnx"),
        help="output path for the .onnx blob",
    )
    args = parser.parse_args()
    build(args.out.resolve())


if __name__ == "__main__":
    main()
