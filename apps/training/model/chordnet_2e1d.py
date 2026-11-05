"""ChordNet student: 2 encoders (CQT local + mid-range) + 1 BiGRU decoder.

Three selectable output modes (``output_mode``):

* ``"factored"`` (default, decision record v1.5,
  ``claude/phase-2-y1-chord-model-decision.md``): three heads --
  ``root`` (12 pitch classes + N = 13), ``quality`` (25) and ``bass`` (13).
  Logits are returned under ``root_logits`` / ``quality_logits`` /
  ``bass_logits``. Decoded with ``alphabet.decode_factored``.
* ``"structured"`` (PR-Y1.4 legacy): ``root`` (13), ``triad`` (5),
  ``bass_interval`` (13), ``has_7th`` (4); collapsed to the flat 62-label
  alphabet at decode time.
* ``"flat170"``: one 170-class head, collapsed to the flat 62-label alphabet
  via ``alphabet.collapse_170_to_60`` (cached lookup table).

Alphabet constants are imported from ``training.model.alphabet`` (the source
of truth) so the model and the eval / TypeScript mirrors cannot drift.

Target: ~3M parameters so we fit comfortably on an L4 and export cleanly
to ONNX for the browser runtime (see ``export_onnx.py``).
"""

from __future__ import annotations

from typing import Literal

import torch
import torch.nn.functional as F
from torch import nn

from .alphabet import (
    BASS_N_INDEX,
    BASS_SAME_INDEX,
    N_BASS,
    N_INDEX,
    N_QUALITY,
    NUM_ROOTS,
    QUALITIES,
    QUALITY_N_INDEX,
    collapse_170_to_60,
    decode_factored,
    decode_label,
)

CQT_N_BINS: int = 144
"""Default CQT bin count. Keep in sync with ``model/cqt-plan.v1.json``."""

OutputMode = Literal["factored", "structured", "flat170"]
_OUTPUT_MODES: tuple[str, ...] = ("factored", "structured", "flat170")

ROOT_N_INDEX: int = NUM_ROOTS
"""Index of the no-chord slot in the 13-way root head."""


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------


class _ConvEncoderBlock(nn.Module):
    """A thin Conv1d encoder block with BN + ReLU + residual.

    Input / output shape: ``(B, C, T)``. The first block widens ``C_in`` to
    ``C_out``; the stacked blocks keep ``C`` constant and add a residual.
    """

    def __init__(self, in_channels: int, out_channels: int, kernel_size: int = 5) -> None:
        super().__init__()
        pad = kernel_size // 2
        self.proj = (
            nn.Conv1d(in_channels, out_channels, kernel_size=1)
            if in_channels != out_channels
            else nn.Identity()
        )
        self.conv1 = nn.Conv1d(in_channels, out_channels, kernel_size=kernel_size, padding=pad)
        self.bn1 = nn.BatchNorm1d(out_channels)
        self.conv2 = nn.Conv1d(out_channels, out_channels, kernel_size=kernel_size, padding=pad)
        self.bn2 = nn.BatchNorm1d(out_channels)
        self.relu = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = self.proj(x)
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        return self.relu(out + residual)


class _FactoredHeads(nn.Module):
    """root (13) + quality (25) + bass (13)."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        self.root = nn.Linear(dim, NUM_ROOTS + 1)
        self.quality = nn.Linear(dim, N_QUALITY)
        self.bass = nn.Linear(dim, N_BASS)

    def forward(self, h: torch.Tensor) -> dict[str, torch.Tensor]:
        return {
            "root_logits": self.root(h),
            "quality_logits": self.quality(h),
            "bass_logits": self.bass(h),
        }


class _StructuredHeads(nn.Module):
    """PR-Y1.4 legacy: root (13), triad (5), bass_interval (13), has_7th (4)."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        self.root = nn.Linear(dim, NUM_ROOTS + 1)
        self.triad = nn.Linear(dim, len(QUALITIES))
        self.bass_interval = nn.Linear(dim, 13)
        self.has_7th = nn.Linear(dim, 4)

    def forward(self, h: torch.Tensor) -> dict[str, torch.Tensor]:
        return {
            "root": self.root(h),
            "triad": self.triad(h),
            "bass_interval": self.bass_interval(h),
            "has_7th": self.has_7th(h),
        }


