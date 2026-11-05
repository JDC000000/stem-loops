"""Klangio spend protection: no double-billing on retry, monthly quota accounting.

Startup tier is real money (500 included requests/month, then $0.20 each), so these
tests pin the guarantees: the billable submit POST is never retried, every submit is
counted before it is sent, the cap refuses instead of incurring overage, a warning fires
at 80%, and the counter resets on the billing day (the 5th). NO live calls are made.
"""

from __future__ import annotations

import json
import os
import threading
import time
import wave
from datetime import UTC, date, datetime
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from worker.chord_providers import klangio as kg
from worker.chord_source import ChordQuotaExceeded

JOB = "817a59d1-0000-4000-8000-000000000000"
SUBMIT_OK = {"job_id": JOB}


def _wav(path: Path, seconds: float = 6.0) -> Path:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(b"\x00\x00" * int(8000 * seconds))
    return path


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test-key-123")
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "quota.json"))
    for name in ("KLANGIO_MONTHLY_CAP", "KLANGIO_WARN_FRACTION", "KLANGIO_BILLING_DAY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "POLL_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "_utcnow", lambda: datetime(2026, 11, 20, 12, 0, tzinfo=UTC))


def _client(handler) -> httpx.Client:
    return httpx.Client(base_url="https://api.klang.io", transport=httpx.MockTransport(handler))


def _quota_file(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "quota.json").read_text())


def _events(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    out = []
    for line in capsys.readouterr().err.splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    events = [e for e in out if e.get("event") == "klangio_quota"]
    for e in events:  # log_structured nests the (redacted) fields as a JSON string
        e["detail"] = json.loads(e["detail"])
    return events


# ----------------------------- risk 1: no double-billing -----------------------------
@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(lambda: httpx.Response(500), id="5xx-after-server-success"),
        pytest.param(lambda: httpx.Response(503), id="503"),
        pytest.param(lambda: httpx.Response(429), id="429"),
    ],
)
def test_failed_submit_is_never_retried(failure, tmp_path: Path) -> None:
    """Server may have created (and billed) the job even though we saw an error."""
    posts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return failure()

    with (
        patch.object(kg.time, "sleep") as sleep,
        pytest.raises(kg.ChordProviderError, match="not retried"),
    ):
        kg.KlangioChordSource()._submit(_client(handler), _wav(tmp_path / "a.wav"), "mix")
    assert len(posts) == 1
    sleep.assert_not_called()  # no backoff either: nothing to wait for
    # The failed attempt still counts: it may have been billed.
    assert _quota_file(tmp_path)["count"] == 1


def test_lost_response_after_server_success_does_not_double_submit(tmp_path: Path) -> None:
    """Server accepts job #1, the response is lost (timeout). No second job is created."""
    created: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        created.append(request.url.path)  # server-side success happened here
        raise httpx.ReadTimeout("response lost", request=request)

    with patch.object(kg.time, "sleep"), pytest.raises(kg.ChordProviderError, match="not retried"):
        kg.KlangioChordSource()._submit(_client(handler), _wav(tmp_path / "a.wav"), "mix")
    assert created == ["/chord-recognition"]  # exactly one billed submit


