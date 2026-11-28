"""BTC chord provider (DR-D1 option A, built after Jon's D1a). No torch anywhere.

Covers: factory selection (lazy import, default still klangio), ChordResult / play.chords.json
shape the web loader accepts, label normalisation (all 170 BTC classes + invalid labels),
segment cleaning + confidence, the pinned-weights checks, the torch-free legacy checkpoint
reader (restricted unpickler), the NumPy model against a torch-generated reference fixture,
attention-mask direction, windowing/decoding, CQT features, the default runner end to end,
the build-time fetch script, and the pipeline hook (btc never touches the Klangio ledger or
quota; klangio regression). Real weights: set BTC_WEIGHTS_PATH (see
scripts/fetch_btc_weights.py) to also run the real-weights smoke test.
"""

from __future__ import annotations

import collections
import hashlib
import importlib.util
import io
import json
import math
import os
import pickle
import struct
import sys
import types
from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from tests.btc_reference_params import random_params, random_windows
from tests.test_pipeline_chord_hook import _make_stems, _write_wav
from worker import pipeline
from worker.chord_providers import btc, btc_model
from worker.chord_providers.btc import (
    BTC_PROVIDER_VERSION,
    BtcChordSource,
    BtcWeightsMissing,
    btc_vocabulary,
    clean_segments,
    normalize_btc_label,
    verify_weights,
)
from worker.chord_providers.btc_model import BtcCheckpointError, BtcModel, load_checkpoint
from worker.chord_source import ChordResult, get_chord_source, is_valid_harte_label

WORKER = Path(__file__).resolve().parents[1]
GOLDEN = WORKER.parents[1] / "fixtures" / "contracts" / "play-chords.golden.json"
REFERENCE = WORKER / "tests" / "fixtures" / "btc" / "reference_logits.json"
FAKE_SHA = "ab" * 32


def _fake_runner(rows):
    calls: list[Path] = []

    def run(path: Path):
        calls.append(path)
        return rows

    run.calls = calls  # type: ignore[attr-defined]
    return run


@pytest.fixture
def wav(tmp_path: Path) -> Path:
    p = tmp_path / "harmonic_mix.wav"
    _write_wav(p, 220.0, secs=2.0)
    return p


@pytest.fixture(autouse=True)
def _fresh_runner_cache():
    btc._RUNNER_CACHE.clear()
    yield
    btc._RUNNER_CACHE.clear()


