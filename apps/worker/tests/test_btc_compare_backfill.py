"""scripts/btc_compare_backfill.py: read-only BTC-vs-Klangio backfill, tested with fakes only.

No database, no R2, no BTC weights, no Klangio: the DB and R2 are in-memory fakes, BTC is an
injected runner and the chord-input chooser is injected (an identity test pins the default to
the worker's own ``pipeline._choose_chord_input``).
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "btc_compare_backfill.py"
_spec = importlib.util.spec_from_file_location("btc_compare_backfill", _SCRIPT)
bcb = importlib.util.module_from_spec(_spec)
sys.modules["btc_compare_backfill"] = bcb
_spec.loader.exec_module(bcb)

from worker.chord_providers import klangio  # noqa: E402

HOP = 2048 / 22050
OLD = 10 / 108

JOB_A_NEW = "11111111-1111-4111-8111-111111111111"
JOB_A_OLD = "22222222-2222-4222-8222-222222222222"
JOB_B = "33333333-3333-4333-8333-333333333333"
JOB_UPLOAD = "44444444-4444-4444-8444-444444444444"
VID_A = "dQw4w9WgXcQ"
LINK_A = f"https://www.youtube.com/watch?v={VID_A}"
LINK_A_SHORT = f"https://youtu.be/{VID_A}?si=abc"
LINK_B = "https://www.youtube.com/watch?v=9bZkp7q19f0&list=x"
TITLE = "Secret Song Title"
EMAIL = "someone@example.com"


# --------------------------------------------------------------------------- fakes
class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class FakeConn:
    """Records statements. A non-SELECT reaching it would be a guard failure."""

    def __init__(self, rows, read_only="on"):
        self.rows = rows
        self.read_only = read_only
        self.executed: list[str] = []
        self.connect_kwargs: dict = {}
        self.closed = False

    def execute(self, sql, params=None):
        self.executed.append(sql)
        if sql.startswith("SHOW transaction_read_only"):
            return _Cursor([(self.read_only,)])
        if sql.startswith("SET SESSION"):
            return _Cursor([])
        return _Cursor(self.rows)

    def rollback(self):
        pass

    def close(self):
        self.closed = True


class _Missing(Exception):
    def __init__(self):
        super().__init__("NoSuchKey")
        self.response = {"Error": {"Code": "NoSuchKey"}}


class FakeS3:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects
        self.gets: list[str] = []

    def get_object(self, Bucket, Key):  # noqa: N803 — boto3 signature
        self.gets.append(Key)
        if Key not in self.objects:
            raise _Missing()
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, **_kw):  # pragma: no cover — must be unreachable
        raise AssertionError("put_object reached the client")

    def delete_object(self, **_kw):  # pragma: no cover
        raise AssertionError("delete_object reached the client")


def _chords(rows, provider="klangio") -> bytes:
    return json.dumps(
        {
            "provider": provider,
            "provider_version": "klangio-v1",
            "segments": [
                {"start_sec": s, "end_sec": e, "label": lab, "confidence": 1.0}
                for s, e, lab in rows
            ],
        }
    ).encode()


def _old_grid(frames_rows):
    return [(a * OLD, b * OLD, lab) for a, b, lab in frames_rows]


def _new_grid(frames_rows):
    return [(a * HOP, b * HOP, lab) for a, b, lab in frames_rows]


FRAMES = [(0, 540, "C:maj"), (540, 1080, "G:7")]


def _stems(job_id, names=("keys", "guitar", "other", "bass")):
    return {f"{job_id}/_stems/dl/{n}.wav": b"RIFF" + n.encode() for n in names}


class Harness:
    def __init__(self, rows, objects, btc_segments):
        self.conn = FakeConn(rows)
        self.s3 = FakeS3(objects)
        self.btc_calls: list[str] = []
        self.chooser_calls: list[dict] = []
        self.btc_segments = btc_segments

    def chooser(self, stem_paths, preferred):
        self.chooser_calls.append(dict(stem_paths))
        return "harmonic_mix", next(iter(stem_paths.values()))

    def btc(self, audio, timeout):
        self.btc_calls.append(audio)
        return {"segments": [list(s) for s in self.btc_segments]}

    def deps(self):
        return bcb.Deps(
            db=bcb.ReadOnlyDb(self.conn),
            r2=bcb.ReadOnlyR2(self.s3, "bucket"),
            btc_runner=self.btc,
            chooser=self.chooser,
            prober=lambda _p: 245.4,
            preferred="harmonic_mix",
        )


@pytest.fixture
def guard():
    bcb._KLANGIO_CONSTRUCTED = 0
    undo = bcb.install_klangio_guard()
    yield
    undo()
    bcb._KLANGIO_CONSTRUCTED = 0


def _standard_harness():
    rows = [
        (JOB_A_NEW, LINK_A_SHORT, None),  # newest for link A
        (JOB_B, LINK_B, "9bZkp7q19f0"),
        (JOB_A_OLD, LINK_A, VID_A),  # same link as A: must NOT be scored again
        (JOB_UPLOAD, None, None),
    ]
    objects = {}
    for j in (JOB_A_NEW, JOB_A_OLD, JOB_B, JOB_UPLOAD):
        objects[f"jobs/{j}/play.chords.json"] = _chords(_old_grid(FRAMES))
        objects.update(_stems(j))
    return Harness(rows, objects, _new_grid(FRAMES))


# --------------------------------------------------------------------------- comparator
def test_comparator_exact_values_on_fixture():
    ref = [(0.0, 4.0, "C:maj"), (4.0, 8.0, "A:min7"), (8.0, 10.0, "B:dim"), (10.0, 12.0, "N")]
    est = [(0.0, 2.0, "C:7"), (2.0, 4.0, "C:min"), (4.0, 8.0, "A:min"), (8.0, 12.0, "B:min")]
    # root: C 4/4, A 4/4, B(dim) vs B 2/2, N vs B 0/2 -> 10/12
    assert bcb.root_agreement(ref, est) == pytest.approx(10 / 12, abs=1e-12)
    # majmin: dim unscored; C:maj vs C:7(maj) 2 + C:min 0, A:min7 vs A:min 4, N vs B 0 -> 6/10
    assert bcb.majmin_agreement(ref, est) == pytest.approx(6 / 10, abs=1e-12)
    # sevenths: dim unscored; C:maj vs C:7 0, vs C:min 0, A:min7 vs A:min 0, N vs B 0 -> 0/10
    assert bcb.sevenths_agreement(ref, est) == pytest.approx(0.0, abs=1e-12)
    assert bcb.root_agreement(ref, ref) == 1.0
    assert bcb.root_agreement([], est) is None


def test_root_ignores_quality_but_not_n_and_excludes_x():
    ref = [(0.0, 1.0, "D:sus4"), (1.0, 2.0, "X"), (2.0, 3.0, "N")]
    est = [(0.0, 1.0, "D:min"), (1.0, 2.0, "E:maj"), (2.0, 3.0, "N")]
    assert bcb.root_agreement(ref, est) == 1.0  # X time is out of the denominator
    assert bcb.root_agreement(ref, [(0.0, 3.0, "D:maj")]) == pytest.approx(0.5)


# --------------------------------------------------------------------------- #525 time fix
def test_old_grid_times_are_restamped():
    h = _standard_harness()
    ref, clock = bcb.load_klangio_rows(bcb.ReadOnlyR2(h.s3, "b"), JOB_A_NEW)
    assert clock == klangio.CLOCK_RESTAMPED
    assert ref == _new_grid(FRAMES)


def test_off_grid_times_pass_through_unchanged():
    rows = [(0.0, 50.123, "C:maj"), (50.123, 100.5, "G:7")]
    s3 = FakeS3({f"jobs/{JOB_B}/play.chords.json": _chords(rows)})
    ref, clock = bcb.load_klangio_rows(bcb.ReadOnlyR2(s3, "b"), JOB_B)
    assert clock == klangio.CLOCK_PASSTHROUGH
    assert ref == rows


def test_fix_makes_aligned_btc_score_exactly_one(guard, capsys):
    h = _standard_harness()
    lines = bcb.run(h.deps(), limit=None, since=None, timeout=5.0)
    songs = lines[:-1]
    assert len(songs) == 3
    for line in songs:  # without the re-stamp the boundary is 0.155 s off: < 100%
        assert line.endswith("root 100.0% majmin 100.0% sevenths 100.0%"), line
    assert "restamped=3 passthrough=0" in lines[-1]


# --------------------------------------------------------------------------- dedupe
def test_link_key_normalises_youtube_shapes():
    a = bcb.link_key(JOB_A_NEW, LINK_A_SHORT, None)
    assert a == bcb.link_key(JOB_A_OLD, LINK_A, VID_A) == bcb.link_key("x", LINK_A, None)
    assert bcb.link_key("j1", None, None) != bcb.link_key("j2", None, None)
    assert bcb.link_key("j", "https://Example.com/a/", None) == bcb.link_key(
        "k", "https://example.com/a", None
    )


def test_dedupe_scores_one_job_per_link_newest_first(guard):
    h = _standard_harness()
    lines = bcb.run(h.deps(), limit=None, since=None, timeout=5.0)
    assert len(lines) == 4  # A (newest), B, upload + summary
    fetched = {k.split("/")[1] for k in h.s3.gets if k.startswith("jobs/")}
    assert JOB_A_OLD not in fetched
    stem_jobs = {k.split("/")[0] for k in h.s3.gets if "/_stems/" in k}
    assert stem_jobs == {JOB_A_NEW, JOB_B, JOB_UPLOAD}
    assert len(h.btc_calls) == 3


def test_dedupe_falls_back_to_older_job_when_newest_has_no_klangio(guard):
    h = _standard_harness()
    h.s3.objects[f"jobs/{JOB_A_NEW}/play.chords.json"] = json.dumps(
        {"status": "too_long"}
    ).encode()  # a tombstone
    lines = bcb.run(h.deps(), limit=None, since=None, timeout=5.0)
    stem_jobs = {k.split("/")[0] for k in h.s3.gets if "/_stems/" in k}
    assert stem_jobs == {JOB_A_OLD, JOB_B, JOB_UPLOAD}
    assert "not_klangio:1" in lines[-1]


def test_non_klangio_chords_are_skipped(guard):
    h = _standard_harness()
    for j in (JOB_A_NEW, JOB_A_OLD, JOB_B, JOB_UPLOAD):
        h.s3.objects[f"jobs/{j}/play.chords.json"] = _chords(FRAMES, provider="btc")
    lines = bcb.run(h.deps(), limit=None, since=None, timeout=5.0)
    assert lines[-1].startswith("summary songs=0 ")
    assert h.btc_calls == []


def test_limit_and_since_are_applied(guard):
    import datetime as dt

    h = _standard_harness()
    lines = bcb.run(h.deps(), limit=2, since=dt.date(2026, 11, 1), timeout=5.0)
    assert len(lines) == 3
    assert h.conn.executed[-1] == bcb.JOBS_SQL


# --------------------------------------------------------------------------- read-only
@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE jobs SET status='failed'",
        "DELETE FROM jobs",
        "INSERT INTO jobs (id) VALUES ('x')",
        "SELECT 1; DELETE FROM jobs",
        "SELECT id FROM jobs FOR UPDATE",
        "SELECT * INTO t FROM jobs",
        "SELECT nextval('s')",
        "WITH d AS (DELETE FROM jobs RETURNING id) SELECT id FROM d",
        "SET default_transaction_read_only = off",
        "SELECT 1; SET default_transaction_read_only = off",
        "SELECT 1; COMMIT",
        "SELECT 1; SELECT 2",
    ],
)
def test_write_sql_raises_before_reaching_the_connection(sql):
    conn = FakeConn([])
    db = bcb.ReadOnlyDb(conn)
    with pytest.raises(bcb.ReadOnlyViolation):
        db.query(sql)
    assert conn.executed == []


def test_connect_read_only_sets_and_verifies_the_session():
    conn = FakeConn([])

    def connect(dsn, **kw):
        conn.connect_kwargs = kw
        return conn

    db = bcb.connect_read_only("postgresql://fake/db", connect=connect)
    assert "default_transaction_read_only=on" in conn.connect_kwargs["options"]
    assert conn.executed[:2] == [
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
        "SHOW transaction_read_only",
    ]
    assert db.query(bcb.JOBS_SQL, ("x",)) == []


def test_connect_refuses_a_session_that_is_not_read_only():
    conn = FakeConn([], read_only="off")
    with pytest.raises(bcb.ReadOnlyViolation):
        bcb.connect_read_only("postgresql://fake/db", connect=lambda d, **k: conn)
    assert conn.closed


@pytest.mark.parametrize(
    "op", ["put_object", "delete_object", "upload_file", "copy_object", "delete_objects"]
)
def test_r2_write_raises(op):
    r2 = bcb.ReadOnlyR2(FakeS3({}), "bucket")
    with pytest.raises(bcb.ReadOnlyViolation):
        getattr(r2.client, op)(Bucket="bucket", Key="k", Body=b"x")
    with pytest.raises(bcb.ReadOnlyViolation):
        r2.client._client = object()


def test_jobs_sql_is_a_plain_select():
    bcb.check_read_only_sql(bcb.JOBS_SQL)
    assert "status = 'done'" in bcb.JOBS_SQL


# --------------------------------------------------------------------------- privacy
_FORBIDDEN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-|youtu|https?:|@|"
    + re.escape(VID_A)
    + "|9bZkp7q19f0|"
    + re.escape(TITLE)
    + "|jobs/|_stems",
    re.IGNORECASE,
)


def test_output_has_no_id_link_title_or_email(guard, capsys):
    h = _standard_harness()
    h.conn.rows = [r + (TITLE, EMAIL) for r in h.conn.rows]
    # one job blows up with a message full of identifiers: only its class may surface
    h.s3.objects.pop(f"{JOB_B}/_stems/dl/keys.wav")

    def chooser(stem_paths, preferred):
        if len(stem_paths) == 3:
            raise RuntimeError(f"boom {JOB_B} {LINK_B} {TITLE} {EMAIL}")
        return "harmonic_mix", next(iter(stem_paths.values()))

    deps = h.deps()
    deps.chooser = chooser
    rc = bcb.main([], deps=deps)
    out = capsys.readouterr()
    assert rc == 0
    text = out.out + out.err
    assert not _FORBIDDEN.search(text), text
    lines = out.out.strip().splitlines()
    assert len(lines) == 3  # 2 songs + summary
    assert re.fullmatch(r"\s*1 04:05 root \S+ majmin \S+ sevenths \S+", lines[0])
    assert "errors=score_RuntimeError:1" in lines[-1]
    assert "Traceback" not in text


def test_fatal_error_prints_class_only(guard, capsys):
    class Boom:
        def query(self, *_a, **_k):
            raise RuntimeError(f"connection to {LINK_A} as {EMAIL} failed")

    rc = bcb.main([], deps=bcb.Deps(db=Boom(), r2=None, chooser=len, prober=len, preferred="x"))
    out = capsys.readouterr()
    assert rc == 2
    assert out.out == ""
    assert "fatal error_class=RuntimeError" in out.err
    assert not _FORBIDDEN.search(out.err)


def test_report_order_and_summary():
    s = bcb.SongScore
    lines = bcb.format_report(
        [s(61, 1.0, 0.95, 0.9), s(125, 0.8, 0.70, 0.5), s(30, None, None, None), s(9, 1, 0.8, 1)],
        Counter({"stems_missing": 2}),
        Counter({klangio.CLOCK_RESTAMPED: 4}),
    )
    assert lines[0] == "   1 02:05 root 80.0% majmin 70.0% sevenths 50.0%"
    assert lines[1].startswith("   2 00:09 ")
    assert lines[2].startswith("   3 01:01 ")
    assert lines[3] == "   4 00:30 root n/a majmin n/a sevenths n/a"
    assert lines[4] == (
        "summary songs=4 majmin_mean=81.7% majmin_min=70.0% below_75=1 below_90=2 "
        "restamped=4 passthrough=0 errors=stems_missing:2"
    )


# --------------------------------------------------------------------------- Klangio
def test_klangio_is_never_constructed(guard):
    from worker import chord_source

    with pytest.raises(bcb.KlangioForbidden):
        klangio.KlangioChordSource()
    with pytest.raises(bcb.KlangioForbidden):
        chord_source.get_chord_source("klangio")
    with pytest.raises(bcb.KlangioForbidden):
        chord_source.get_chord_source()
    with pytest.raises(bcb.KlangioForbidden):
        bcb.assert_no_klangio()
    bcb._KLANGIO_CONSTRUCTED = 0


def test_main_installs_the_guard_and_drops_the_api_key(monkeypatch, capsys):
    monkeypatch.setenv("KLANGIO_API_KEY", "not-a-real-key")
    installed = []
    real = bcb.install_klangio_guard

    def spy():
        undo = real()
        installed.append(undo)
        return undo

    monkeypatch.setattr(bcb, "install_klangio_guard", spy)
    h = _standard_harness()
    try:
        assert bcb.main(["--limit", "1"], deps=h.deps()) == 0
        assert installed
        import os

        assert "KLANGIO_API_KEY" not in os.environ
        with pytest.raises(bcb.KlangioForbidden):
            klangio.KlangioChordSource()
    finally:
        for undo in installed:
            undo()
        bcb._KLANGIO_CONSTRUCTED = 0
    assert "not-a-real-key" not in capsys.readouterr().out


def test_defaults_reuse_the_worker_klangio_input_path():
    from worker import pipeline

    deps = bcb.Deps(db=None, r2=None)
    bcb._pipeline_defaults(deps)
    assert deps.chooser is pipeline._choose_chord_input
    assert deps.prober is pipeline._probe_duration_sec
    assert deps.preferred == pipeline.CHORDS_DEFAULT_STEM
    assert deps.extra["stems"] == (*pipeline._HARMONIC_STEMS, *pipeline._MIX_EXTRA_STEMS)
    assert bcb.Deps.__dataclass_fields__["btc_runner"].default is bcb.run_btc_child


def test_chords_load_error_prints_class_only(guard, capsys):
    h = _standard_harness()
    real_get = h.s3.get_object

    def get_object(Bucket, Key):  # noqa: N803
        if Key == f"jobs/{JOB_B}/play.chords.json":
            raise RuntimeError(f"{JOB_B} {LINK_B} {TITLE} {EMAIL}")
        return real_get(Bucket=Bucket, Key=Key)

    h.s3.get_object = get_object
    assert bcb.main([], deps=h.deps()) == 0
    out = capsys.readouterr()
    assert "errors=chords_RuntimeError:1" in out.out
    assert not _FORBIDDEN.search(out.out + out.err), out.out + out.err


def test_klangio_attempt_in_a_song_stops_the_run(guard, capsys):
    h = _standard_harness()
    deps = h.deps()

    def chooser(stem_paths, preferred):
        klangio.KlangioChordSource()  # raises KlangioForbidden
        return "harmonic_mix", next(iter(stem_paths.values()))

    deps.chooser = chooser
    with pytest.raises(bcb.KlangioForbidden):
        bcb.run(deps, limit=None, since=None, timeout=5.0)
    assert bcb.main([], deps=deps) == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert "fatal error_class=KlangioForbidden" in out.err


def test_swallowed_klangio_attempt_still_fails_the_run(guard, capsys):
    """Even if code below run() catches the KlangioForbidden, the end-of-run check fails."""
    h = _standard_harness()
    deps = h.deps()

    def btc(audio, timeout):
        with contextlib.suppress(bcb.KlangioForbidden):
            klangio.KlangioChordSource()
        return {"segments": [list(s) for s in h.btc_segments]}

    deps.btc_runner = btc
    with pytest.raises(bcb.KlangioForbidden):
        bcb.run(deps, limit=None, since=None, timeout=5.0)
    bcb._KLANGIO_CONSTRUCTED = 0


def test_klangio_attempt_while_loading_chords_stops_the_run(guard):
    h = _standard_harness()

    def get_object(Bucket, Key):  # noqa: N803, ARG001
        raise bcb.KlangioForbidden("x")

    h.s3.get_object = get_object
    with pytest.raises(bcb.KlangioForbidden):
        bcb.run(h.deps(), limit=None, since=None, timeout=5.0)
