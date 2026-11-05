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
- **Output**: three modes selected by ``output_mode`` (``"factored"`` is the
  v1.5 default; the other two are kept for backward compat):

    * ``"factored"`` (default, v1.5 per Exp A verdict) — three heads:
      ``root_logits`` (13 = 12 roots + N), ``quality_logits`` (25 per the
      quality alphabet), ``bass_logits`` (13 per the bass alphabet). These
      are decoded into Harte strings by ``decode_factored``.
    * ``"structured"`` (PR-Y1.4 legacy) — four heads: ``root`` (13),
      ``triad`` (5), ``bass_interval`` (13), ``has_7th`` (4). Collapsed to
      the 62-label flat alphabet at decode time.
    * ``"flat170"`` (PR-Y1.4 legacy) — single 170-class head; collapsed to
      62 labels via ``alphabet.collapse_170_to_60`` at decode time.

Parameter budget: ~1.3–1.5M for factored/structured, ~1.4M for flat170. The
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
    BASS_N_INDEX,
    BASS_SAME_INDEX,
    N_BASS,
    N_INDEX,
    N_QUALITY,
    NUM_LABELS,
    NUM_ROOTS,
    QUALITIES,
    QUALITY_N_INDEX,
    ROOTS,
    collapse_170_to_60,
    decode_factored,
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


class _FactoredHeads(nn.Module):
    """Three output heads for the factored (25 × 13) prediction (v1.5).

    * ``root_logits`` : 13 classes (12 pitch classes + 1 "no chord").
    * ``quality_logits``: ``N_QUALITY`` classes (25 — see ``alphabet.QUALITY_LABELS``).
    * ``bass_logits``  : ``N_BASS`` classes (13 — see ``alphabet.BASS_LABELS``).
    """

    def __init__(self, hidden_dim: int) -> None:
        super().__init__()
        self.root = nn.Linear(hidden_dim, NUM_ROOTS + 1)
        self.quality = nn.Linear(hidden_dim, N_QUALITY)
        self.bass = nn.Linear(hidden_dim, N_BASS)

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        return {
            "root_logits": self.root(x),
            "quality_logits": self.quality(x),
            "bass_logits": self.bass(x),
        }