# ----------------------------- legacy checkpoint writer (test-only, no torch) ----------
def _write_legacy_checkpoint(path: Path, params: dict, mean=-2.0, std=1.5, **tweak) -> None:
    """Write ``params`` in torch's legacy (pre-zip) ``torch.save`` layout, the format of the
    real ``btc_model_large_voca.pt``: magic, protocol, sys_info, main pickle (tensors as
    ``_rebuild_tensor_v2`` over persistent-id storages), storage key list, then per storage
    an int64 element count + raw little-endian float32 data. Fake ``torch`` modules exist only
    while pickling so the globals are written by name."""
    fake_torch = types.ModuleType("torch")
    fake_utils = types.ModuleType("torch._utils")

    class FloatStorage:  # noqa: D401 — name must match torch's
        pass

    FloatStorage.__module__ = "torch"
    FloatStorage.__qualname__ = "FloatStorage"

    def _rebuild_tensor_v2(*a):  # pragma: no cover — never called, only named
        raise AssertionError

    _rebuild_tensor_v2.__module__ = "torch._utils"
    _rebuild_tensor_v2.__qualname__ = "_rebuild_tensor_v2"
    fake_torch.FloatStorage = FloatStorage
    fake_torch._utils = fake_utils
    fake_utils._rebuild_tensor_v2 = _rebuild_tensor_v2

    class Tensor:
        def __init__(self, key, arr):
            self.key, self.arr = key, arr

        def __reduce__(self):
            stride = tuple(s // 4 for s in self.arr.strides)
            return (
                _rebuild_tensor_v2,
                (
                    ("storage", self.key),
                    0,
                    self.arr.shape,
                    stride,
                    False,
                    collections.OrderedDict(),
                ),
            )

    storages = []
    state = collections.OrderedDict()
    for i, (name, arr) in enumerate(params.items()):
        arr = np.ascontiguousarray(arr, dtype="<f4")
        key = str(1000 + i)
        storages.append((key, arr))
        state[name] = Tensor(key, arr)
    obj = {
        "model": state,
        "mean": np.float64(mean),
        "std": np.float64(std),
        **tweak.get("extra", {}),
    }

    class P(pickle.Pickler):
        def persistent_id(self, o):
            if isinstance(o, tuple) and len(o) == 2 and o[0] == "storage":
                arr = dict(storages)[o[1]]
                return ("storage", FloatStorage, o[1], "cpu", arr.size, None)
            return None

    saved = {k: sys.modules.get(k) for k in ("torch", "torch._utils")}
    sys.modules["torch"], sys.modules["torch._utils"] = fake_torch, fake_utils
    try:
        buf = io.BytesIO()
        for head in tweak.get("header", (btc_model._LEGACY_MAGIC, btc_model._LEGACY_PROTOCOL)):
            pickle.dump(head, buf, protocol=2)
        pickle.dump({"protocol_version": 1001, "little_endian": True}, buf, protocol=2)
        P(buf, protocol=2).dump(obj)
        pickle.dump([k for k, _ in storages], buf, protocol=2)
        for _, arr in storages:
            buf.write(struct.pack("<q", tweak.get("count", arr.size)))
            buf.write(arr.tobytes())
        buf.write(tweak.get("trailer", b""))
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    path.write_bytes(buf.getvalue())


# ----------------------------- factory -----------------------------
def test_factory_selects_btc_explicitly_and_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    assert isinstance(get_chord_source("btc"), BtcChordSource)
    monkeypatch.setenv("CHORDS_PROVIDER", "btc")
    assert isinstance(get_chord_source(), BtcChordSource)


def test_factory_default_is_still_klangio(monkeypatch: pytest.MonkeyPatch) -> None:
    from worker.chord_providers.klangio import KlangioChordSource

    monkeypatch.delenv("CHORDS_PROVIDER", raising=False)
    assert isinstance(get_chord_source(), KlangioChordSource)
    assert os.environ.get("CHORDS_PROVIDER") is None


def test_btc_never_imports_torch(
    wav: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert "torch" not in sys.modules
    w = tmp_path / "w.pt"
    _write_legacy_checkpoint(w, random_params())
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(w))
    monkeypatch.setattr(btc, "BTC_WEIGHTS_SHA256", hashlib.sha256(w.read_bytes()).hexdigest())
    get_chord_source("btc").recognize(wav)
    assert "torch" not in sys.modules


# ----------------------------- result shape -----------------------------
def test_fake_runner_produces_valid_chord_result(wav: Path) -> None:
    runner = _fake_runner(
        [(0.0, 0.5, "C"), (0.5, 1.0, "A:min"), (1.0, 2.0, "G:7"), (2.0, 9.0, "N")]
    )
    res = BtcChordSource(runner, provider_version=FAKE_SHA).recognize(wav, ledger=None)
    assert isinstance(res, ChordResult)
    assert runner.calls == [wav]
    assert res.provider == "btc" and res.provider_version == FAKE_SHA
    assert res.key is None
    assert res.duration_sec == pytest.approx(2.0, abs=0.01)
    assert [s.label for s in res.segments] == ["C:maj", "A:min", "G:7"]  # N past the end clamped
    for s in res.segments:
        assert is_valid_harte_label(s.label) and s.confidence == 1.0
        assert 0.0 <= s.start_sec < s.end_sec <= res.duration_sec


def test_default_provider_version_names_the_pinned_weights(wav: Path) -> None:
    res = BtcChordSource(_fake_runner([(0.0, 1.0, "C")])).recognize(wav)
    assert res.provider_version == BTC_PROVIDER_VERSION == "btc-large-voca@1673d23f8f9a"
    assert len(res.provider_version) <= 64  # chord_edits.provider_version cap (migration 026)


def test_play_chords_json_matches_golden_shape_and_loader_rules(wav: Path) -> None:
    res = BtcChordSource(
        _fake_runner([(0.0, 1.0, "D:min7", 0.4), (1.0, 2.0, "F#:hdim7", 0.9)])
    ).recognize(wav)
    payload = json.loads(json.dumps(asdict(res)))
    golden = json.loads(GOLDEN.read_text())["payload"]
    assert set(payload) == set(golden)
    assert set(payload["segments"][0]) == set(golden["segments"][0])
    for row in payload["segments"]:
        assert math.isfinite(row["start_sec"]) and math.isfinite(row["end_sec"])
        assert isinstance(row["label"], str) and row["label"]
        assert row["end_sec"] >= row["start_sec"]
        assert 0.0 <= row["confidence"] <= 1.0
    assert payload["provider"] == "btc"


def test_ledger_is_never_touched(wav: Path) -> None:
    ledger = MagicMock()
    BtcChordSource(_fake_runner([(0.0, 1.0, "C")])).recognize(wav, ledger=ledger)
    assert ledger.mock_calls == []


def test_missing_audio_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        BtcChordSource(_fake_runner([])).recognize(tmp_path / "nope.wav")


# ----------------------------- labels -----------------------------
def test_vocabulary_is_170_classes_and_all_normalise_to_valid_harte() -> None:
    vocab = btc_vocabulary()
    assert len(vocab) == 170 and vocab[168:] == ["X", "N"]
    assert vocab[0] == "C:min" and vocab[1] == "C" and vocab[14] == "C#:min"
    assert vocab[167] == "B:sus4" and vocab[9] == "C:7"
    mapped = [normalize_btc_label(v) for v in vocab]
    assert all(is_valid_harte_label(m) for m in mapped)
    assert "X" not in mapped[:168], "no lossy mapping: every BTC quality is in the Harte set"
    assert len(set(mapped[:168])) == 168


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("C", "C:maj"),
        ("c#:min7", "C#:min7"),
        ("Db:maj7", "Db:maj7"),
        ("A:minor", "A:min"),
        ("G:7/3", "G:7/3"),
        ("N", "N"),
        ("", "N"),
        ("X", "X"),
        ("C:weird", "X"),
        ("H:maj", "X"),
        ("C:maj/Q", "X"),
        ("Cb#:maj", "X"),
        (None, "X"),
        (42, "X"),
    ],
)
def test_invalid_labels_are_mapped_never_shipped(raw: object, want: str) -> None:
    out = normalize_btc_label(raw)
    assert out == want
    assert is_valid_harte_label(out)


