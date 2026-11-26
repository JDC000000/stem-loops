"""B-8c: the chords ok/unavailable marker on the EXISTING extracting/completed job_events row.

``_maybe_run_chord_recognition`` returns an outcome; ``_run_pipeline`` adds it to the detail
of the extracting/completed row as ``chords`` (+ ``chords_reason`` when unavailable). No new
row, stage or phase. Covered here:

  * every branch of the hook -> its outcome (ok via upload, ok via the rerun early return,
    each unavailable branch, drain abandon = no marker);
  * the drift guard: no tombstone can be written without a marker, and every reason code
    used in the hook is in ``CHORDS_UNAVAILABLE_REASONS`` (and vice versa);
  * Klangio not answering the submit POST -> ``submit_unanswered`` (distinct reason);
  * the pipeline emits it on stage ``extracting`` phase ``completed``, and a broken outcome
    never fails the job.

No real HTTP, no DB, no R2: the provider and the R2 writer are mocked.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import json
import textwrap
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from tests.test_beatless_finishes_done import JOB, _drive
from worker import pipeline
from worker.chord_providers import klangio as kg
from worker.chord_source import (
    ChordProviderPaused,
    ChordQuotaExceeded,
    ChordResult,
    ChordSegment,
    ChordSubmitUnanswered,
    ChordSubmitUncertain,
)

R2_KEY = f"jobs/{JOB}/play.chords.json"


def _result() -> ChordResult:
    return ChordResult(
        segments=[ChordSegment(start_sec=0.0, end_sec=1.0, label="C:maj", confidence=1.0)],
        key="C:major",
        provider="klangio",
        provider_version="t",
        duration_sec=1.0,
        model_ms=1,
    )


@pytest.fixture
def hook(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Run the hook with every I/O edge stubbed. Returns (run, uploads) where ``uploads``
    records every body written to R2 (artifact or tombstone)."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    uploads: list[dict] = []

    def upload(job_id, body):
        uploads.append(json.loads(body))
        return f"jobs/{job_id}/play.chords.json"

    monkeypatch.setattr(pipeline, "upload_play_chords", upload)
    monkeypatch.setattr(pipeline, "_existing_play_chords", lambda _j: False)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 60.0)
    audio = tmp_path / "keys.wav"
    audio.write_bytes(b"x")
    monkeypatch.setattr(pipeline, "_choose_chord_input", lambda *_a, **_k: ("keys", str(audio)))
    provider = MagicMock()
    provider.recognize.return_value = _result()

    def run():
        with patch("worker.chord_source.get_chord_source", return_value=provider):
            return pipeline._maybe_run_chord_recognition(JOB, {"keys": str(audio)}, ["keys"])

    run.provider = provider  # type: ignore[attr-defined]
    return run, uploads


def _unavailable(reason: str) -> dict:
    return {"chords": "unavailable", "reason": reason}


# ------------------------------------------------------------------ each branch


def test_ok_when_the_upload_returned_an_r2_key(hook):
    run, uploads = hook
    assert run() == {"chords": "ok", "reason": None}
    assert uploads and "segments" in uploads[0]


def test_ok_on_the_rerun_early_return_when_chords_already_exist(hook, monkeypatch):
    run, uploads = hook
    monkeypatch.setattr(pipeline, "_existing_play_chords", lambda _j: True)
    assert run() == {"chords": "ok", "reason": None}
    run.provider.recognize.assert_not_called()
    assert uploads == []


def test_unavailable_upload_failed_when_the_upload_raised(hook, monkeypatch):
    run, _ = hook

    def boom(*_a):
        raise RuntimeError("r2 down")

    monkeypatch.setattr(pipeline, "upload_play_chords", boom)
    assert run() == _unavailable("upload_failed")


def test_unavailable_disabled(hook, monkeypatch):
    run, uploads = hook
    monkeypatch.setenv("CHORDS_PROVIDER", "")
    assert run() == _unavailable("disabled")
    assert uploads == []


def test_unavailable_too_long_writes_its_tombstone(hook, monkeypatch):
    run, uploads = hook
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 10_000.0)
    assert run() == _unavailable("too_long")
    assert uploads == [{"status": "unavailable", "reason": "too_long", "duration_sec": 10000.0}]


def test_unavailable_no_harmonic_stem(hook, monkeypatch):
    run, uploads = hook
    monkeypatch.setattr(pipeline, "_choose_chord_input", lambda *_a, **_k: None)
    assert run() == _unavailable("no_harmonic_stem")
    assert uploads == [{"status": "unavailable", "reason": "not_attempted"}]


@pytest.mark.parametrize(
    ("exc", "reason", "tombstone"),
    [
        pytest.param(ChordQuotaExceeded("cap"), "quota", "not_attempted", id="quota"),
        pytest.param(
            ChordProviderPaused("breaker open"), "provider_paused", "not_attempted", id="paused"
        ),
        pytest.param(
            kg.ChordSubmitNotSent("connect failed"),
            "provider_failed",
            "provider_failed",
            id="not-sent",
        ),
        pytest.param(
            ChordSubmitUncertain("sentinel"), "submit_uncertain", "provider_failed", id="uncertain"
        ),
        pytest.param(
            kg.ChordSubmitNoAnswer("no answer"),
            "submit_unanswered",
            "provider_failed",
            id="unanswered",
        ),
        pytest.param(
            kg.ChordProviderError("HTTP 500"), "provider_failed", "provider_failed", id="provider"
        ),
        pytest.param(RuntimeError("anything"), "provider_failed", "provider_failed", id="other"),
    ],
)
def test_unavailable_on_each_provider_branch(hook, exc, reason, tombstone):
    run, uploads = hook
    run.provider.recognize.side_effect = exc
    assert run() == _unavailable(reason)
    # The tombstone the web loader reads is unchanged by B-8c.
    assert uploads == [{"status": "unavailable", "reason": tombstone}]


def test_drain_abandon_gives_no_marker_and_no_tombstone(hook):
    run, uploads = hook
    run.provider.recognize.side_effect = pipeline._ChordSubmitAbandonedForDrain(JOB)
    assert run() is None
    assert uploads == []


def test_reason_is_a_fixed_code_never_upstream_text(hook):
    run, _ = hook
    run.provider.recognize.side_effect = kg.ChordProviderError("secret upstream body <html>")
    out = run()
    assert out["reason"] in pipeline.CHORDS_UNAVAILABLE_REASONS
    assert "upstream" not in json.dumps(out)


# ------------------------------------------------------------------ Klangio: POST unanswered


class _Ledger:
    def __init__(self) -> None:
        self.state: str | None = None

    def existing(self):
        return self.state

    def claim(self):
        self.state = "submitting"

    def record(self, provider_job_id):
        self.state = provider_job_id

    def release(self):
        self.state = None


def _wav(path: Path) -> Path:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * 8000)
    return path


def test_unanswered_submit_post_raises_the_distinct_type_and_keeps_the_sentinel(
    monkeypatch, tmp_path
):
    """The 11-24 incident: POST /chord-recognition never answers. The job keeps
    klangio_job_id='submitting' and the marker must say submit_unanswered."""
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test-key-123")
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "quota.json"))
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("no answer", request=request)

    client = httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))
    ledger = _Ledger()
    with patch.object(kg.time, "sleep"), pytest.raises(kg.ChordProviderError) as caught:
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav"), "mix", ledger=ledger)
    assert isinstance(caught.value, ChordSubmitUnanswered)
    assert "not retried" in str(caught.value)  # existing message unchanged
    assert ledger.state == "submitting"


def test_a_retried_get_transport_failure_is_not_unanswered(monkeypatch):
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    client = httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))
    with patch.object(kg.time, "sleep"), pytest.raises(kg.ChordProviderError) as caught:
        kg._request_with_retry(client, method="GET", url="/job/x/status")
    assert not isinstance(caught.value, ChordSubmitUnanswered)


def test_unanswered_post_in_the_hook_is_submit_unanswered(hook, monkeypatch, tmp_path):
    run, _ = hook
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test-key-123")
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "quota.json"))
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("no answer", request=request)

    client = httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))
    src = kg.KlangioChordSource()
    run.provider.recognize.side_effect = lambda *_a, **_k: src._submit(
        client, _wav(tmp_path / "b.wav"), "mix", ledger=_Ledger()
    )
    with patch.object(kg.time, "sleep"):
        assert run() == _unavailable("submit_unanswered")


# ------------------------------------------------------------------ drift guard


def _hook_ast() -> ast.FunctionDef:
    src = textwrap.dedent(inspect.getsource(pipeline._maybe_run_chord_recognition))
    fn = ast.parse(src).body[0]
    assert isinstance(fn, ast.FunctionDef)
    return fn


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        return node.func.id
    return None


def test_drift_no_tombstone_is_written_except_through_the_marker_helper():
    """A new tombstone branch that calls _write_chords_tombstone directly fails here."""
    tree = ast.parse(inspect.getsource(pipeline))
    callers = {
        fn.name
        for fn in ast.walk(tree)
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
        for n in ast.walk(fn)
        if _call_name(n) == "_write_chords_tombstone"
    }
    assert callers == {"_chords_unavailable"}


def test_drift_every_reason_in_the_hook_is_a_known_code_and_every_code_is_used():
    fn = _hook_ast()
    assigned: dict[str, list[ast.expr]] = {}
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.IfExp):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    assigned[t.id] = [n.value.body, n.value.orelse]
    used: list[str] = []
    for n in ast.walk(fn):
        if _call_name(n) == "_chords_unavailable":
            assert len(n.args) >= 2, "reason must be positional arg 2"
            arg = n.args[1]
            if isinstance(arg, ast.Constant):
                used.append(arg.value)
            else:
                assert isinstance(arg, ast.Name) and arg.id in assigned, ast.dump(arg)
                arms = assigned[arg.id]
                assert all(isinstance(a, ast.Constant) for a in arms), "literal codes only"
                used.extend(a.value for a in arms)
    assert set(used) == set(pipeline.CHORDS_UNAVAILABLE_REASONS)


def test_drift_every_exit_of_the_hook_returns_a_marker_except_drain():
    """No branch may fall through (implicit None) or return a bare None, except the drain
    handler. A new branch without a marker fails here."""
    fn = _hook_ast()
    drain_returns = set()
    for h in ast.walk(fn):
        if (
            isinstance(h, ast.ExceptHandler)
            and isinstance(h.type, ast.Name)
            and h.type.id == "_ChordSubmitAbandonedForDrain"
        ):
            drain_returns |= {id(r) for r in ast.walk(h) if isinstance(r, ast.Return)}
            assert isinstance(h.body[-1], ast.Return)
    assert drain_returns, "the drain handler must return explicitly"
    for r in ast.walk(fn):
        if isinstance(r, ast.Return) and id(r) not in drain_returns:
            assert _call_name(r.value) in {"_chords_ok", "_chords_unavailable"}, ast.dump(r)
    # No fall-through: the last statement is the try, whose body and handlers all return.
    last = fn.body[-1]
    assert isinstance(last, ast.Try)
    assert isinstance(last.body[-1], ast.Return)
    for h in last.handlers:
        assert isinstance(h.body[-1], ast.Return), ast.dump(h.type)


# ------------------------------------------------------------------ _with_chords_marker


def test_marker_merge_shapes():
    w = pipeline._with_chords_marker
    assert w(JOB, None, {"chords": "ok", "reason": None}) == {"chords": "ok"}
    assert w(JOB, None, None) is None
    beatless = {"loops": 0, "reason": "no_reliable_beat"}
    assert w(JOB, beatless, _unavailable("quota")) == {
        "loops": 0,
        "reason": "no_reliable_beat",
        "chords": "unavailable",
        "chords_reason": "quota",
    }
    assert beatless == {"loops": 0, "reason": "no_reliable_beat"}, "input not mutated"
    # An unknown reason or status is dropped (fixed codes only), not passed through.
    assert w(JOB, None, _unavailable("free text from upstream")) is None
    assert w(JOB, beatless, {"chords": "maybe"}) == beatless


# ------------------------------------------------------------------ the pipeline row


def _drive_with(monkeypatch, outcome, loops):
    seen = _drive(monkeypatch, lambda *a, **k: (loops, {"bpm": 120.0, "musical_key": "C"}, {}, {}))
    monkeypatch.setattr(pipeline, "_maybe_run_chord_recognition", lambda *a: outcome)
    asyncio.run(pipeline._run_pipeline(JOB))
    return seen


LOOP = {"stem": "drums", "start_sec": 0.0, "end_sec": 8.0}


@pytest.mark.parametrize(
    ("outcome", "loops", "expected"),
    [
        ({"chords": "ok", "reason": None}, [LOOP], {"chords": "ok"}),
        (
            _unavailable("submit_unanswered"),
            [LOOP],
            {"chords": "unavailable", "chords_reason": "submit_unanswered"},
        ),
        (
            _unavailable("too_long"),
            [],
            {
                "loops": 0,
                "reason": "no_reliable_beat",
                "chords": "unavailable",
                "chords_reason": "too_long",
            },
        ),
        (None, [LOOP], None),  # drain: no key at all
        (None, [], {"loops": 0, "reason": "no_reliable_beat"}),
    ],
)
def test_the_marker_rides_on_the_existing_extracting_completed_row(
    monkeypatch, outcome, loops, expected
):
    seen = _drive_with(monkeypatch, outcome, loops)
    assert seen["failed"] == [] and seen["status"][-1] == "done"
    rows = [(s, p) for (s, p, _d) in seen["events"]]
    assert rows.count(("extracting", "completed")) == 1, "no extra row"
    assert {s for s, _p in rows} <= {"downloading", "separating", "extracting", "uploading"}
    marked = [(s, p) for (s, p, d) in seen["events"] if d and "chords" in d]
    assert marked == ([("extracting", "completed")] if expected and "chords" in expected else [])
    detail = [d for (s, p, d) in seen["events"] if (s, p) == ("extracting", "completed")]
    assert detail == [expected]


class _Exploding(dict):
    def __getitem__(self, key):
        raise RuntimeError("outcome blew up")


def test_an_exception_building_the_marker_still_completes_the_job(monkeypatch):
    seen = _drive_with(monkeypatch, _Exploding(), [])
    assert seen["failed"] == [] and seen["status"][-1] == "done"
    detail = [d for (s, p, d) in seen["events"] if (s, p) == ("extracting", "completed")]
    assert detail == [{"loops": 0, "reason": "no_reliable_beat"}]


def test_a_failing_tombstone_write_still_returns_the_marker(hook, monkeypatch):
    run, _ = hook

    def boom(*_a):
        raise RuntimeError("r2 down")

    monkeypatch.setattr(pipeline, "upload_play_chords", boom)
    monkeypatch.setattr(pipeline, "_choose_chord_input", lambda *_a, **_k: None)
    assert run() == _unavailable("no_harmonic_stem")