def test_gets_are_still_retried_through_transient_5xx() -> None:
    """Status/result GETs are idempotent: retrying them is safe and kept."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] == 1 else httpx.Response(200, json=[[0, 6, "N"]])

    with patch.object(kg.time, "sleep"):
        resp = kg._request_with_retry(_client(handler), method="GET", url=f"/job/{JOB}/json")
    assert resp.status_code == 200 and calls["n"] == 2


# ----------------------------- risk 2: quota accounting -----------------------------
def test_successful_submit_increments_quota(tmp_path: Path, capsys) -> None:
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    assert src._submit(client, _wav(tmp_path / "a.wav"), "mix") == JOB
    assert src._submit(client, _wav(tmp_path / "b.wav"), "mix") == JOB
    assert _quota_file(tmp_path) == {"cycle": "2026-11-05", "count": 2}
    ev = _events(capsys)
    assert [e["detail"]["count"] for e in ev] == [1, 2]
    assert ev[-1]["level"] == "INFO" and ev[-1]["detail"]["near_cap"] is False


def test_cap_refuses_at_limit_and_sends_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "2")
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json=SUBMIT_OK)

    src = kg.KlangioChordSource()
    client = _client(handler)
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded, match=r"2/2"):
        src._submit(client, _wav(tmp_path / "c.wav"), "mix")
    assert len(sent) == 2  # the refused submit never hit the network
    assert _quota_file(tmp_path)["count"] == 2  # a refusal does not consume quota


def test_default_cap_is_500(tmp_path: Path) -> None:
    (tmp_path / "quota.json").write_text(json.dumps({"cycle": "2026-11-05", "count": 499}))
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")  # 500th is allowed
    with pytest.raises(ChordQuotaExceeded):
        src._submit(client, _wav(tmp_path / "b.wav"), "mix")  # 501st is refused


def test_warning_fires_at_80_percent_not_before(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    (tmp_path / "quota.json").write_text(json.dumps({"cycle": "2026-11-05", "count": 398}))
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    for name in ("a", "b", "c"):  # reserves #399, #400, #401
        src._submit(client, _wav(tmp_path / f"{name}.wav"), "mix")
    ev = [e["detail"] | {"level": e["level"]} for e in _events(capsys)]
    assert [(e["count"], e["level"]) for e in ev] == [
        (399, "INFO"),
        (400, "WARNING"),  # 80% of 500
        (401, "WARNING"),
    ]
    assert ev[1]["near_cap"] is True and ev[1]["pct"] == 80.0


def test_warning_scales_with_a_custom_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "10")
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    for i in range(8):
        src._submit(client, _wav(tmp_path / f"{i}.wav"), "mix")
    levels = [e["level"] for e in _events(capsys)]
    assert levels == ["INFO"] * 7 + ["WARNING"]


def test_cap_refusal_is_logged_at_error_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "1")
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded):
        src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    last = _events(capsys)[-1]
    assert last["level"] == "ERROR" and last["detail"]["outcome"] == "refused_at_cap"


# ----------------------------- billing-cycle boundary -----------------------------
@pytest.mark.parametrize(
    ("today", "expected"),
    [
        (date(2026, 11, 5), date(2026, 11, 5)),  # renewal day starts the new cycle
        (date(2026, 11, 4), date(2026, 10, 5)),  # day before is still the old cycle
        (date(2026, 12, 4), date(2026, 11, 5)),
        (date(2026, 12, 5), date(2026, 12, 5)),
        (date(2027, 1, 3), date(2026, 12, 5)),  # year rollover
        (date(2027, 1, 5), date(2027, 1, 5)),
    ],
)
def test_billing_cycle_start_anchors_on_the_5th(today: date, expected: date) -> None:
    assert kg.billing_cycle_start(today) == expected


def test_billing_day_is_clamped_to_28() -> None:
    assert kg.billing_cycle_start(date(2026, 2, 28), 31) == date(2026, 2, 28)
    assert kg.billing_cycle_start(date(2026, 2, 27), 31) == date(2026, 1, 28)


def test_counter_resets_when_the_cycle_rolls_over(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "2")
    now = {"v": datetime(2026, 12, 4, 23, 59, tzinfo=UTC)}
    monkeypatch.setattr(kg, "_utcnow", lambda: now["v"])
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))

    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded):  # 2026-12-04 is still the Nov-5 cycle: full
        src._submit(client, _wav(tmp_path / "c.wav"), "mix")
    assert _quota_file(tmp_path) == {"cycle": "2026-11-05", "count": 2}

    now["v"] = datetime(2026, 12, 5, 0, 1, tzinfo=UTC)  # renewal day
    src._submit(client, _wav(tmp_path / "d.wav"), "mix")  # allowed again
    assert _quota_file(tmp_path) == {"cycle": "2026-12-05", "count": 1}


# ----------------------------- fail-closed + concurrency -----------------------------
def test_corrupt_quota_file_fails_closed_without_http(tmp_path: Path) -> None:
    (tmp_path / "quota.json").write_text("{not json")
    sent: list[httpx.Request] = []
    client = _client(lambda r: sent.append(r) or httpx.Response(200, json=SUBMIT_OK))
    with pytest.raises(kg.ChordProviderError, match="corrupt"):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav"), "mix")
    assert sent == []


@pytest.mark.parametrize("name", ["KLANGIO_MONTHLY_CAP", "KLANGIO_WARN_FRACTION"])
def test_garbage_spend_env_fails_closed(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(name, "lots")
    sent: list[httpx.Request] = []
    client = _client(lambda r: sent.append(r) or httpx.Response(200, json=SUBMIT_OK))
    with pytest.raises(kg.ChordProviderError, match=name):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav"), "mix")
    assert sent == []


def test_concurrent_reservations_never_exceed_cap(tmp_path: Path) -> None:
    store = kg.FileQuotaStore(tmp_path / "c.json")
    granted: list[bool] = []

    def worker() -> None:
        granted.append(store.reserve("2026-11-05", 10)[1])

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert granted.count(True) == 10 and granted.count(False) == 30


def test_recognize_end_to_end_counts_one_request_per_transcription(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Polls and the result GET are free; only the submit consumes allowance."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json=SUBMIT_OK)
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json=[[0.0, 6.0, "N"]])

    real_client = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        kg.httpx, "Client", lambda *a, **k: real_client(*a, transport=transport, **k)
    )
    kg.KlangioChordSource().recognize(_wav(tmp_path / "a.wav"))
    assert _quota_file(tmp_path)["count"] == 1


# ----------------------------- MIME type -----------------------------
@pytest.mark.parametrize(
    ("name", "mime"),
    [
        ("a.wav", "audio/wav"),
        ("a.MP3", "audio/mpeg"),
        ("a.flac", "audio/flac"),
        ("a.ogg", "audio/ogg"),
        ("a.m4a", "audio/mp4"),
        ("a.weird", "application/octet-stream"),
        ("noext", "application/octet-stream"),
    ],
)
def test_mime_type_follows_extension(name: str, mime: str) -> None:
    assert kg._audio_mime(Path(name)) == mime


def test_submit_sends_inferred_mime_in_multipart(tmp_path: Path) -> None:
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.read())
        return httpx.Response(200, json=SUBMIT_OK)

    path = tmp_path / "song.wav"
    _wav(path)
    mp3 = tmp_path / "song.mp3"
    mp3.write_bytes(path.read_bytes())
    kg.KlangioChordSource()._submit(_client(handler), mp3, "mix")
    assert b"Content-Type: audio/mpeg" in seen[0]


# ===================== durable store selection (no DB needed) =====================
def test_store_defaults_to_file_without_database_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("KLANGIO_QUOTA_BACKEND", raising=False)
    store = kg._default_quota_store()
    assert isinstance(store, kg.FileQuotaStore)
    assert store.path == tmp_path / "quota.json"


def test_store_is_postgres_when_database_url_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.invalid/x")
    monkeypatch.delenv("KLANGIO_QUOTA_BACKEND", raising=False)
    assert isinstance(kg._default_quota_store(), kg._PostgresQuotaStore)
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "auto")
    assert isinstance(kg._default_quota_store(), kg._PostgresQuotaStore)


def test_backend_file_overrides_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.invalid/x")
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "file")
    assert isinstance(kg._default_quota_store(), kg.FileQuotaStore)


def test_backend_postgres_without_database_url_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never silently fall back to a counter that resets when Postgres was demanded."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "postgres")
    with pytest.raises(kg.ChordProviderError, match="DATABASE_URL"):
        kg._default_quota_store()


def test_invalid_backend_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "redis")
    with pytest.raises(kg.ChordProviderError, match="KLANGIO_QUOTA_BACKEND"):
        kg._default_quota_store()


def test_unreachable_database_fails_closed_without_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none")
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "postgres")
    sent: list[httpx.Request] = []
    client = _client(lambda r: sent.append(r) or httpx.Response(200, json=SUBMIT_OK))
    with pytest.raises(kg.ChordProviderError, match="refusing to spend"):
        kg.KlangioChordSource()._submit(client, _wav(tmp_path / "a.wav"), "mix")
    assert sent == []


def test_rls_gate_passes_with_klangio_usage_migration() -> None:
    import importlib.util  # noqa: PLC0415

    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location("check_rls", root / "scripts" / "check_rls.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.main(root / "apps" / "worker" / "migrations") == 0


# ===================== Postgres store (needs a local DATABASE_URL) =====================
_DB = os.environ.get("DATABASE_URL", "")
_MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
_TEST_CYCLE_FLOOR = "2099-01-01"  # test rows live far in the future; swept before/after


@pytest.fixture
def pg():
    if not _DB:
        pytest.skip("DATABASE_URL not set")
    if not any(h in _DB for h in ("127.0.0.1", "localhost")):
        pytest.skip("klangio_usage tests write rows; local throwaway DB only")
    import psycopg  # noqa: PLC0415

    def sweep() -> None:
        with psycopg.connect(_DB, autocommit=True) as c:
            c.execute(
                "DELETE FROM public.klangio_usage WHERE cycle_start >= %s", (_TEST_CYCLE_FLOOR,)
            )

    sweep()
    yield psycopg
    sweep()


def _count(psycopg_mod, cycle: str) -> int | None:
    with psycopg_mod.connect(_DB, autocommit=True) as c:
        row = c.execute(
            "SELECT count FROM public.klangio_usage WHERE cycle_start = %s::date", (cycle,)
        ).fetchone()
    return None if row is None else row[0]


def _seed(psycopg_mod, cycle: str, count: int) -> None:
    with psycopg_mod.connect(_DB, autocommit=True) as c:
        c.execute(
            "INSERT INTO public.klangio_usage (cycle_start, count) VALUES (%s::date, %s) "
            "ON CONFLICT (cycle_start) DO UPDATE SET count = EXCLUDED.count",
            (cycle, count),
        )


def test_pg_increment_refuses_exactly_at_cap(pg) -> None:
    store, cycle = kg._PostgresQuotaStore(_DB), "2099-01-05"
    assert [store.reserve(cycle, 3) for _ in range(3)] == [(1, True), (2, True), (3, True)]
    assert store.reserve(cycle, 3) == (3, False)  # refused, total unchanged
    assert store.reserve(cycle, 3) == (3, False)
    assert _count(pg, cycle) == 3  # the refused calls wrote nothing


def test_pg_cap_zero_admits_nothing_and_writes_no_row(pg) -> None:
    """The first INSERT of a cycle skips DO UPDATE ... WHERE; the SELECT guard covers it."""
    assert kg._PostgresQuotaStore(_DB).reserve("2099-02-05", 0) == (0, False)
    assert _count(pg, "2099-02-05") is None


def test_pg_lowering_the_cap_below_current_count_refuses(pg) -> None:
    store, cycle = kg._PostgresQuotaStore(_DB), "2099-03-05"
    for _ in range(5):
        store.reserve(cycle, 10)
    assert store.reserve(cycle, 5) == (5, False)
    assert store.reserve(cycle, 2) == (5, False)
    assert _count(pg, cycle) == 5


def test_pg_concurrent_callers_never_exceed_cap(pg) -> None:
    """40 callers, each on its own connection, released together, cap 10."""
    cycle, cap, n = "2099-04-05", 10, 40
    barrier, results = threading.Barrier(n), []

    def caller() -> None:
        store = kg._PostgresQuotaStore(_DB)
        barrier.wait()
        results.append(store.reserve(cycle, cap)[1])

    threads = [threading.Thread(target=caller) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == n
    assert results.count(True) == cap and results.count(False) == n - cap
    assert _count(pg, cycle) == cap


def test_pg_last_slot_race_has_exactly_one_winner(pg) -> None:
    """The contended case that matters: N racers for the single remaining slot, many rounds."""
    cap, racers, rounds = 5, 8, 25
    for r in range(rounds):
        cycle = f"{2100 + r}-01-05"  # fresh row each round; swept in the finally below
        _seed(pg, cycle, cap - 1)
        barrier, results = threading.Barrier(racers), []

        def racer(cycle: str = cycle, barrier=barrier, results=results) -> None:
            store = kg._PostgresQuotaStore(_DB)
            barrier.wait()
            results.append(store.reserve(cycle, cap)[1])

        threads = [threading.Thread(target=racer) for _ in range(racers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results.count(True) == 1, f"round {r}: {results}"
        assert _count(pg, cycle) == cap


def test_pg_loser_rechecks_cap_after_winner_commits(pg) -> None:
    """Deterministic proof of the mechanism: B blocks on A's row lock, and when A commits
    the last slot, B's WHERE is re-evaluated against the new count -> refused."""
    cycle, cap = "2099-05-05", 3
    _seed(pg, cycle, cap - 1)
    out: list[tuple[int, bool]] = []
    a = pg.connect(_DB)  # NOT autocommit: A holds the row lock until commit
    try:
        row = a.execute(kg._RESERVE_SQL, {"cycle": cycle, "cap": cap}).fetchone()
        assert row == (cap,)  # A took the last slot, uncommitted
        b = threading.Thread(
            target=lambda: out.append(kg._PostgresQuotaStore(_DB).reserve(cycle, cap))
        )
        b.start()
        with pg.connect(_DB, autocommit=True) as mon:
            waiting = 0
            for _ in range(100):  # wait until B is genuinely blocked on the lock
                waiting = mon.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                    "AND query LIKE '%klangio_usage%' AND pid <> pg_backend_pid()"
                ).fetchone()[0]
                if waiting:
                    break
                time.sleep(0.05)
            assert waiting == 1, "B never blocked on A's row lock"
        assert out == []  # still waiting, not granted from a stale read
        a.commit()
        b.join(timeout=10)
    finally:
        a.close()
    assert out == [(cap, False)]
    assert _count(pg, cycle) == cap