# ----------------------------- segments -----------------------------
def test_clean_segments_sorts_merges_trims_and_drops() -> None:
    rows = [
        (1.0, 2.0, "C"),
        (0.0, 1.0, "C"),  # out of order, same label adjacent -> merged with the next
        (2.0, 2.0, "G"),  # zero length
        (1.5, 3.0, "G"),  # overlaps previous -> trimmed to start at 2.0
        (float("nan"), 4.0, "F"),  # non-finite
        (-1.0, 0.0, "A"),  # ends at 0 after clamp -> dropped
        (3.0, 99.0, "A:min"),  # clamped to duration
        (50.0, 60.0, "D"),  # entirely past the end
    ]
    segs = clean_segments(rows, duration_sec=5.0)
    assert [(s.start_sec, s.end_sec, s.label) for s in segs] == [
        (0.0, 2.0, "C:maj"),
        (2.0, 3.0, "G:maj"),
        (3.0, 5.0, "A:min"),
    ]


def test_clean_segments_without_duration_keeps_ends() -> None:
    segs = clean_segments([(0.0, 1.0, "C"), (1.0, 2.5, "G")], duration_sec=None)
    assert segs[-1].end_sec == 2.5


def test_confidence_is_carried_clamped_and_duration_weighted_on_merge() -> None:
    segs = clean_segments(
        [
            (0.0, 1.0, "C", 0.2),
            (1.0, 4.0, "C", 0.6),  # merged: (0.2*1 + 0.6*3) / 4 = 0.5
            (4.0, 5.0, "G", 7.0),  # clamped to 1
            (5.0, 6.0, "A", -1.0),  # clamped to 0
            (6.0, 7.0, "D", float("nan")),  # non-finite -> 1.0 (no signal)
            (7.0, 8.0, "E", "high"),  # unparseable -> 1.0
        ],
        duration_sec=None,
    )
    assert [(s.label, s.confidence) for s in segs] == [
        ("C:maj", 0.5),
        ("G:maj", 1.0),
        ("A:maj", 0.0),
        ("D:maj", 1.0),
        ("E:maj", 1.0),
    ]


