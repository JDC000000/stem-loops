"""Torch-free BTC inference (DR-D1 option A, D1a): checkpoint reader, CQT features and the
forward pass of the Bi-directional Transformer for Chord recognition, in NumPy.

Ported from https://github.com/jayg996/BTC-ISMIR19 (code MIT, (c) 2019 Jonggwon Park) at
commit 2682317 (``btc_model.py``, ``utils/transformer_modules.py``,
``utils/mir_eval_modules.audio_file_to_features``, ``test.py``), large-vocabulary config
(170 classes). Eval mode only: every dropout is the identity.

Why NumPy and not torch: the worker image has no torch (a CPU torch wheel is hundreds of MB
and ~300 MB RSS on import), and the model is small (~3 M float32 params, 8 layers, 128
hidden, 108-frame windows), so a direct port is a few matrix products per window.

The checkpoint is the original ``btc_model_large_voca.pt`` (torch's legacy, pre-zip
``torch.save`` format). It is read with a RESTRICTED unpickler that resolves only the six
globals that file needs (``collections.OrderedDict``, ``torch._utils._rebuild_tensor_v2``,
``torch.FloatStorage``, ``numpy.dtype``, ``numpy.core.multiarray.scalar`` (or its NumPy 2
path), ``_codecs.encode``) to local stand-ins; any other global raises. The caller verifies the
file's pinned SHA-256 before this module reads a byte (``btc.verify_weights``).
"""

from __future__ import annotations

import codecs
import collections
import io
import math
import pickle
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# ----------------------------------------------------------------- config (run_config.yaml)
SAMPLE_RATE = 22050
INST_LEN_SEC = 10.0
N_BINS = 144
BINS_PER_OCTAVE = 24
HOP_LENGTH = 2048
TIMESTEP = 108
FEATURE_SIZE = 144
HIDDEN = 128
NUM_LAYERS = 8
NUM_HEADS = 4
NUM_CHORDS = 170
LN_EPS = 1e-6
# Seconds per output frame, exactly as test.py (inst_len / timestep), not hop / sr.
FRAME_SEC = INST_LEN_SEC / TIMESTEP

_LEGACY_MAGIC = 0x1950A86A20F9469CFC6C
_LEGACY_PROTOCOL = 1001


class BtcCheckpointError(RuntimeError):
    """The checkpoint is not the expected legacy torch file or lacks a parameter."""


# ----------------------------------------------------------------- checkpoint reader
@dataclass
class _Storage:
    key: str
    dtype: np.dtype
    size: int
    data: np.ndarray | None = None


@dataclass
class _LazyTensor:
    storage: _Storage
    offset: int
    shape: tuple[int, ...]
    stride: tuple[int, ...]

    def materialize(self) -> np.ndarray:
        buf = self.storage.data
        if buf is None:
            raise BtcCheckpointError(f"storage {self.storage.key} was never read")
        n = int(np.prod(self.shape)) if self.shape else 1
        if n == 0:
            return np.zeros(self.shape, dtype=buf.dtype)
        last = self.offset + sum((d - 1) * s for d, s in zip(self.shape, self.stride, strict=True))
        if self.offset < 0 or last >= buf.size:
            raise BtcCheckpointError("tensor view runs past its storage")
        view = np.lib.stride_tricks.as_strided(
            buf[self.offset :],
            shape=self.shape,
            strides=tuple(s * buf.itemsize for s in self.stride),
            writeable=False,
        )
        return np.array(view, dtype=np.float32, copy=True)


class _FloatStorageTag:
    """Stand-in for ``torch.FloatStorage`` (only ever used as a type tag)."""

    dtype = np.dtype("<f4")


def _rebuild_tensor_v2(
    storage, storage_offset, size, stride, requires_grad=False, hooks=None
):  # noqa: ARG001
    if not isinstance(storage, _Storage):
        raise BtcCheckpointError("tensor without a storage")
    return _LazyTensor(
        storage, int(storage_offset), tuple(int(s) for s in size), tuple(int(s) for s in stride)
    )


def _numpy_scalar(dtype, data=None):
    if not isinstance(dtype, np.dtype) or dtype.kind not in "fiu":
        raise BtcCheckpointError("unexpected numpy scalar dtype in checkpoint")
    if not isinstance(data, bytes | bytearray) or len(data) != dtype.itemsize:
        raise BtcCheckpointError("malformed numpy scalar in checkpoint")
    return np.frombuffer(bytes(data), dtype=dtype)[0]


def _np_dtype(name, align=False, copy=False):  # noqa: ARG001 — pickle passes these
    if name not in ("f8", "f4", "i8", "i4"):
        raise BtcCheckpointError(f"unexpected numpy dtype {name!r} in checkpoint")
    return np.dtype(name)