def test_control_naive_read_then_write_does_overshoot(pg) -> None:
    """Negative control: proves the race is real and these tests could catch it.
    A read-then-write counter hands the last slot to BOTH racers."""
    cycle, cap = "2099-06-05", 3
    _seed(pg, cycle, cap - 1)
    barrier, granted = threading.Barrier(2), []

    def naive() -> None:
        with pg.connect(_DB, autocommit=True) as c:
            n = c.execute(
                "SELECT count FROM public.klangio_usage WHERE cycle_start = %s::date", (cycle,)
            ).fetchone()[0]
            barrier.wait()  # both have read cap-1
            if n < cap:
                c.execute(
                    "UPDATE public.klangio_usage SET count = %s WHERE cycle_start = %s::date",
                    (n + 1, cycle),
                )
                granted.append(True)

    threads = [threading.Thread(target=naive) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(granted) == 2  # one slot left, two grants: the bug the atomic SQL prevents


def test_pg_cycle_boundary_anchored_on_the_5th(
    pg, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "2")
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "postgres")
    monkeypatch.setenv("DATABASE_URL", _DB)
    now = {"v": datetime(2099, 12, 4, 23, 59, tzinfo=UTC)}
    monkeypatch.setattr(kg, "_utcnow", lambda: now["v"])
    src = kg.KlangioChordSource()
    client = _client(lambda r: httpx.Response(200, json=SUBMIT_OK))

    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded):  # 12-04 is still the 11-05 cycle: full
        src._submit(client, _wav(tmp_path / "c.wav"), "mix")
    assert _count(pg, "2099-11-05") == 2 and _count(pg, "2099-12-05") is None

    now["v"] = datetime(2099, 12, 5, 0, 1, tzinfo=UTC)  # renewal day: a fresh row
    src._submit(client, _wav(tmp_path / "d.wav"), "mix")
    assert _count(pg, "2099-12-05") == 1 and _count(pg, "2099-11-05") == 2  # history kept