# ----------------------------- weights -----------------------------
def _fetch_script():
    spec = importlib.util.spec_from_file_location(
        "fetch_btc_weights", WORKER / "scripts" / "fetch_btc_weights.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_pinned_sha_matches_the_fetch_script_and_the_default_path() -> None:
    fetch = _fetch_script()
    assert btc.BTC_WEIGHTS_SHA256 == fetch.SHA256
    assert len(btc.BTC_WEIGHTS_SHA256) == 64
    assert fetch.COMMIT.startswith("2682317")
    dockerfile = (WORKER / "Dockerfile").read_text()
    assert f"--soft {btc.BTC_WEIGHTS_DEFAULT_PATH}" in dockerfile


def test_selected_without_weights_raises_clear_error(
    wav: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(tmp_path / "missing.pt"))
    with pytest.raises(BtcWeightsMissing, match="not found"):
        get_chord_source("btc").recognize(wav)
    monkeypatch.setattr(btc, "BTC_WEIGHTS_SHA256", "")
    with pytest.raises(BtcWeightsMissing, match="not pinned"):
        btc._default_runner()


def test_verify_weights_ok_mismatch_and_unpinned(tmp_path: Path) -> None:
    w = tmp_path / "w.pt"
    w.write_bytes(b"not really weights")
    sha = hashlib.sha256(b"not really weights").hexdigest()
    assert verify_weights(w, sha) == sha
    assert verify_weights(w, sha.upper()) == sha
    with pytest.raises(BtcWeightsMissing, match="mismatch"):
        verify_weights(w, FAKE_SHA)
    with pytest.raises(BtcWeightsMissing, match="not pinned"):
        verify_weights(w, "")


def test_mismatched_weights_are_never_parsed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = tmp_path / "w.pt"
    w.write_bytes(b"evil pickle")
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(w))
    with (
        patch.object(btc_model, "load_checkpoint") as load,
        pytest.raises(BtcWeightsMissing, match="mismatch"),
    ):
        btc._default_runner()
    load.assert_not_called()


# ----------------------------- checkpoint reader -----------------------------
def test_checkpoint_round_trip(tmp_path: Path) -> None:
    params = random_params()
    w = tmp_path / "w.pt"
    _write_legacy_checkpoint(w, params, mean=-2.25, std=1.75)
    ck = load_checkpoint(w)
    assert ck["mean"] == -2.25 and ck["std"] == 1.75
    assert set(ck["model"]) == set(params)
    for k, v in params.items():
        assert ck["model"][k].dtype == np.float32
        np.testing.assert_array_equal(ck["model"][k], v)


def test_checkpoint_transposed_view_uses_strides(tmp_path: Path) -> None:
    base = np.arange(6, dtype=np.float32).reshape(2, 3)
    w = tmp_path / "w.pt"
    _write_legacy_checkpoint(w, {"t": base.T})  # non-contiguous -> written contiguous
    np.testing.assert_array_equal(load_checkpoint(w)["model"]["t"], base.T)


