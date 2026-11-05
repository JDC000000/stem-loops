"""ChordNet 2E1D: 2 encoders (CNN + Transformer) + 1 BiGRU decoder.

Clean-recipe student model for stem-loops V3 Y1 — architected from the
ChordMini 2E1D family (Jiang et al., ISMIR 2024) but **trained from scratch**
with no BTC or ChordMini pretrained weights loaded. The entire model is
MIT-architecture only and is distributed as Apache-2.0 trained weights per
the DATA-PROVENANCE.md attribution trail.

Architecture (per PR-Y1.4 spec):

- **Input**: CQT ``(batch, n_frames, 144)`` → Linear → 128-dim embed.
- **Encoder-1 (local CNN)**: 3× ``Conv1d(k=5, dilation=1/2/4, 128ch, ReLU + BN)``.
  Captures short-term harmonic texture (chord-tone presence, onset timbre).
- **Encoder-2 (global Transformer)**: 4× TransformerEncoderLayer
  (``d_model=128, nhead=4, dim_feedforward=512, dropout=0.1``). Captures
  long-range harmonic rhythm (chord duration, cadential motion).
- **Decoder**: BiGRU (128 hidden × 1 layer). PR-Y1.5 will add a CRF head on
  top of this GRU for Viterbi-smoothed decoding — the 2E1D model itself is
  the invariant architecture across PR-Y1.4 and PR-Y1.5.
- **Output**: two modes selected by ``output_mode``:
    - ``"structured"`` (default) — four heads: ``root`` (13), ``triad`` (5),
      ``bass_interval`` (13), ``has_7th`` (4). Collapsed to the 62-label
      alphabet at decode time by ``predict_segments``.
    - ``"flat170"`` — single 170-class head; collapsed to 62 labels via
      ``alphabet.collapse_170_to_60`` at decode time.

Parameter budget: ~1.3–1.5M for structured mode, ~1.4M for flat170. The
PR-Y1.4 spec called for "~2–5M params"; the faithful transcription of the
stated hyperparameters lands at the lower end of that range, which is what
the single-GPU / lifestyle-business training budget targets.

CQT plan dependency:
    ``cqt_plan.py`` is owned by PR-Y1.3 (parallel). This module imports
    ``PLAN`` only to read the frozen ``n_bins`` / ``version`` metadata — the
    import is **guarded**: if PR-Y1.3 has not landed yet, we fall back to
    a documented default ``n_bins=144`` and raise a clear error on any code
    path that needs the actual librosa_cqt(y, plan) function.
"""

from __future__ import annotations

from typing import Literal

import torch
import torch.nn as nn
import torch.nn.functional as F

from .alphabet import (
    ALPHABET_SHA,
    N_INDEX,
    NUM_LABELS,
    QUALITIES,
    ROOTS,
    collapse_170_to_60,
    decode_label,
)

# ---------------------------------------------------------------------------
# CQT-plan dependency (PR-Y1.3, parallel)
# ---------------------------------------------------------------------------

try:
    from .cqt_plan import PLAN as _PLAN  # noqa: F401 — re-exported for callers

    CQT_PLAN_VERSION: str = _PLAN.version
    CQT_N_BINS: int = _PLAN.n_bins
    _CQT_PLAN_AVAILABLE: bool = True
except ImportError:
    # PR-Y1.3 has not landed yet. We can still construct/forward/train the
    # model on arbitrary CQT tensors (shape (B, T, 144) is the only hard
    # contract at this layer). Any code path that needs the actual CQT
    # transform (train.py / eval.py end-to-end audio loading) raises with a
    # pointer to PR-Y1.3.
    CQT_PLAN_VERSION = "pending-pr-y1.3"
    CQT_N_BINS = 144
    _CQT_PLAN_AVAILABLE = False


def require_cqt_plan() -> None:
    """Raise if ``cqt_plan.py`` has not landed yet (PR-Y1.3)."""
    if not _CQT_PLAN_AVAILABLE:
        raise RuntimeError(
            "apps/training/model/cqt_plan.py is required for audio loading. "
            "PR-Y1.3 (parallel) is landing it. Rebase this branch on top of "
            "PR-Y1.3 or wait for it to merge before running train.py/eval.py "
            "against real audio."
        )