def _codecs_encode(obj, encoding="utf-8"):
    if encoding != "latin1" or not isinstance(obj, str):
        raise BtcCheckpointError("unexpected _codecs.encode use in checkpoint")
    return codecs.encode(obj, encoding)


_ALLOWED_GLOBALS = {
    ("collections", "OrderedDict"): collections.OrderedDict,
    ("torch._utils", "_rebuild_tensor_v2"): _rebuild_tensor_v2,
    ("torch", "FloatStorage"): _FloatStorageTag,
    ("numpy", "dtype"): _np_dtype,
    ("numpy.core.multiarray", "scalar"): _numpy_scalar,
    ("numpy._core.multiarray", "scalar"): _numpy_scalar,  # same, as NumPy 2 pickles it
    ("_codecs", "encode"): _codecs_encode,
}


class _HeaderUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        raise BtcCheckpointError(f"unexpected global {module}.{name} in checkpoint header")


class _CheckpointUnpickler(pickle.Unpickler):
    def __init__(self, fh, storages: dict[str, _Storage]):
        super().__init__(fh)
        self._storages = storages

    def find_class(self, module, name):
        try:
            return _ALLOWED_GLOBALS[(module, name)]
        except KeyError:
            raise BtcCheckpointError(f"unexpected global {module}.{name} in checkpoint") from None

    def persistent_load(self, pid):
        if not (isinstance(pid, tuple) and len(pid) == 6 and pid[0] == "storage"):
            raise BtcCheckpointError("unexpected persistent id in checkpoint")
        _, tag, key, _location, size, view = pid
        if tag is not _FloatStorageTag or view is not None:
            raise BtcCheckpointError("only plain float32 storages are supported")
        key = str(key)
        st = self._storages.get(key)
        if st is None:
            st = self._storages[key] = _Storage(key, _FloatStorageTag.dtype, int(size))
        return st


def load_checkpoint(path: Path) -> dict:
    """Read the legacy torch checkpoint into ``{"model": {name: float32 ndarray}, "mean":
    float, "std": float}`` without torch. Raises ``BtcCheckpointError`` on anything else."""
    raw = Path(path).read_bytes()
    fh = io.BytesIO(raw)
    try:
        magic = _HeaderUnpickler(fh).load()
        proto = _HeaderUnpickler(fh).load()
        sys_info = _HeaderUnpickler(fh).load()
    except (pickle.UnpicklingError, EOFError, ValueError) as exc:
        raise BtcCheckpointError(f"not a legacy torch checkpoint: {exc}") from exc
    if magic != _LEGACY_MAGIC or proto != _LEGACY_PROTOCOL:
        raise BtcCheckpointError("not a legacy torch checkpoint (magic/protocol)")
    if not isinstance(sys_info, dict) or not sys_info.get("little_endian", False):
        raise BtcCheckpointError("big-endian checkpoints are not supported")

    storages: dict[str, _Storage] = {}
    try:
        obj = _CheckpointUnpickler(fh, storages).load()
        keys = _HeaderUnpickler(fh).load()
    except (pickle.UnpicklingError, EOFError, ValueError, TypeError) as exc:
        raise BtcCheckpointError(f"unreadable checkpoint body: {exc}") from exc
    if not isinstance(keys, list):
        raise BtcCheckpointError("checkpoint storage key list missing")
    for key in keys:
        st = storages.get(str(key))
        if st is None:
            raise BtcCheckpointError(f"storage {key} listed but never referenced")
        head = fh.read(8)
        if len(head) != 8:
            raise BtcCheckpointError("checkpoint truncated (storage size)")
        (count,) = struct.unpack("<q", head)
        if count != st.size or count < 0:
            raise BtcCheckpointError("checkpoint storage size disagrees with its header")
        nbytes = count * st.dtype.itemsize
        blob = fh.read(nbytes)
        if len(blob) != nbytes:
            raise BtcCheckpointError("checkpoint truncated (storage data)")
        st.data = np.frombuffer(blob, dtype=st.dtype)
    if fh.read(1):
        raise BtcCheckpointError("trailing bytes after the last storage")

    if not isinstance(obj, dict) or not {"model", "mean", "std"} <= set(obj):
        raise BtcCheckpointError("checkpoint lacks model/mean/std")
    model = {}
    for name, value in obj["model"].items():
        if not isinstance(value, _LazyTensor):
            raise BtcCheckpointError(f"parameter {name} is not a tensor")
        model[str(name)] = value.materialize()
    mean, std = float(obj["mean"]), float(obj["std"])
    if not (math.isfinite(mean) and math.isfinite(std) and std > 0):
        raise BtcCheckpointError("checkpoint mean/std are not usable")
    return {"model": model, "mean": mean, "std": std}