class _Flat170Head(nn.Module):
    """Single 170-class head."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        self.flat170 = nn.Linear(dim, 170)

    def forward(self, h: torch.Tensor) -> dict[str, torch.Tensor]:
        return {"flat170": self.flat170(h)}


# ---------------------------------------------------------------------------
# Main model
# ---------------------------------------------------------------------------


class ChordNet2E1D(nn.Module):
    """2-encoder / 1-decoder chord student with selectable output heads.

    Architecture
    ------------
    * **Encoder 1** (``local_cnn``): Conv1d block widening ``n_bins -> d_model``.
    * **Encoder 2** (``context_cnn``): a second Conv1d block at ``d_model``.
    * **Decoder 1** (``temporal_rnn``): bidirectional GRU, output ``2 * d_model``.
    * **Heads** (``heads``): depend on ``output_mode`` (see module docstring).
      Only the selected mode's heads are instantiated, so every parameter
      receives gradient and the count stays at the backbone budget
      (~3.2M at the defaults).

    Forward contract
    ----------------
    Input:  ``x`` of shape ``(B, T, n_bins)``.
    Output: dict of per-frame logits; keys depend on ``output_mode``.
    """

    def __init__(
        self,
        n_bins: int = CQT_N_BINS,
        d_model: int = 256,
        gru_layers: int = 2,
        dropout: float = 0.1,
        output_mode: OutputMode = "factored",
    ) -> None:
        super().__init__()
        if output_mode not in _OUTPUT_MODES:
            raise ValueError(f"output_mode must be one of {_OUTPUT_MODES}, got {output_mode!r}")
        if n_bins <= 0:
            raise ValueError(f"n_bins must be positive, got {n_bins}")
        if d_model <= 0:
            raise ValueError(f"d_model must be positive, got {d_model}")
        if gru_layers <= 0:
            raise ValueError(f"gru_layers must be positive, got {gru_layers}")

        self.n_bins = n_bins
        self.d_model = d_model
        self.output_mode: OutputMode = output_mode

        self.local_cnn = _ConvEncoderBlock(n_bins, d_model, kernel_size=5)
        self.context_cnn = _ConvEncoderBlock(d_model, d_model, kernel_size=5)
        self.temporal_rnn = nn.GRU(
            input_size=d_model,
            hidden_size=d_model,
            num_layers=gru_layers,
            batch_first=True,
            bidirectional=True,
            dropout=dropout if gru_layers > 1 else 0.0,
        )

        head_dim = 2 * d_model
        self.heads: nn.Module
        if output_mode == "factored":
            self.heads = _FactoredHeads(head_dim)
        elif output_mode == "structured":
            self.heads = _StructuredHeads(head_dim)
        else:
            self.heads = _Flat170Head(head_dim)

    # ------------------------------------------------------------------
    # Forward
    # ------------------------------------------------------------------

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        """Per-frame logits for the configured ``output_mode``.

        Raises:
            ValueError: If ``x`` is not 3D or the last dim is not ``n_bins``.
        """
        if x.ndim != 3:
            raise ValueError(f"input must be 3D (B, T, n_bins); got shape {tuple(x.shape)}")
        if x.shape[-1] != self.n_bins:
            raise ValueError(f"input last dim must be {self.n_bins}; got {x.shape[-1]}")

        h = x.transpose(1, 2)  # (B, n_bins, T)
        h = self.local_cnn(h)
        h = self.context_cnn(h)
        h = h.transpose(1, 2)  # (B, T, d_model)
        h, _ = self.temporal_rnn(h)  # (B, T, 2 * d_model)
        return self.heads(h)

    # ------------------------------------------------------------------
    # Segment decoding
    # ------------------------------------------------------------------

    def predict_segments(self, cqt_frames: torch.Tensor) -> list[tuple[int, int, str, float]]:
        """Argmax-decode one clip into ``(start, end_exclusive, label, confidence)``.

        Args:
            cqt_frames: ``(n_frames, n_bins)`` or ``(1, n_frames, n_bins)``.

        Raises:
            ValueError: If the input holds more than one clip.
        """
        if cqt_frames.dim() == 2:
            cqt_frames = cqt_frames.unsqueeze(0)
        if cqt_frames.dim() != 3 or cqt_frames.shape[0] != 1:
            raise ValueError("predict_segments expects a single clip (batch=1)")

        was_training = self.training
        self.eval()
        try:
            with torch.no_grad():
                logits = self.forward(cqt_frames)
                labels, confs = self._decode_frames(logits)
        finally:
            self.train(was_training)

        if not labels:
            return []

        segments: list[tuple[int, int, str, float]] = []
        start = 0
        cur = labels[0]
        cur_confs = [confs[0]]
        for t in range(1, len(labels)):
            if labels[t] != cur:
                segments.append((start, t, cur, float(sum(cur_confs) / len(cur_confs))))
                start, cur, cur_confs = t, labels[t], [confs[t]]
            else:
                cur_confs.append(confs[t])
        segments.append((start, len(labels), cur, float(sum(cur_confs) / len(cur_confs))))
        return segments

    def _decode_frames(self, logits: dict[str, torch.Tensor]) -> tuple[list[str], list[float]]:
        """Per-frame label strings + confidences for a single-clip batch."""
        if self.output_mode == "factored":
            rp = F.softmax(logits["root_logits"][0], dim=-1)
            qp = F.softmax(logits["quality_logits"][0], dim=-1)
            bp = F.softmax(logits["bass_logits"][0], dim=-1)
            r, q, b = rp.argmax(-1), qp.argmax(-1), bp.argmax(-1)
            rc = rp.gather(-1, r[:, None])[:, 0]
            qc = qp.gather(-1, q[:, None])[:, 0]
            bc = bp.gather(-1, b[:, None])[:, 0]
            labels: list[str] = []
            confs: list[float] = []
            for ri, qi, bi, rci, qci, bci in zip(
                r.tolist(),
                q.tolist(),
                b.tolist(),
                rc.tolist(),
                qc.tolist(),
                bc.tolist(),
                strict=True,
            ):
                if ri == ROOT_N_INDEX or qi == QUALITY_N_INDEX:
                    labels.append("N")
                    confs.append(float(rci * qci))
                    continue
                if bi == BASS_N_INDEX:
                    # Degenerate: a chord frame cannot have an N bass; treat as root bass.
                    bi, bci = BASS_SAME_INDEX, 1.0
                labels.append(decode_factored(ri, qi, bi))
                confs.append(float(rci * qci * bci))
            return labels, confs

        if self.output_mode == "structured":
            rp = F.softmax(logits["root"][0], dim=-1)
            tp = F.softmax(logits["triad"][0], dim=-1)
            r, t = rp.argmax(-1), tp.argmax(-1)
            rc = rp.gather(-1, r[:, None])[:, 0]
            tc = tp.gather(-1, t[:, None])[:, 0]
            is_n = r == ROOT_N_INDEX
            idx = torch.where(is_n, torch.full_like(r, N_INDEX), r * len(QUALITIES) + t)
            conf = torch.where(is_n, rc, rc * tc)
            return [decode_label(i) for i in idx.tolist()], conf.tolist()

        # flat170: argmax, then collapse to the 62-label alphabet via the cached table.
        probs = F.softmax(logits["flat170"][0], dim=-1)
        best = probs.argmax(-1)
        conf = probs.gather(-1, best[:, None])[:, 0]
        table = self._collapse_table_170(probs.device)
        return [decode_label(i) for i in table[best].tolist()], conf.tolist()

    _cached_collapse_table: torch.Tensor | None = None

    @classmethod
    def _collapse_table_170(cls, device: torch.device) -> torch.Tensor:
        """Cached 170 -> 62 index lookup (class-level; rebuilt on device change)."""
        cached = cls._cached_collapse_table
        if cached is None or cached.device != device:
            cached = torch.tensor(
                [collapse_170_to_60(i) for i in range(170)], dtype=torch.long, device=device
            )
            cls._cached_collapse_table = cached
        return cached


__all__ = [
    "ChordNet2E1D",
    "CQT_N_BINS",
    "N_QUALITY",
    "N_BASS",
    "OutputMode",
    "ROOT_N_INDEX",
]