def test_lazy_tensor_honours_offset_and_stride() -> None:
    st = btc_model._Storage("k", np.dtype("<f4"), 8, np.arange(8, dtype="<f4"))
    t = btc_model._LazyTensor(st, 2, (2, 2), (1, 3))
    np.testing.assert_array_equal(t.materialize(), [[2, 5], [3, 6]])
    with pytest.raises(BtcCheckpointError, match="past its storage"):
        btc_model._LazyTensor(st, 5, (2, 2), (1, 3)).materialize()


class _Evil:
    def __reduce__(self):
        return (os.getcwd, ())


@pytest.mark.parametrize(
    ("tweak", "match"),
    [
        ({"extra": {"x": _Evil()}}, "unexpected global"),
        ({"header": (123, 1001)}, "magic/protocol"),
        ({"count": 3}, "size disagrees"),
        ({"trailer": b"\x00"}, "trailing bytes"),
    ],
)
def test_checkpoint_rejects_unexpected_content(tmp_path: Path, tweak: dict, match: str) -> None:
    w = tmp_path / "w.pt"
    _write_legacy_checkpoint(w, {"a": np.ones(4, dtype=np.float32)}, **tweak)
    with pytest.raises(BtcCheckpointError, match=match):
        load_checkpoint(w)


def test_checkpoint_rejects_truncation_and_garbage(tmp_path: Path) -> None:
    w = tmp_path / "w.pt"
    _write_legacy_checkpoint(w, {"a": np.ones(4, dtype=np.float32)})
    w.write_bytes(w.read_bytes()[:-3])
    with pytest.raises(BtcCheckpointError, match="truncated"):
        load_checkpoint(w)
    w.write_bytes(b"PK\x03\x04 a zip checkpoint")
    with pytest.raises(BtcCheckpointError):
        load_checkpoint(w)


def test_checkpoint_rejects_bad_mean_std(tmp_path: Path) -> None:
    w = tmp_path / "w.pt"
    _write_legacy_checkpoint(w, {"a": np.ones(2, dtype=np.float32)}, std=0.0)
    with pytest.raises(BtcCheckpointError, match="mean/std"):
        load_checkpoint(w)


def test_model_rejects_wrong_shapes() -> None:
    p = random_params()
    p["output_layer.output_projection.weight"] = np.zeros((25, 128), dtype=np.float32)
    with pytest.raises(BtcCheckpointError, match="shape"):
        BtcModel(p)
    del p["output_layer.output_projection.weight"]
    with pytest.raises(BtcCheckpointError, match="lacks parameter"):
        BtcModel(p)


# ----------------------------- model vs torch reference -----------------------------
def test_numpy_port_matches_torch_reference_fixture() -> None:
    """``tests/fixtures/btc/reference_logits.json`` was produced by the ORIGINAL torch BTC_model
    (scripts/btc_reference_fixture.py) from the same seeded weights + input."""
    ref = json.loads(REFERENCE.read_text())
    logits = BtcModel(random_params()).logits(random_windows())
    assert logits.shape == (2, 108, 170)
    np.testing.assert_allclose(logits[..., :8], np.array(ref["logits_first8"]), atol=2e-4)
    assert logits.argmax(-1).tolist() == ref["argmax"]


def test_layer_norm_uses_unbiased_std_plus_eps() -> None:
    x = np.array([[1.0, 2.0, 3.0, 6.0]], dtype=np.float32)
    out = btc_model._layer_norm(x, np.ones(4, np.float32), np.zeros(4, np.float32))
    want = (x - 3.0) / (np.std(x, ddof=1) + 1e-6)
    np.testing.assert_allclose(out, want, rtol=1e-6)


def test_conv_pads_one_each_side() -> None:
    x = np.arange(5, dtype=np.float32).reshape(1, 5, 1)
    w = np.array([[[1.0, 10.0, 100.0]]], dtype=np.float32)  # taps: t-1, t, t+1
    out = btc_model._conv1d_same3(x, w, np.zeros(1, np.float32))
    assert out[0, :, 0].tolist() == [100.0, 210.0, 321.0, 432.0, 43.0]


