"""ONNX int8 export pipeline for ChordNet 2E1D (PR-Y1.5b).

Decision record v1.3 §Week-4 commits us to:

- Export a trained PyTorch ChordNet2E1D checkpoint to ONNX (opset 17).
- Dynamic-quantize weights to int8 with ``onnxruntime.quantization``.
- Keep CQT, CRF, and argmax outside the graph — only the neural net goes
  through ONNX Runtime Web; the pre/post-processing stays in the training
  tree (CQT) or the browser runtime (argmax / CRF / Viterbi).
- Verify PyTorch ↔ ONNX Runtime CPU parity on the SAME random input; abort
  if max abs diff is above tolerance. Parity is on the fp32 reference ONNX
  model; the int8 model is allowed a larger (but still bounded) drift.

Shape contract (static for simplicity — documented per PR-Y1.5b):
    input ``cqt``:   float32 ``(16, 128, 144)`` — (batch, frames, n_bins).
    outputs:         four tensors matching the ChordNet "structured" head:
                     ``root`` (B, T, 13), ``triad`` (B, T, 5),
                     ``bass_interval`` (B, T, 13), ``has_7th`` (B, T, 4).

Static shape rationale
----------------------
We considered ``dynamic_axes={'cqt': {0: 'batch', 1: 'frames'}}``. Opset 17
supports it well, but: (a) the browser runtime always invokes the model on
one fixed window, (b) static shapes let ORT's graph optimizer fuse more
aggressively, (c) int8 dynamic quantization is less brittle on fixed
shapes. The production pipeline slices the full-song CQT into (16, 128,
144) tiles on the JS side and concatenates predictions. The ``--dynamic``
flag below flips to dynamic axes if that assumption ever changes.

CRF stays OUTSIDE the graph
---------------------------
Per the decision record and the premortem: PR-Y1.5 adds a CRF head on top
of the BiGRU logits, but Viterbi decoding is NOT ONNX-friendly (ORT Web
lacks a native CRF op). We export only through the heads. The browser
runs argmax or a hand-coded Viterbi against head logits.

PR-Y1.4 import guard
--------------------
``ChordNet2E1D`` lives on the (not-yet-merged) PR-Y1.4 branch. On a fresh
checkout of ``v3/main`` the import fails; the CLI then refuses to run and
emits the same guidance ``model/chordnet_2e1d.require_cqt_plan`` uses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Static shape contract (documented in module docstring).
# ---------------------------------------------------------------------------

STATIC_BATCH: int = 16
STATIC_FRAMES: int = 128
STATIC_N_BINS: int = 144

# Default parity tolerances. The fp32 reference ONNX model must match
# PyTorch within ``PARITY_TOL_FP32``; the int8 model is allowed a looser
# drift because QDQ-level quantization rounds the weights.
PARITY_TOL_FP32: float = 1e-4
PARITY_TOL_INT8: float = 1e-2
# Max-abs size budget for the int8 artefact. ChordNet is ~1.3M params; int8
# weights are ~1.3 MB; with graph metadata and activations overhead the
# expected on-disk size is well under 5 MB. We fail hard at 10 MB.
INT8_SIZE_MAX_BYTES: int = 10 * 1024 * 1024

# ---------------------------------------------------------------------------
# PR-Y1.4 import guard — ChordNet2E1D lives on a parallel branch.
# ---------------------------------------------------------------------------

try:
    from training.model.chordnet_2e1d import ChordNet2E1D  # type: ignore[import-not-found]

    _CHORDNET_AVAILABLE: bool = True
    _CHORDNET_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover — exercised on fresh v3/main.
    ChordNet2E1D = None  # type: ignore[assignment,misc]
    _CHORDNET_AVAILABLE = False
    _CHORDNET_IMPORT_ERROR = exc


def _require_chordnet() -> None:
    if not _CHORDNET_AVAILABLE:
        raise RuntimeError(
            "apps/training/model/chordnet_2e1d.py is required for ONNX export. "
            "PR-Y1.4 (parallel) is landing it. Rebase this branch on top of "
            "PR-Y1.4 (or wait for the merge) before running --checkpoint. The "
            "underlying ImportError was: " + repr(_CHORDNET_IMPORT_ERROR)
        )


# ---------------------------------------------------------------------------
# Export result for programmatic callers (tests, CI).
# ---------------------------------------------------------------------------


@dataclass
class ExportResult:
    """Outcome of one end-to-end export run."""

    onnx_fp32_path: Path
    """Intermediate fp32 ONNX graph, kept for provenance."""

    onnx_int8_path: Path
    """Int8-quantized artefact — what the browser runtime consumes."""

    fp32_bytes: int
    int8_bytes: int
    pytorch_fp32_max_abs_diff: float
    pytorch_int8_max_abs_diff: float
    opset_version: int
    static_shape: tuple[int, int, int]
    sha256_fp32: str
    sha256_int8: str

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["onnx_fp32_path"] = str(self.onnx_fp32_path)
        d["onnx_int8_path"] = str(self.onnx_int8_path)
        d["static_shape"] = list(self.static_shape)
        return d


# ---------------------------------------------------------------------------
# Core helpers.
# ---------------------------------------------------------------------------


def _file_sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_random_model(
    *,
    output_mode: str = "structured",
    seed: int = 0,
):
    """Return a fresh ChordNet2E1D with deterministic random weights.

    Used by the ``--random-init`` CLI path, by the export parity test, and
    by any caller that wants to verify the export pipeline without
    materialising a trained checkpoint.
    """
    _require_chordnet()
    import torch  # lazy — see module docstring

    torch.manual_seed(seed)
    model = ChordNet2E1D(output_mode=output_mode)  # type: ignore[misc]
    model.eval()
    return model


def load_checkpoint(path: str | Path, *, map_location: str = "cpu"):
    """Load a ChordNet2E1D checkpoint (strict) and set it to eval mode.

    The checkpoint is expected to be a plain ``state_dict`` or a dict with
    a ``"model"`` or ``"state_dict"`` field (so trainer snapshots and raw
    exports both load). Unknown keys raise.
    """
    _require_chordnet()
    import torch

    blob = torch.load(str(path), map_location=map_location, weights_only=False)
    if isinstance(blob, dict) and "model" in blob:
        state = blob["model"]
    elif isinstance(blob, dict) and "state_dict" in blob:
        state = blob["state_dict"]
    else:
        state = blob
    model = ChordNet2E1D()  # type: ignore[misc]
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def _head_order(output_mode: str) -> list[str]:
    """Return the ONNX output names, in the order the graph exposes them."""
    if output_mode == "structured":
        return ["root", "triad", "bass_interval", "has_7th"]
    if output_mode == "flat170":
        return ["flat170"]
    raise ValueError(f"Unknown output_mode: {output_mode!r}")


class _StructuredExportWrapper:
    """torch.nn.Module adapter: dict head output → named tuple of tensors.

    ``torch.onnx.export`` wants the model to return tensors in a fixed order
    so it can pair them with ``output_names``. ChordNet2E1D returns a dict
    (friendlier for Python callers); this wrapper preserves that friendly
    API while giving ``torch.onnx.export`` a tuple it can inspect.
    """

    def __new__(cls, model):  # type: ignore[no-untyped-def]
        import torch.nn as nn

        head_names = _head_order(model.output_mode)

        class _Wrap(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.inner = model
                self.head_names = head_names

            def forward(self, cqt):  # type: ignore[no-untyped-def]
                logits = self.inner(cqt)
                return tuple(logits[name] for name in self.head_names)

        return _Wrap()


# ---------------------------------------------------------------------------
# Export pipeline.
# ---------------------------------------------------------------------------


def export_to_onnx(
    model,  # type: ignore[no-untyped-def]
    out_path: str | Path,
    *,
    opset_version: int = 17,
    dynamic: bool = False,
    static_shape: tuple[int, int, int] = (STATIC_BATCH, STATIC_FRAMES, STATIC_N_BINS),
) -> Path:
    """Run ``torch.onnx.export`` on a ChordNet2E1D model.

    Returns the output path. By default the graph is exported with STATIC
    input shapes (see module docstring). Pass ``dynamic=True`` to add
    ``dynamic_axes`` for batch and time dims.
    """
    _require_chordnet()
    import torch

    model.eval()
    batch, frames, n_bins = static_shape
    dummy = torch.randn(batch, frames, n_bins, dtype=torch.float32)
    wrapper = _StructuredExportWrapper(model)
    wrapper.eval()
    head_names = wrapper.head_names

    dynamic_axes: dict[str, dict[int, str]] | None = None
    if dynamic:
        dynamic_axes = {"cqt": {0: "batch", 1: "frames"}}
        for name in head_names:
            dynamic_axes[name] = {0: "batch", 1: "frames"}

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # external_data=False keeps weights inlined inside the single .onnx file.
    # ChordNet is ~1.3M params (~5 MB fp32, ~1.3 MB int8) — well under the
    # 2 GB protobuf limit — and ORT Web is easier to deploy as a single blob.
    torch.onnx.export(
        wrapper,
        (dummy,),
        str(out_path),
        input_names=["cqt"],
        output_names=head_names,
        opset_version=opset_version,
        dynamic_axes=dynamic_axes,
        do_constant_folding=True,
        external_data=False,
    )
    return out_path


def quantize_dynamic_int8(src_onnx: str | Path, dst_onnx: str | Path) -> Path:
    """Run ORT's dynamic int8 quantization on ``src_onnx``.

    Uses per-tensor dynamic quantization (``QuantType.QInt8``). The
    decision record notes this is the right default for a small conv/
    transformer stack on mobile: calibration-free, graph-size shrink
    ~4×, and no accuracy hit worth catching for the Y1 chord-model
    class boundaries we care about.
    """
    from onnxruntime.quantization import QuantType, quantize_dynamic

    dst = Path(dst_onnx)
    dst.parent.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(src_onnx),
        model_output=str(dst),
        weight_type=QuantType.QInt8,
    )
    return dst


def _ort_session(path: str | Path):  # type: ignore[no-untyped-def]
    """Create an ORT CPU InferenceSession on the given ONNX file."""
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(
        str(path),
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )


def _max_abs_diff_pytorch_vs_ort(
    model,  # type: ignore[no-untyped-def]
    onnx_path: str | Path,
    *,
    shape: tuple[int, int, int],
    seed: int = 1234,
) -> float:
    """Run the same deterministic random input through both and compare."""
    import torch

    torch.manual_seed(seed)
    dummy = torch.randn(*shape, dtype=torch.float32)

    model.eval()
    with torch.no_grad():
        torch_out = model(dummy)
    sess = _ort_session(onnx_path)
    onnx_out = sess.run(None, {"cqt": dummy.numpy().astype(np.float32)})
    head_names = _head_order(model.output_mode)

    max_diff = 0.0
    for name, arr in zip(head_names, onnx_out, strict=True):
        pt = torch_out[name].cpu().numpy().astype(np.float32)
        diff = float(np.max(np.abs(pt - arr.astype(np.float32))))
        if diff > max_diff:
            max_diff = diff
    return max_diff


def run_full_export(
    *,
    model,  # type: ignore[no-untyped-def]
    out_int8: str | Path,
    opset_version: int = 17,
    dynamic: bool = False,
    static_shape: tuple[int, int, int] = (STATIC_BATCH, STATIC_FRAMES, STATIC_N_BINS),
    fp32_tol: float = PARITY_TOL_FP32,
    int8_tol: float = PARITY_TOL_INT8,
    size_max_bytes: int = INT8_SIZE_MAX_BYTES,
) -> ExportResult:
    """End-to-end export + parity + size gates.

    Pipeline:
        1. Export ``model`` to an intermediate fp32 ONNX graph alongside
           ``out_int8`` (``<out_int8>.fp32.onnx``).
        2. Parity-check fp32 ONNX vs PyTorch; abort if drift > ``fp32_tol``.
        3. ``quantize_dynamic`` the fp32 graph to int8 at ``out_int8``.
        4. Parity-check int8 ONNX vs PyTorch; abort if drift > ``int8_tol``.
        5. Size-check the int8 artefact; abort if above ``size_max_bytes``.

    Returns the populated :class:`ExportResult`.
    """
    _require_chordnet()
    out_int8 = Path(out_int8)
    fp32_path = out_int8.with_suffix("")
    fp32_path = fp32_path.with_name(fp32_path.name + ".fp32.onnx")

    export_to_onnx(
        model,
        fp32_path,
        opset_version=opset_version,
        dynamic=dynamic,
        static_shape=static_shape,
    )
    fp32_bytes = fp32_path.stat().st_size

    fp32_diff = _max_abs_diff_pytorch_vs_ort(model, fp32_path, shape=static_shape)
    if fp32_diff > fp32_tol:
        raise RuntimeError(
            f"fp32 ONNX parity failed: max |pytorch - onnx| = {fp32_diff:.6g} "
            f"> tolerance {fp32_tol:.6g}. Export is broken; refusing to "
            f"quantize or ship. Common causes: an un-registered custom op, "
            f"a non-exportable control flow, or a BatchNorm folded with the "
            f"wrong eps."
        )

    quantize_dynamic_int8(fp32_path, out_int8)
    int8_bytes = out_int8.stat().st_size

    if int8_bytes > size_max_bytes:
        raise RuntimeError(
            f"int8 ONNX artefact is {int8_bytes:,} bytes "
            f"(> {size_max_bytes:,} B budget). ChordNet is ~1.3M params so "
            f"int8 should be ~1.3 MB; check for un-quantized Linear layers "
            f"or an unintentional embedding table."
        )

    int8_diff = _max_abs_diff_pytorch_vs_ort(model, out_int8, shape=static_shape)
    if int8_diff > int8_tol:
        raise RuntimeError(
            f"int8 ONNX parity failed: max |pytorch - onnx| = {int8_diff:.6g} "
            f"> tolerance {int8_tol:.6g}. The int8 drift is above what we "
            f"consider safe for argmax decoding. Common causes: a problem "
            f"layer that should be int8-excluded (LayerNorm, GRU gates), or "
            f"a numerically-unstable softmax downstream."
        )

    return ExportResult(
        onnx_fp32_path=fp32_path,
        onnx_int8_path=out_int8,
        fp32_bytes=fp32_bytes,
        int8_bytes=int8_bytes,
        pytorch_fp32_max_abs_diff=fp32_diff,
        pytorch_int8_max_abs_diff=int8_diff,
        opset_version=opset_version,
        static_shape=static_shape,
        sha256_fp32=_file_sha256(fp32_path),
        sha256_int8=_file_sha256(out_int8),
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m training.export_onnx",
        description="Export a ChordNet2E1D checkpoint to int8 ONNX (PR-Y1.5b).",
    )
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument(
        "--checkpoint",
        type=str,
        help="Path to a trained .pt checkpoint (state_dict or {'model':...}).",
    )
    g.add_argument(
        "--random-init",
        action="store_true",
        help="Use a random-init model (parity testing, CI, smoke tests).",
    )
    p.add_argument(
        "--out",
        required=True,
        help="Output path for the int8 ONNX artefact (e.g. dist/chordnet.int8.onnx).",
    )
    p.add_argument(
        "--opset",
        type=int,
        default=17,
        help="ONNX opset (default: 17, matches ORT Web).",
    )
    p.add_argument(
        "--quantize",
        choices=["int8", "none"],
        default="int8",
        help="Quantization mode. 'none' exports fp32 only (not shipped).",
    )
    p.add_argument(
        "--dynamic",
        action="store_true",
        help="Use dynamic batch/frames axes instead of the static (16, 128, 144) shape.",
    )
    p.add_argument(
        "--fp32-tol",
        type=float,
        default=PARITY_TOL_FP32,
        help=f"Max |pytorch - onnx-fp32| before abort (default {PARITY_TOL_FP32}).",
    )
    p.add_argument(
        "--int8-tol",
        type=float,
        default=PARITY_TOL_INT8,
        help=f"Max |pytorch - onnx-int8| before abort (default {PARITY_TOL_INT8}).",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Seed for --random-init (default 0).",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="Print the ExportResult as JSON on stdout.",
    )
    return p.parse_args(argv)


def _cli(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    _require_chordnet()

    if args.checkpoint:
        model = load_checkpoint(args.checkpoint)
    else:
        model = build_random_model(seed=args.seed)

    out_int8 = Path(args.out)
    if args.quantize == "none":
        # Export only; still run parity.
        export_to_onnx(model, out_int8, opset_version=args.opset, dynamic=args.dynamic)
        fp32_diff = _max_abs_diff_pytorch_vs_ort(
            model,
            out_int8,
            shape=(STATIC_BATCH, STATIC_FRAMES, STATIC_N_BINS),
        )
        if fp32_diff > args.fp32_tol:
            print(
                f"ERROR: fp32 parity failed: diff={fp32_diff:.6g} > {args.fp32_tol}",
                file=sys.stderr,
            )
            return 2
        result: dict[str, Any] = {
            "mode": "fp32_only",
            "out": str(out_int8),
            "fp32_max_abs_diff": fp32_diff,
            "size_bytes": out_int8.stat().st_size,
        }
    else:
        exp = run_full_export(
            model=model,
            out_int8=out_int8,
            opset_version=args.opset,
            dynamic=args.dynamic,
            fp32_tol=args.fp32_tol,
            int8_tol=args.int8_tol,
        )
        result = exp.to_dict()

    if args.json:
        print(json.dumps(result, sort_keys=True, indent=2))
    else:
        for k, v in result.items():
            print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())


__all__ = [
    "ExportResult",
    "build_random_model",
    "export_to_onnx",
    "load_checkpoint",
    "quantize_dynamic_int8",
    "run_full_export",
    "STATIC_BATCH",
    "STATIC_FRAMES",
    "STATIC_N_BINS",
    "PARITY_TOL_FP32",
    "PARITY_TOL_INT8",
    "INT8_SIZE_MAX_BYTES",
]
