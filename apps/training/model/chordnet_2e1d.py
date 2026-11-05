"""ChordNet student: 2 encoders (CQT local + mid-range) + 1 BiGRU decoder.

Factored two-head output per decision record v1.5
(``claude/phase-2-y1-chord-model-decision.md``):

* ``quality``: 25-class quality head (maj, min, dim, aug, sus2, sus4, maj6,
  min6, maj7, min7, 7, dim7, hdim7, minmaj7, maj9, min9, 9, 11, 13, add9,
  add11, 5(power), add6, aug7, N).
* ``bass``: 13-class bass head (``same`` + 11 semitone intervals + ``N``).

The module is intentionally self-contained: it declares its own alphabet
constants rather than importing ``training.model.alphabet``. That decoupling
keeps this PR independent of the parallel PR that resolves the merge markers
left in ``alphabet.py`` after the v3/main cross-merge.

Target: ~2-3M parameters so we fit comfortably on an L4 and export cleanly
to ONNX for the browser runtime (see ``export_onnx.py``).
"""

from __future__ import annotations

from typing import Any

import torch
from torch import nn

# ---------------------------------------------------------------------------
# Public constants (duplicated from alphabet.py by design — see module docstring)
# ---------------------------------------------------------------------------

CQT_N_BINS: int = 144
"""Default CQT bin count. Keep in sync with ``model/cqt-plan.v1.json``."""

N_QUALITY: int = 25
"""Factored quality-head class count."""

N_BASS: int = 13
"""Factored bass-head class count."""


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
        self.conv1 = nn.Conv1d(
            in_channels, out_channels, kernel_size=kernel_size, padding=pad
        )
        self.bn1 = nn.BatchNorm1d(out_channels)
        self.conv2 = nn.Conv1d(
            out_channels, out_channels, kernel_size=kernel_size, padding=pad
        )
        self.bn2 = nn.BatchNorm1d(out_channels)
        self.relu = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = self.proj(x)
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        return self.relu(out + residual)


# ---------------------------------------------------------------------------
# Main model
# ---------------------------------------------------------------------------


class ChordNet2E1D(nn.Module):
    """2-encoder / 1-decoder chord student with factored quality + bass heads.

    Architecture
    ------------
    * **Encoder 1** (``local_cnn``): Conv1d block widening ``n_bins → d_model``
      with a kernel-5 receptive field over frequency-channel features.
    * **Encoder 2** (``context_cnn``): a second Conv1d block at ``d_model``
      capturing mid-range temporal context.
    * **Decoder 1** (``temporal_rnn``): a 2-layer bidirectional GRU for
      long-range temporal smoothing. Output dim is ``2 * d_model``.
    * **Heads**: two independent ``Linear`` projections —
      ``quality: Linear(2 * d_model, 25)`` and ``bass: Linear(2 * d_model, 13)``.

    Parameters count at the defaults (``n_bins=144``, ``d_model=256``,
    ``gru_layers=2``) is ~2.5M, well inside the L4 / ONNX budget.

    Forward contract
    ----------------
    Input:  ``x`` of shape ``(B, T, n_bins)``.
    Output: ``{"quality": (B, T, 25), "bass": (B, T, 13)}``.
    """

    def __init__(
        self,
        n_bins: int = CQT_N_BINS,
        d_model: int = 256,
        gru_layers: int = 2,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        if n_bins <= 0:
            raise ValueError(f"n_bins must be positive, got {n_bins}")
        if d_model <= 0:
            raise ValueError(f"d_model must be positive, got {d_model}")
        if gru_layers <= 0:
            raise ValueError(f"gru_layers must be positive, got {gru_layers}")

        self.n_bins = n_bins
        self.d_model = d_model

        # ---- Encoder 1 — local CNN over frequency bins ----
        self.local_cnn = _ConvEncoderBlock(n_bins, d_model, kernel_size=5)

        # ---- Encoder 2 — mid-range context CNN ----
        self.context_cnn = _ConvEncoderBlock(d_model, d_model, kernel_size=5)

        # ---- Decoder 1 — temporal BiGRU ----
        self.temporal_rnn = nn.GRU(
            input_size=d_model,
            hidden_size=d_model,
            num_layers=gru_layers,
            batch_first=True,
            bidirectional=True,
            dropout=dropout if gru_layers > 1 else 0.0,
        )

        # ---- Factored output heads ----
        head_dim = 2 * d_model  # bidirectional → 2 * d_model
        self.quality_head = nn.Linear(head_dim, N_QUALITY)
        self.bass_head = nn.Linear(head_dim, N_BASS)

    # ------------------------------------------------------------------
    # Forward
    # ------------------------------------------------------------------

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        """Run the forward pass.

        Args:
            x: Tensor of shape ``(B, T, n_bins)`` — CQT frames.

        Returns:
            Dict with ``"quality"`` → ``(B, T, N_QUALITY)`` and ``"bass"`` →
            ``(B, T, N_BASS)`` logits.

        Raises:
            ValueError: If ``x`` is not 3D or the last dim is not ``n_bins``.
        """
        if x.ndim != 3:
            raise ValueError(f"input must be 3D (B, T, n_bins); got shape {tuple(x.shape)}")
        if x.shape[-1] != self.n_bins:
            raise ValueError(
                f"input last dim must be {self.n_bins}; got {x.shape[-1]}"
            )

        # Conv1d wants (B, C, T) — swap time and feature axes.
        h = x.transpose(1, 2)  # (B, n_bins, T)
        h = self.local_cnn(h)  # (B, d_model, T)
        h = self.context_cnn(h)  # (B, d_model, T)

        # Back to (B, T, d_model) for the recurrent decoder.
        h = h.transpose(1, 2)

        # The GRU is stateless at module level — new h_0 of zeros per batch.
        h, _ = self.temporal_rnn(h)  # (B, T, 2 * d_model)

        quality = self.quality_head(h)
        bass = self.bass_head(h)
        return {"quality": quality, "bass": bass}


__all__ = [
    "ChordNet2E1D",
    "CQT_N_BINS",
    "N_QUALITY",
    "N_BASS",
]