# ---------------------------------------------------------------------------
# Encoder-1: local 3-layer dilated CNN
# ---------------------------------------------------------------------------


class _DilatedConvBlock(nn.Module):
    """Single Conv1d(k=5, dilation=d) + BN + ReLU (same-padding)."""

    def __init__(self, channels: int, dilation: int) -> None:
        super().__init__()
        # Same-padding for k=5, dilation=d: pad = (k - 1) * d // 2
        pad = (5 - 1) * dilation // 2
        self.conv = nn.Conv1d(
            in_channels=channels,
            out_channels=channels,
            kernel_size=5,
            dilation=dilation,
            padding=pad,
        )
        self.bn = nn.BatchNorm1d(channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # (B, C, T) -> (B, C, T)
        return F.relu(self.bn(self.conv(x)))


class LocalCNNEncoder(nn.Module):
    """3-layer dilated CNN with dilations [1, 2, 4] (receptive field ~29 frames)."""

    def __init__(self, channels: int = 128) -> None:
        super().__init__()
        self.block1 = _DilatedConvBlock(channels, dilation=1)
        self.block2 = _DilatedConvBlock(channels, dilation=2)
        self.block3 = _DilatedConvBlock(channels, dilation=4)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Shape (B, T, C) → (B, T, C). Internally runs Conv1d on (B, C, T)."""
        x = x.transpose(1, 2)  # (B, T, C) -> (B, C, T)
        x = self.block1(x)
        x = self.block2(x)
        x = self.block3(x)
        return x.transpose(1, 2)  # (B, C, T) -> (B, T, C)


# ---------------------------------------------------------------------------
# Encoder-2: global 4-layer Transformer
# ---------------------------------------------------------------------------


class GlobalTransformerEncoder(nn.Module):
    """4-layer Transformer encoder (d_model=128, 4 heads, FFN=512, dropout=0.1)."""

    def __init__(
        self,
        d_model: int = 128,
        nhead: int = 4,
        dim_feedforward: int = 512,
        num_layers: int = 4,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=dim_feedforward,
            dropout=dropout,
            batch_first=True,
            activation="relu",
            norm_first=False,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=num_layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Shape (B, T, C) → (B, T, C)."""
        return self.encoder(x)


# ---------------------------------------------------------------------------
# Decoder: 1-layer BiGRU
# ---------------------------------------------------------------------------


class BiGRUDecoder(nn.Module):
    """1-layer BiGRU with 128 hidden units per direction (output: 256-dim)."""

    def __init__(self, input_size: int = 128, hidden_size: int = 128) -> None:
        super().__init__()
        self.gru = nn.GRU(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.out_dim = hidden_size * 2  # concat of fwd + bwd

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Shape (B, T, C) → (B, T, 2 * hidden_size)."""
        out, _ = self.gru(x)
        return out


# ---------------------------------------------------------------------------
# Output heads
# ---------------------------------------------------------------------------


class _StructuredHeads(nn.Module):
    """Four output heads for the structured factorised prediction.

    - ``root``: 13 classes (12 pitch classes + 1 "no chord").
    - ``triad``: 5 classes (maj/min/dim/aug/sus — matches ``QUALITIES``).
    - ``bass_interval``: 13 classes (12 intervals above root + 1 "same as root").
    - ``has_7th``: 4 classes (none / dim7 / min7 / maj7).
    """

    def __init__(self, hidden_dim: int) -> None:
        super().__init__()
        self.root = nn.Linear(hidden_dim, 13)
        self.triad = nn.Linear(hidden_dim, len(QUALITIES))  # 5
        self.bass_interval = nn.Linear(hidden_dim, 13)
        self.has_7th = nn.Linear(hidden_dim, 4)

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        return {
            "root": self.root(x),
            "triad": self.triad(x),
            "bass_interval": self.bass_interval(x),
            "has_7th": self.has_7th(x),
        }


class _Flat170Head(nn.Module):
    """Single 170-class head for the flat alphabet."""

    def __init__(self, hidden_dim: int) -> None:
        super().__init__()
        self.flat170 = nn.Linear(hidden_dim, 170)

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        return {"flat170": self.flat170(x)}


# ---------------------------------------------------------------------------
# Full ChordNet 2E1D
# ---------------------------------------------------------------------------


OutputMode = Literal["structured", "flat170"]


class ChordNet2E1D(nn.Module):
    """2-encoder (CNN + Transformer) / 1-decoder (BiGRU) chord model.

    Args:
        n_bins: CQT bin count (frozen at 144 by the Y1 CQT plan).
        d_model: Embedding width for both encoders and the decoder input.
        n_heads: Transformer attention heads.
        n_transformer_layers: Transformer depth.
        ffn_dim: Transformer FFN hidden width.
        dropout: Transformer dropout.
        gru_hidden: BiGRU hidden size per direction.
        output_mode: ``"structured"`` (default) or ``"flat170"``.
    """

    def __init__(
        self,
        n_bins: int = 144,
        d_model: int = 128,
        n_heads: int = 4,
        n_transformer_layers: int = 4,
        ffn_dim: int = 512,
        dropout: float = 0.1,
        gru_hidden: int = 128,
        output_mode: OutputMode = "structured",
    ) -> None:
        super().__init__()
        if output_mode not in ("structured", "flat170"):
            raise ValueError(f"output_mode must be 'structured' or 'flat170', got {output_mode!r}")

        self.n_bins = n_bins
        self.d_model = d_model
        self.output_mode: OutputMode = output_mode
        self.alphabet_sha = ALPHABET_SHA
        self.cqt_plan_version = CQT_PLAN_VERSION

        self.input_proj = nn.Linear(n_bins, d_model)
        self.local_cnn = LocalCNNEncoder(channels=d_model)
        self.global_tx = GlobalTransformerEncoder(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=ffn_dim,
            num_layers=n_transformer_layers,
            dropout=dropout,
        )
        self.decoder = BiGRUDecoder(input_size=d_model, hidden_size=gru_hidden)

        hidden_out = self.decoder.out_dim
        self.heads: nn.Module
        if output_mode == "structured":
            self.heads = _StructuredHeads(hidden_out)
        else:
            self.heads = _Flat170Head(hidden_out)

    # ------------------------------------------------------------------
    # Forward
    # ------------------------------------------------------------------

    def forward(self, cqt: torch.Tensor) -> dict[str, torch.Tensor]:
        """Compute per-frame head logits.

        Args:
            cqt: CQT tensor of shape ``(batch, n_frames, n_bins)``, float32.

        Returns:
            Dict of head logits. Keys depend on ``output_mode``:
            - structured: ``{"root", "triad", "bass_interval", "has_7th"}``.
            - flat170: ``{"flat170"}``.
        """
        if cqt.dim() != 3:
            raise ValueError(f"cqt must be 3D (B, T, n_bins); got shape {tuple(cqt.shape)}")
        if cqt.shape[-1] != self.n_bins:
            raise ValueError(
                f"cqt last dim must be {self.n_bins} (model n_bins); got {cqt.shape[-1]}"
            )

        x = self.input_proj(cqt)  # (B, T, d_model)
        x = self.local_cnn(x)  # (B, T, d_model)
        x = self.global_tx(x)  # (B, T, d_model)
        x = self.decoder(x)  # (B, T, 2 * gru_hidden)
        return self.heads(x)

    # ------------------------------------------------------------------
    # Segment-level prediction
    # ------------------------------------------------------------------

    def predict_segments(
        self,
        cqt_frames: torch.Tensor,
    ) -> list[tuple[int, int, str, float]]:
        """Argmax-decode frame logits to a list of ``(start_frame, end_frame, label, confidence)``.

        No smoothing, no Viterbi, no CRF — PR-Y1.5 wraps this with the HMM
        transition prior. For PR-Y1.4 we simply:

        1. Forward-pass the CQT.
        2. Collapse per-frame structured heads (or flat170) into a single
           62-class label stream.
        3. Merge consecutive identical labels into segments.

        Args:
            cqt_frames: CQT tensor, shape ``(n_frames, n_bins)`` **or**
                ``(1, n_frames, n_bins)``.

        Returns:
            List of ``(start_frame, end_frame_exclusive, label_string, mean_confidence)``.
            Empty list if the input has zero frames.
        """
        if cqt_frames.dim() == 2:
            cqt_frames = cqt_frames.unsqueeze(0)
        if cqt_frames.shape[0] != 1:
            raise ValueError("predict_segments expects a single clip (batch=1)")

        self.eval()
        with torch.no_grad():
            logits = self.forward(cqt_frames)  # dict
            labels, confidences = self._collapse_to_62(logits)
        labels_list: list[int] = labels.squeeze(0).tolist()
        conf_list: list[float] = confidences.squeeze(0).tolist()

        if not labels_list:
            return []

        segments: list[tuple[int, int, str, float]] = []
        seg_start = 0
        seg_label = labels_list[0]
        seg_confs: list[float] = [conf_list[0]]
        for t in range(1, len(labels_list)):
            if labels_list[t] != seg_label:
                segments.append(
                    (
                        seg_start,
                        t,
                        decode_label(seg_label),
                        float(sum(seg_confs) / len(seg_confs)),
                    )
                )
                seg_start = t
                seg_label = labels_list[t]
                seg_confs = [conf_list[t]]
            else:
                seg_confs.append(conf_list[t])
        segments.append(
            (
                seg_start,
                len(labels_list),
                decode_label(seg_label),
                float(sum(seg_confs) / len(seg_confs)),
            )
        )
        return segments

    # ------------------------------------------------------------------
    # Internal: logits → 62-class labels + per-frame confidence
    # ------------------------------------------------------------------

    def _collapse_to_62(self, logits: dict[str, torch.Tensor]) -> tuple[torch.Tensor, torch.Tensor]:
        """Return per-frame ``(labels, confidence)`` in the 62-class alphabet."""
        if self.output_mode == "structured":
            root_logits = logits["root"]  # (B, T, 13)
            triad_logits = logits["triad"]  # (B, T, 5)
            root_probs = F.softmax(root_logits, dim=-1)
            triad_probs = F.softmax(triad_logits, dim=-1)
            root_idx = root_probs.argmax(dim=-1)  # (B, T)
            triad_idx = triad_probs.argmax(dim=-1)  # (B, T)
            # root_idx == 12 -> N (no chord)
            is_n = root_idx == 12
            # label = root * 5 + triad for chords; N_INDEX for no-chord.
            labels = torch.where(
                is_n,
                torch.full_like(root_idx, N_INDEX),
                root_idx * len(QUALITIES) + triad_idx,
            )
            # Confidence = root_prob * triad_prob (for chord frames)
            #            = root_prob[N] (for N frames).
            root_best = root_probs.gather(-1, root_idx.unsqueeze(-1)).squeeze(-1)
            triad_best = triad_probs.gather(-1, triad_idx.unsqueeze(-1)).squeeze(-1)
            confidence = torch.where(is_n, root_best, root_best * triad_best)
            return labels, confidence

        # flat170 mode: argmax then collapse to 62.
        flat_logits = logits["flat170"]  # (B, T, 170)
        probs = F.softmax(flat_logits, dim=-1)
        best = probs.argmax(dim=-1)  # (B, T), 0..169
        confidence = probs.gather(-1, best.unsqueeze(-1)).squeeze(-1)

        # Vectorised 170→62 lookup via a precomputed table.
        table = self._collapse_table_170(device=flat_logits.device)
        labels = table[best]
        return labels, confidence

    _cached_collapse_table: torch.Tensor | None = None

    @classmethod
    def _collapse_table_170(cls, device: torch.device) -> torch.Tensor:
        """Precompute and cache the 170→62 index lookup as a tensor."""
        if cls._cached_collapse_table is None or cls._cached_collapse_table.device != device:
            table = torch.tensor(
                [collapse_170_to_60(i) for i in range(170)], dtype=torch.long, device=device
            )
            cls._cached_collapse_table = table
        return cls._cached_collapse_table


# ---------------------------------------------------------------------------
# Helpers for loss construction (used by train.py)
# ---------------------------------------------------------------------------


def num_output_classes(output_mode: OutputMode) -> int:
    """Return the max label index for the given output mode (for losses)."""
    if output_mode == "structured":
        # Caller handles four separate heads — this is the collapsed alphabet.
        return NUM_LABELS
    return 170


__all__ = [
    "ChordNet2E1D",
    "LocalCNNEncoder",
    "GlobalTransformerEncoder",
    "BiGRUDecoder",
    "OutputMode",
    "num_output_classes",
    "require_cqt_plan",
    "CQT_N_BINS",
    "CQT_PLAN_VERSION",
    "ROOTS",
    "QUALITIES",
]