def test_pg_cap_refusal_sends_no_http(pg, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "1")
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "postgres")
    monkeypatch.setenv("DATABASE_URL", _DB)
    monkeypatch.setattr(kg, "_utcnow", lambda: datetime(2099, 7, 20, tzinfo=UTC))
    sent: list[httpx.Request] = []
    client = _client(lambda r: sent.append(r) or httpx.Response(200, json=SUBMIT_OK))
    src = kg.KlangioChordSource()
    src._submit(client, _wav(tmp_path / "a.wav"), "mix")
    with pytest.raises(ChordQuotaExceeded):
        src._submit(client, _wav(tmp_path / "b.wav"), "mix")
    assert len(sent) == 1


def test_migration_028_applies_cleanly_and_is_idempotent(pg) -> None:
    from worker.migrate import split_sql_statements  # noqa: PLC0415

    up = (_MIGRATIONS / "028_v3_klangio_usage.sql").read_text()
    down = (_MIGRATIONS / "down" / "028_v3_klangio_usage_down.sql").read_text()
    conn = pg.connect(_DB)  # one transaction, rolled back: the real table is untouched
    try:
        for stmt in split_sql_statements(down):
            conn.execute(stmt)
        assert conn.execute("SELECT to_regclass('public.klangio_usage')").fetchone()[0] is None
        for _ in range(2):  # twice: idempotent
            for stmt in split_sql_statements(up):
                conn.execute(stmt)
        assert conn.execute("SELECT to_regclass('public.klangio_usage')").fetchone()[0]
        assert conn.execute(
            "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.klangio_usage'::regclass"
        ).fetchone() == (True,)
        pols = conn.execute(
            "SELECT policyname FROM pg_policies WHERE tablename = 'klangio_usage'"
        ).fetchall()
        assert ("stemloops_app_all",) in pols
        privs = {
            r[0]
            for r in conn.execute(
                "SELECT privilege_type FROM information_schema.role_table_grants "
                "WHERE table_name = 'klangio_usage' AND grantee = 'stemloops_app'"
            )
        }
        assert privs == {"SELECT", "INSERT", "UPDATE"}  # no DELETE: cannot reset the counter
        with pytest.raises(pg.errors.CheckViolation):
            conn.execute(
                "INSERT INTO public.klangio_usage (cycle_start, count) VALUES ('2099-01-05', -1)"
            )
    finally:
        conn.rollback()
        conn.close()