class _StructuredHeads(nn.Module):
    """Four output heads for the legacy PR-Y1.4 structured prediction.

    Kept for backward compatibility. ``triad`` has 5 classes (the flat-60
    collapsed qualities: maj/min/dim/aug/sus). The factored v1.5 head
    replaces this.
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
    """Single 170-class head for the legacy flat alphabet (PR-Y1.4)."""

    def __init__(self, hidden_dim: int) -> None:
        super().__init__()
        self.flat170 = nn.Linear(hidden_dim, 170)

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        return {"flat170": self.flat170(x)}


# ---------------------------------------------------------------------------
# Full ChordNet 2E1D
# ---------------------------------------------------------------------------


OutputMode = Literal["factored", "structured", "flat170"]


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
        output_mode: one of ``"factored"`` (v1.5 default), ``"structured"``
            (PR-Y1.4 legacy), or ``"flat170"`` (PR-Y1.4 legacy).
    """

    _VALID_OUTPUT_MODES: tuple[str, ...] = ("factored", "structured", "flat170")

    def __init__(
        self,
        n_bins: int = 144,
        d_model: int = 128,
        n_heads: int = 4,
        n_transformer_layers: int = 4,
        ffn_dim: int = 512,
        dropout: float = 0.1,
        gru_hidden: int = 128,
        output_mode: OutputMode = "factored",
    ) -> None:
        super().__init__()
        if output_mode not in self._VALID_OUTPUT_MODES:
            raise ValueError(
                f"output_mode must be one of {self._VALID_OUTPUT_MODES}, got {output_mode!r}"
            )

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
        if output_mode == "factored":
            self.heads = _FactoredHeads(hidden_out)
        elif output_mode == "structured":
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
            - factored:  ``{"root_logits", "quality_logits", "bass_logits"}``.
            - structured: ``{"root", "triad", "bass_interval", "has_7th"}``.
            - flat170:   ``{"flat170"}``.
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
        transition prior. For PR-Y1.4b we simply:

        1. Forward-pass the CQT.
        2. Argmax each head independently (factored) or collapse into the
           flat 62-class label stream (structured / flat170).
        3. Decode to a Harte string per frame.
        4. Merge consecutive identical labels into segments.

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
            logits = self.forward(cqt_frames)
            labels, confidences = self._decode_frames(logits)

        if not labels:
            return []
        assert len(labels) == len(confidences)  # noqa: S101 — invariant

        segments: list[tuple[int, int, str, float]] = []
        seg_start = 0
        seg_label = labels[0]
        seg_confs: list[float] = [confidences[0]]
        for t in range(1, len(labels)):
            if labels[t] != seg_label:
                segments.append(
                    (
                        seg_start,
                        t,
                        seg_label,
                        float(sum(seg_confs) / len(seg_confs)),
                    )
                )
                seg_start = t
                seg_label = labels[t]
                seg_confs = [confidences[t]]
            else:
                seg_confs.append(confidences[t])
        segments.append(
            (
                seg_start,
                len(labels),
                seg_label,
                float(sum(seg_confs) / len(seg_confs)),
            )
        )
        return segments

    # ------------------------------------------------------------------
    # Internal: logits → per-frame Harte labels + confidence
    # ------------------------------------------------------------------

    def _decode_frames(self, logits: dict[str, torch.Tensor]) -> tuple[list[str], list[float]]:
        """Dispatch to the mode-specific decoder and return (labels, confidences)."""
        if self.output_mode == "factored":
            return self._decode_factored_frames(logits)
        if self.output_mode == "structured":
            return self._decode_structured_frames(logits)
        return self._decode_flat170_frames(logits)

    def _decode_factored_frames(
        self, logits: dict[str, torch.Tensor]
    ) -> tuple[list[str], list[float]]:
        root_logits = logits["root_logits"]  # (B=1, T, 13)
        quality_logits = logits["quality_logits"]  # (B=1, T, N_QUALITY)
        bass_logits = logits["bass_logits"]  # (B=1, T, N_BASS)

        root_probs = F.softmax(root_logits, dim=-1)
        quality_probs = F.softmax(quality_logits, dim=-1)
        bass_probs = F.softmax(bass_logits, dim=-1)

        root_idx = root_probs.argmax(dim=-1).squeeze(0)  # (T,)
        quality_idx = quality_probs.argmax(dim=-1).squeeze(0)  # (T,)
        bass_idx = bass_probs.argmax(dim=-1).squeeze(0)  # (T,)

        root_best = root_probs.gather(-1, root_idx.unsqueeze(0).unsqueeze(-1)).squeeze()
        quality_best = quality_probs.gather(-1, quality_idx.unsqueeze(0).unsqueeze(-1)).squeeze()
        bass_best = bass_probs.gather(-1, bass_idx.unsqueeze(0).unsqueeze(-1)).squeeze()

        labels: list[str] = []
        confidences: list[float] = []
        n_frames = root_idx.shape[0] if root_idx.dim() > 0 else 0
        root_list = root_idx.tolist() if n_frames else []
        quality_list = quality_idx.tolist() if n_frames else []
        bass_list = bass_idx.tolist() if n_frames else []
        root_conf = root_best.reshape(-1).tolist() if n_frames else []
        quality_conf = quality_best.reshape(-1).tolist() if n_frames else []
        bass_conf = bass_best.reshape(-1).tolist() if n_frames else []

        for t in range(n_frames):
            r = int(root_list[t])
            q = int(quality_list[t])
            b = int(bass_list[t])
            # root head index 12 = "no chord" slot → force quality to N and
            # bass to N so decode_factored emits "N".
            if r >= NUM_ROOTS:
                q = QUALITY_N_INDEX
                b = BASS_N_INDEX
                r = 0  # decode_factored clamps root when quality is N
            elif q == QUALITY_N_INDEX:
                # N quality overrides a chordal root prediction.
                r = 0
                b = BASS_N_INDEX
            # Chord frames: a predicted N-bass slot is a degenerate output;
            # clamp to "same-as-root" so decode_factored emits a clean label.
            elif b == BASS_N_INDEX:
                b = BASS_SAME_INDEX
            label = decode_factored(r, q, b)
            labels.append(label)
            # Confidence = product of per-head confidences.
            confidences.append(float(root_conf[t]) * float(quality_conf[t]) * float(bass_conf[t]))
        return labels, confidences

    def _decode_structured_frames(
        self, logits: dict[str, torch.Tensor]
    ) -> tuple[list[str], list[float]]:
        root_logits = logits["root"]  # (B=1, T, 13)
        triad_logits = logits["triad"]  # (B=1, T, 5)
        root_probs = F.softmax(root_logits, dim=-1)
        triad_probs = F.softmax(triad_logits, dim=-1)
        root_idx = root_probs.argmax(dim=-1)  # (B, T)
        triad_idx = triad_probs.argmax(dim=-1)  # (B, T)
        is_n = root_idx == 12
        labels_t = torch.where(
            is_n,
            torch.full_like(root_idx, N_INDEX),
            root_idx * len(QUALITIES) + triad_idx,
        )
        root_best = root_probs.gather(-1, root_idx.unsqueeze(-1)).squeeze(-1)
        triad_best = triad_probs.gather(-1, triad_idx.unsqueeze(-1)).squeeze(-1)
        confidence = torch.where(is_n, root_best, root_best * triad_best)
        labels_list = [decode_label(int(lbl)) for lbl in labels_t.squeeze(0).tolist()]
        return labels_list, confidence.squeeze(0).tolist()

    def _decode_flat170_frames(
        self, logits: dict[str, torch.Tensor]
    ) -> tuple[list[str], list[float]]:
        flat_logits = logits["flat170"]  # (B, T, 170)
        probs = F.softmax(flat_logits, dim=-1)
        best = probs.argmax(dim=-1)  # (B, T), 0..169
        confidence = probs.gather(-1, best.unsqueeze(-1)).squeeze(-1)

        table = self._collapse_table_170(device=flat_logits.device)
        labels_t = table[best]  # (B, T), 62-class indices
        labels_list = [decode_label(int(lbl)) for lbl in labels_t.squeeze(0).tolist()]
        return labels_list, confidence.squeeze(0).tolist()

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

    # ------------------------------------------------------------------
    # Legacy test-compat shim: _collapse_to_62(logits) -> (labels, conf)
    # ------------------------------------------------------------------
    #
    # PR-Y1.4's train.validate() still calls this method. In the factored
    # mode there is no 62-class label stream — we reuse the legacy flat
    # 5-quality collapse (maj/min/dim/aug/sus) built from the 25-quality
    # head so train.validate()'s MajMin proxy keeps working.

    def _collapse_to_62(self, logits: dict[str, torch.Tensor]) -> tuple[torch.Tensor, torch.Tensor]:
        """Return per-frame ``(labels_62, confidence)`` in the legacy flat alphabet.

        Caller: train.validate() (MajMin proxy). Tests for the factored path
        exercise ``_decode_factored_frames`` directly; this method is a
        convenience bridge back to the flat alphabet.
        """
        if self.output_mode == "structured":
            root_logits = logits["root"]
            triad_logits = logits["triad"]
            root_probs = F.softmax(root_logits, dim=-1)
            triad_probs = F.softmax(triad_logits, dim=-1)
            root_idx = root_probs.argmax(dim=-1)
            triad_idx = triad_probs.argmax(dim=-1)
            is_n = root_idx == 12
            labels = torch.where(
                is_n,
                torch.full_like(root_idx, N_INDEX),
                root_idx * len(QUALITIES) + triad_idx,
            )
            root_best = root_probs.gather(-1, root_idx.unsqueeze(-1)).squeeze(-1)
            triad_best = triad_probs.gather(-1, triad_idx.unsqueeze(-1)).squeeze(-1)
            confidence = torch.where(is_n, root_best, root_best * triad_best)
            return labels, confidence

        if self.output_mode == "flat170":
            flat_logits = logits["flat170"]
            probs = F.softmax(flat_logits, dim=-1)
            best = probs.argmax(dim=-1)
            confidence = probs.gather(-1, best.unsqueeze(-1)).squeeze(-1)
            table = self._collapse_table_170(device=flat_logits.device)
            labels = table[best]
            return labels, confidence

        # factored: collapse the 25-quality head onto the 5 flat-60 buckets.
        root_logits = logits["root_logits"]
        quality_logits = logits["quality_logits"]
        root_probs = F.softmax(root_logits, dim=-1)
        quality_probs = F.softmax(quality_logits, dim=-1)
        root_idx = root_probs.argmax(dim=-1)
        quality_idx = quality_probs.argmax(dim=-1)

        is_n = (root_idx == 12) | (quality_idx == QUALITY_N_INDEX)
        # Factored quality (25) -> flat-5 ({maj, min, dim, aug, sus}).
        qmap = self._quality_to_flat5_table(device=quality_logits.device)
        flat5_q = qmap[quality_idx]  # (B, T) with entries in [0, 5)
        labels = torch.where(
            is_n,
            torch.full_like(root_idx, N_INDEX),
            root_idx * len(QUALITIES) + flat5_q,
        )

        root_best = root_probs.gather(-1, root_idx.unsqueeze(-1)).squeeze(-1)
        quality_best = quality_probs.gather(-1, quality_idx.unsqueeze(-1)).squeeze(-1)
        confidence = torch.where(is_n, root_best, root_best * quality_best)
        return labels, confidence

    _cached_quality_to_flat5: torch.Tensor | None = None

    @classmethod
    def _quality_to_flat5_table(cls, device: torch.device) -> torch.Tensor:
        """Map each of the 25 factored qualities onto the flat-5 collapse."""
        if cls._cached_quality_to_flat5 is None or cls._cached_quality_to_flat5.device != device:
            # Flat-5 index: 0=maj, 1=min, 2=dim, 3=aug, 4=sus.
            table = torch.tensor(
                [
                    0,  # 0  maj
                    1,  # 1  min
                    2,  # 2  dim
                    3,  # 3  aug
                    4,  # 4  sus2 -> sus
                    4,  # 5  sus4 -> sus
                    0,  # 6  maj6 -> maj
                    1,  # 7  min6 -> min
                    0,  # 8  maj7 -> maj
                    1,  # 9  min7 -> min
                    0,  # 10 7    -> maj
                    2,  # 11 dim7 -> dim
                    2,  # 12 hdim7-> dim
                    1,  # 13 minmaj7 -> min
                    0,  # 14 maj9 -> maj
                    1,  # 15 min9 -> min
                    0,  # 16 9    -> maj
                    0,  # 17 11   -> maj
                    0,  # 18 13   -> maj
                    0,  # 19 add9 -> maj
                    0,  # 20 add11-> maj
                    0,  # 21 5    -> maj (power; no third, nearest is maj)
                    0,  # 22 add6 -> maj
                    3,  # 23 aug7 -> aug
                    0,  # 24 N    -> (ignored; N frames are filtered before this map)
                ],
                dtype=torch.long,
                device=device,
            )
            cls._cached_quality_to_flat5 = table
        return cls._cached_quality_to_flat5


# ---------------------------------------------------------------------------
# Helpers for loss construction (used by train.py)
# ---------------------------------------------------------------------------


def num_output_classes(output_mode: OutputMode) -> int:
    """Return a scalar size for logging — not all modes have a single answer.

    * factored: returns ``N_QUALITY + N_BASS + NUM_ROOTS + 1`` — the total
      softmax width across all three heads.
    * structured: returns the legacy 62-class alphabet size.
    * flat170: returns 170.
    """
    if output_mode == "factored":
        return (NUM_ROOTS + 1) + N_QUALITY + N_BASS
    if output_mode == "structured":
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