def test_forward_block_is_causal_and_backward_block_is_anti_causal() -> None:
    m = BtcModel(random_params())
    x = random_windows()[:1] @ m.p["self_attn_layers.embedding_proj.weight"].T
    y = x.copy()
    y[:, 60:] += 5.0  # change only the future (t >= 60)
    blk = "self_attn_layers.self_attn_layers.0."
    f_x = m._block(x, blk + "attn_block.", m.masks["attn_block"])
    f_y = m._block(y, blk + "attn_block.", m.masks["attn_block"])
    # FFN conv sees t+1, so frames <= 58 are untouched by a change at t >= 60.
    np.testing.assert_allclose(f_x[:, :59], f_y[:, :59], atol=1e-5)
    assert not np.allclose(f_x[:, 61:], f_y[:, 61:])
    z = x.copy()
    z[:, :40] += 5.0  # change only the past
    b_x = m._block(x, blk + "backward_attn_block.", m.masks["backward_attn_block"])
    b_z = m._block(z, blk + "backward_attn_block.", m.masks["backward_attn_block"])
    np.testing.assert_allclose(b_x[:, 41:], b_z[:, 41:], atol=1e-5)


# ----------------------------- windowing + decode -----------------------------
class _RecordingModel:
    def __init__(self) -> None:
        self.batches: list[np.ndarray] = []

    def logits(self, w: np.ndarray) -> np.ndarray:
        self.batches.append(w.copy())
        out = np.zeros((w.shape[0], w.shape[1], 170), dtype=np.float32)
        cls = (np.abs(w[..., 0]) > 0.5).astype(int) + 3  # class 3 or 4 per frame
        np.put_along_axis(out, cls[..., None], 10.0, axis=-1)
        return out