# ----------------------------------------------------------------- model
def _timing_signal(length: int, channels: int) -> np.ndarray:
    position = np.arange(length)
    num_timescales = channels // 2
    log_inc = math.log(1.0e4 / 1.0) / (float(num_timescales) - 1)
    inv = np.exp(np.arange(num_timescales).astype(np.float64) * -log_inc)
    scaled = np.expand_dims(position, 1) * np.expand_dims(inv, 0)
    signal = np.concatenate([np.sin(scaled), np.cos(scaled)], axis=1)
    signal = np.pad(signal, [[0, 0], [0, channels % 2]], "constant")
    return signal.astype(np.float32)


def _layer_norm(x: np.ndarray, gamma: np.ndarray, beta: np.ndarray) -> np.ndarray:
    # BTC's LayerNorm: unbiased std (torch .std default) and eps added to the std.
    mean = x.mean(-1, keepdims=True)
    std = x.std(-1, keepdims=True, ddof=1)
    return gamma * (x - mean) / (std + LN_EPS) + beta


def _softmax(x: np.ndarray) -> np.ndarray:
    m = x.max(-1, keepdims=True)
    e = np.exp(x - m)
    return e / e.sum(-1, keepdims=True)


def _conv1d_same3(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Conv1d, kernel 3, zero padding (1, 1). ``x`` [B, T, Cin], ``w`` [Cout, Cin, 3]."""
    xp = np.pad(x, ((0, 0), (1, 1), (0, 0)))
    t = x.shape[1]
    return (
        xp[:, 0:t] @ w[:, :, 0].T
        + xp[:, 1 : t + 1] @ w[:, :, 1].T
        + xp[:, 2 : t + 2] @ w[:, :, 2].T
        + b
    )


class BtcModel:
    """BTC_model (large vocabulary) forward pass in eval mode."""

    def __init__(self, params: dict[str, np.ndarray]) -> None:
        self.p = params
        self._check_shapes()
        self.timing = _timing_signal(TIMESTEP, HIDDEN)
        fwd = np.triu(np.full((TIMESTEP, TIMESTEP), -np.inf, dtype=np.float32), 1)
        self.masks = {"attn_block": fwd, "backward_attn_block": fwd.T.copy()}

    def _w(self, name: str) -> np.ndarray:
        try:
            return self.p[name]
        except KeyError:
            raise BtcCheckpointError(f"checkpoint lacks parameter {name}") from None

    def _check_shapes(self) -> None:
        pre = "self_attn_layers."
        want = {
            pre + "embedding_proj.weight": (HIDDEN, FEATURE_SIZE),
            pre + "layer_norm.gamma": (HIDDEN,),
            "output_layer.output_projection.weight": (NUM_CHORDS, HIDDEN),
            "output_layer.output_projection.bias": (NUM_CHORDS,),
        }
        for i in range(NUM_LAYERS):
            want[f"{pre}self_attn_layers.{i}.linear.weight"] = (HIDDEN, 2 * HIDDEN)
            for blk in ("attn_block", "backward_attn_block"):
                base = f"{pre}self_attn_layers.{i}.{blk}."
                for lin in ("query", "key", "value", "output"):
                    want[f"{base}multi_head_attention.{lin}_linear.weight"] = (HIDDEN, HIDDEN)
                for c in (0, 1):
                    want[f"{base}positionwise_convolution.layers.{c}.conv.weight"] = (
                        HIDDEN,
                        HIDDEN,
                        3,
                    )
        for name, shape in want.items():
            if self._w(name).shape != shape:
                raise BtcCheckpointError(f"{name} has shape {self._w(name).shape}, want {shape}")

    def _mha(self, x: np.ndarray, base: str, mask: np.ndarray) -> np.ndarray:
        b, t, _ = x.shape
        d = HIDDEN // NUM_HEADS

        def heads(m: np.ndarray) -> np.ndarray:
            return m.reshape(b, t, NUM_HEADS, d).transpose(0, 2, 1, 3)

        q = heads(x @ self._w(base + "query_linear.weight").T) * (d**-0.5)
        k = heads(x @ self._w(base + "key_linear.weight").T)
        v = heads(x @ self._w(base + "value_linear.weight").T)
        weights = _softmax(q @ k.transpose(0, 1, 3, 2) + mask[:t, :t])
        ctx = (weights @ v).transpose(0, 2, 1, 3).reshape(b, t, HIDDEN)
        return ctx @ self._w(base + "output_linear.weight").T

    def _block(self, x: np.ndarray, base: str, mask: np.ndarray) -> np.ndarray:
        xn = _layer_norm(
            x, self._w(base + "layer_norm_mha.gamma"), self._w(base + "layer_norm_mha.beta")
        )
        x = x + self._mha(xn, base + "multi_head_attention.", mask)
        xn = _layer_norm(
            x, self._w(base + "layer_norm_ffn.gamma"), self._w(base + "layer_norm_ffn.beta")
        )
        y = xn
        for c in (0, 1):  # BTC applies ReLU after EVERY conv, the last one included
            pc = f"{base}positionwise_convolution.layers.{c}.conv."
            y = np.maximum(_conv1d_same3(y, self._w(pc + "weight"), self._w(pc + "bias")), 0.0)
        return x + y

    def logits(self, windows: np.ndarray) -> np.ndarray:
        """``windows`` [B, TIMESTEP, FEATURE_SIZE] normalised CQT -> logits [B, TIMESTEP, 170]."""
        pre = "self_attn_layers."
        x = windows.astype(np.float32) @ self._w(pre + "embedding_proj.weight").T
        x = x + self.timing[: windows.shape[1]]
        for i in range(NUM_LAYERS):
            li = f"{pre}self_attn_layers.{i}."
            fwd = self._block(x, li + "attn_block.", self.masks["attn_block"])
            bwd = self._block(x, li + "backward_attn_block.", self.masks["backward_attn_block"])
            x = np.concatenate([fwd, bwd], axis=2) @ self._w(li + "linear.weight").T + self._w(
                li + "linear.bias"
            )
        x = _layer_norm(x, self._w(pre + "layer_norm.gamma"), self._w(pre + "layer_norm.beta"))
        out = "output_layer.output_projection."
        return x @ self._w(out + "weight").T + self._w(out + "bias")


# ----------------------------------------------------------------- features + decode
def cqt_features(wav: np.ndarray) -> np.ndarray:
    """log|CQT| per 10 s chunk, concatenated: BTC's ``audio_file_to_features`` at 22.05 kHz.
    Returns [frames, 144] float32. A tail shorter than one hop is dropped (< 0.1 s)."""
    import librosa  # noqa: PLC0415 — heavy import, only when BTC runs

    chunk = int(SAMPLE_RATE * INST_LEN_SEC)
    parts = []
    start = 0
    while start < len(wav):
        piece = wav[start : start + chunk]
        if len(piece) < HOP_LENGTH and parts:
            break
        c = librosa.cqt(
            piece,
            sr=SAMPLE_RATE,
            n_bins=N_BINS,
            bins_per_octave=BINS_PER_OCTAVE,
            hop_length=HOP_LENGTH,
        )
        parts.append(np.log(np.abs(c) + 1e-6).astype(np.float32))
        start += chunk
    if not parts:
        return np.zeros((0, N_BINS), dtype=np.float32)
    return np.concatenate(parts, axis=1).T


def predict_frames(
    model: BtcModel, feature: np.ndarray, mean: float, std: float
) -> tuple[np.ndarray, np.ndarray]:
    """Frame class ids and their softmax probability, as test.py: normalise, zero-pad to a
    multiple of 108, run each 108-frame window independently, argmax. Padding is cut off."""
    n = feature.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    x = (feature - mean) / std
    num_pad = TIMESTEP - (n % TIMESTEP)  # test.py pads a full window when n % 108 == 0
    x = np.pad(x, ((0, num_pad), (0, 0)))
    windows = x.reshape(-1, TIMESTEP, FEATURE_SIZE)
    ids, probs = [], []
    for i in range(0, windows.shape[0], 8):  # bounded batch: memory independent of length
        lg = model.logits(windows[i : i + 8])
        pr = _softmax(lg)
        ids.append(lg.argmax(-1).reshape(-1))
        probs.append(pr.max(-1).reshape(-1))
    return np.concatenate(ids)[:n], np.concatenate(probs)[:n].astype(np.float32)


def frames_to_rows(
    ids: np.ndarray, probs: np.ndarray, vocab: list[str]
) -> list[tuple[float, float, str, float]]:
    """Runs of equal class -> ``(start_sec, end_sec, raw_label, mean_prob)``."""
    rows = []
    n = len(ids)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and ids[j + 1] == ids[i]:
            j += 1
        rows.append(
            (i * FRAME_SEC, (j + 1) * FRAME_SEC, vocab[int(ids[i])], float(probs[i : j + 1].mean()))
        )
        i = j + 1
    return rows


def load_audio(path: Path) -> np.ndarray:
    import librosa  # noqa: PLC0415

    wav, _ = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return wav.astype(np.float32)