@pytest.mark.parametrize("n", [1, 107, 108, 109, 108 * 9 + 5])
def test_predict_frames_pads_windows_and_cuts_padding(n: int) -> None:
    rng = np.random.default_rng(n)
    feat = rng.standard_normal((n, 144)).astype(np.float32)
    m = _RecordingModel()
    ids, probs = btc_model.predict_frames(m, feat, mean=0.25, std=2.0)  # type: ignore[arg-type]
    assert ids.shape == (n,) and probs.shape == (n,)
    seen = np.concatenate(m.batches).reshape(-1, 144)
    assert seen.shape[0] == (n // 108 + 1) * 108  # test.py: always pads, even n % 108 == 0
    np.testing.assert_allclose(seen[:n], (feat - 0.25) / 2.0, rtol=1e-6)
    assert not seen[n:].any()
    assert all(b.shape[0] <= 8 for b in m.batches)  # bounded batch
    want = (np.abs((feat[:, 0] - 0.25) / 2.0) > 0.5).astype(int) + 3
    assert ids.tolist() == want.tolist()
    assert np.all((probs > 0.99) & (probs <= 1.0))


def test_predict_frames_empty() -> None:
    ids, probs = btc_model.predict_frames(_RecordingModel(), np.zeros((0, 144)), 0.0, 1.0)  # type: ignore[arg-type]
    assert ids.size == 0 and probs.size == 0


def test_frames_to_rows_runs_and_times() -> None:
    vocab = btc_vocabulary()
    rows = btc_model.frames_to_rows(
        np.array([169, 169, 1, 1, 1, 9]), np.array([0.9, 0.7, 0.5, 0.5, 0.2, 1.0]), vocab
    )
    fs = 10.0 / 108
    assert [(r[2]) for r in rows] == ["N", "C", "C:7"]
    assert rows[0][0] == 0.0 and rows[0][1] == pytest.approx(2 * fs)
    assert rows[1][0] == pytest.approx(2 * fs) and rows[1][1] == pytest.approx(5 * fs)
    assert rows[2][1] == pytest.approx(6 * fs)
    assert rows[0][3] == pytest.approx(0.8) and rows[1][3] == pytest.approx(0.4)
    assert btc_model.frames_to_rows(np.array([], dtype=int), np.array([]), vocab) == []


def test_cqt_features_chunks_like_btc_and_handles_short_audio() -> None:
    sr = btc_model.SAMPLE_RATE
    t = np.arange(int(sr * 23.0)) / sr
    wav = (0.3 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
    f = btc_model.cqt_features(wav)
    # 10 s chunks -> 108 frames each; 3 s tail -> 1 + 66150 // 2048 = 33 frames.
    assert f.shape == (108 + 108 + 33, 144) and f.dtype == np.float32
    assert np.isfinite(f).all()
    short = btc_model.cqt_features(wav[: sr * 2])  # < one chunk (the original code crashed)
    assert short.shape == (1 + (sr * 2) // 2048, 144)
    tail = btc_model.cqt_features(wav[: sr * 10 + 100])  # tail < one hop is dropped
    assert tail.shape == (108, 144)
    assert btc_model.cqt_features(np.zeros(0, dtype=np.float32)).shape == (0, 144)


# ----------------------------- default runner end to end -----------------------------
def _install_synthetic_weights(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    w = tmp_path / "btc_model_large_voca.pt"
    _write_legacy_checkpoint(w, random_params())
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(w))
    monkeypatch.setattr(btc, "BTC_WEIGHTS_SHA256", hashlib.sha256(w.read_bytes()).hexdigest())
    return w


def test_default_runner_end_to_end_and_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_synthetic_weights(tmp_path, monkeypatch)
    audio = tmp_path / "harmonic_mix.wav"
    _write_wav(audio, 220.0, secs=12.0)
    real_load = btc_model.load_checkpoint
    with patch.object(btc_model, "load_checkpoint", side_effect=real_load) as load:
        r1 = get_chord_source("btc").recognize(audio)
        r2 = get_chord_source("btc").recognize(audio)
    assert load.call_count == 1  # weights parsed once per process
    assert r1.segments == r2.segments
    assert r1.provider == "btc" and r1.segments
    assert r1.duration_sec == pytest.approx(12.0, abs=0.01)
    assert r1.segments[0].start_sec == 0.0
    assert r1.segments[-1].end_sec <= r1.duration_sec
    for a, b in zip(r1.segments, r1.segments[1:], strict=False):
        assert a.end_sec == b.start_sec and a.label != b.label
    assert all(is_valid_harte_label(s.label) and 0 < s.confidence <= 1 for s in r1.segments)


def test_runner_cache_is_keyed_by_weights_sha(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = _install_synthetic_weights(tmp_path, monkeypatch)
    first = btc._default_runner()
    assert btc._default_runner() is first
    _write_legacy_checkpoint(w, random_params(seed=7))
    monkeypatch.setattr(btc, "BTC_WEIGHTS_SHA256", hashlib.sha256(w.read_bytes()).hexdigest())
    assert btc._default_runner() is not first
    assert len(btc._RUNNER_CACHE) == 1


@pytest.mark.skipif(
    not os.environ.get("BTC_WEIGHTS_PATH"), reason="real BTC weights not fetched (opt-in)"
)
def test_real_weights_smoke(tmp_path: Path) -> None:
    """Opt-in: with the real pinned weights, a C-major triad held for 12 s is read as C."""
    sr = 22050
    t = np.arange(sr * 12) / sr
    tone = sum(np.sin(2 * np.pi * f * t) for f in (261.63, 329.63, 392.0, 130.81))
    import soundfile as sf

    audio = tmp_path / "c_major.wav"
    sf.write(audio, (0.2 * tone).astype(np.float32), sr)
    res = BtcChordSource().recognize(audio)
    longest = max(res.segments, key=lambda s: s.end_sec - s.start_sec)
    assert longest.label == "C:maj"


# ----------------------------- fetch script -----------------------------
def test_fetch_script_installs_verified_file_and_never_leaves_a_bad_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fetch = _fetch_script()
    src = tmp_path / "src.pt"
    src.write_bytes(b"weights" * 10)
    monkeypatch.setattr(fetch, "SHA256", hashlib.sha256(src.read_bytes()).hexdigest())
    monkeypatch.setattr(fetch, "SIZE", src.stat().st_size)
    monkeypatch.setattr(fetch, "URL", src.as_uri())
    dest = tmp_path / "models" / "btc.pt"
    assert fetch.main([str(dest)]) == 0
    assert dest.read_bytes() == src.read_bytes()
    assert fetch.main([str(dest)]) == 0  # already present: no re-download needed

    dest.write_bytes(b"tampered")  # a bad existing file is removed when the fetch fails
    src.write_bytes(b"other bytes!" * 6)
    assert fetch.main([str(dest)]) == 1
    assert not dest.exists()
    assert fetch.main(["--soft", str(dest)]) == 0
    assert not dest.exists()
    assert not list(dest.parent.glob(".btc-*"))  # no partial file left


# ----------------------------- pipeline hook -----------------------------
def _run_hook(provider: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("CHORDS_PROVIDER", provider)
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    stems = _make_stems(tmp_path)
    r2 = MagicMock()
    r2.get_object.side_effect = Exception("NoSuchKey")
    ledger_cls = MagicMock(name="_KlangioJobLedger")
    with (
        patch("worker.storage.r2_uploader._r2", return_value=r2),
        patch.object(pipeline, "_existing_play_chords", return_value=False),
        patch.object(pipeline, "_KlangioJobLedger", ledger_cls),
        patch.object(pipeline, "_db", side_effect=AssertionError("btc must not touch the DB")),
        patch("worker.chord_providers.klangio._reserve_quota") as quota,
    ):
        outcome = pipeline._maybe_run_chord_recognition("job-btc", stems, list(stems))
    body = json.loads(r2.put_object.call_args.kwargs["Body"]) if r2.put_object.called else None
    return outcome, body, ledger_cls, quota


def test_pipeline_btc_never_uses_the_klangio_ledger_or_quota(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """pipeline.py (reserved for this PR) still builds ``_KlangioJobLedger(job_id)`` for every
    provider; the constructor is pure, and btc never calls existing/claim/record/release, so
    no jobs.klangio_job_id read or write happens and no Klangio quota slot is reserved."""
    runner = _fake_runner([(0.0, 0.1, "C", 0.7), (0.1, 0.2, "G", 0.6)])
    monkeypatch.setattr(btc, "_default_runner", lambda: runner)
    outcome, body, ledger_cls, quota = _run_hook("btc", tmp_path, monkeypatch)
    assert len(runner.calls) == 1
    assert ledger_cls.return_value.mock_calls == []
    quota.assert_not_called()
    assert body["provider"] == "btc"
    assert [s["label"] for s in body["segments"]] == ["C:maj", "G:maj"]
    assert outcome == pipeline._chords_ok()


def test_pipeline_klangio_still_gets_the_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = MagicMock()
    fake.recognize.return_value = ChordResult(provider="klangio")
    with patch("worker.chord_source.get_chord_source", return_value=fake):
        _, _, ledger_cls, _ = _run_hook("klangio", tmp_path, monkeypatch)
    ledger_cls.assert_called_once_with("job-btc")
    assert fake.recognize.call_args.kwargs["ledger"] is ledger_cls.return_value


def test_pipeline_btc_without_weights_tombstones_not_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(tmp_path / "missing.pt"))
    outcome, body, ledger_cls, quota = _run_hook("btc", tmp_path, monkeypatch)
    assert body == {"status": "unavailable", "reason": "provider_failed"}
    assert ledger_cls.return_value.mock_calls == []
    quota.assert_not_called()
    assert outcome is not None and outcome != pipeline._chords_ok()


def test_pipeline_btc_keeps_the_duration_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _fake_runner([(0.0, 0.1, "C")])
    monkeypatch.setattr(btc, "_default_runner", lambda: runner)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 301.0)
    _, body, _, _ = _run_hook("btc", tmp_path, monkeypatch)
    assert runner.calls == []
    assert body["reason"] == "too_long"
