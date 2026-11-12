"""The `spend_global` brake, exercised through a NOSUPERUSER role that is a MEMBER of the
production worker role.

Why this file exists, and why it does not connect as the CI user. CI's `Tests` job connects as
POSTGRES_USER `stemloops`, the container SUPERUSER, which bypasses table GRANTs and row-level
security. A brake tested only that way passes while the production role cannot read the table at
all. Here the consumer connects as `sg_probe`, a NOSUPERUSER NOBYPASSRLS login role that is a
MEMBER of `stemloops_app` (the role migration 011 grants CRUD to and attaches the
`stemloops_app_all` policy to), so the grants and the policy are in the path. A superuser
connection (`admin`) is used only to arrange state. The harness follows PR #222's
`test_fetch_gates_restricted_role.py` (same fixtures, same role-by-membership construction, same
loopback guard); it is copied rather than imported because that file is not on this branch's base.
If #222 lands, the three fixtures here (`restricted_url`, `admin`, `as_worker`) should be folded
into a shared conftest.

WHAT MEMBERSHIP DOES AND DOES NOT REPRODUCE: faithful for GRANTs and RLS policies; NOT for
anything keyed to the LOGIN role's NAME. The schema-shadow test therefore names its schema after
`sg_probe`, whose `"$user"` it is.

"Claims nothing" is asserted on the ABSENCE OF THE SIDE EFFECT, not on a return value: the job's
row is still `queued`, the pipeline was never entered, and no HTTP request of any kind left the
process (`httpx.Client.send` is replaced by a recorder; Replicate and Klangio both go through it).

Local throwaway DB only (the fixtures create a cluster-level role and alter grants/policies).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid

import httpx
import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from worker import consumer, pipeline, spend_gate
from worker.migrate import MIGRATIONS_DIR, split_sql_statements


def _is_local(dsn: str) -> bool:
    """True only if every host in the DSN is loopback or a unix socket (parsed, not substring-
    matched: `postgresql://u:localhost@db.example.com/x` contains "localhost" and is remote)."""
    hosts = [h for h in (conninfo_to_dict(dsn).get("host") or "").split(",") if h]
    return all(h in ("localhost", "127.0.0.1", "::1") or h.startswith("/") for h in hosts)


DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not _is_local(DB):
    if os.environ.get("CI"):
        raise RuntimeError(
            "test_spend_gate_restricted_role.py: DATABASE_URL is not loopback but CI is set; "
            "these tests alter roles/grants/policies and would be silently skipped. Point CI at "
            "a loopback database or change this guard on purpose."
        )
    pytestmark = pytest.mark.skip(reason="alters roles/grants/policies; local DB only")

ROLE = "sg_probe"
ROLE_PW = "sg_probe_pw"  # throwaway local role; never a real credential
FP = "spend-gate-test"  # client_fingerprint on every job this file inserts (scoped cleanup)
MIGRATION_034 = os.path.join(MIGRATIONS_DIR, "034_v3_spend_global_brake.sql")


# ------------------------------------------------------------------------------ helpers
# Scopes this file creates or may leak (the typos only exist if the CHECK is missing).
_DELETE_OWN_SCOPES = (
    "DELETE FROM public.kill_switches WHERE scope IN ('fetch_global','fetch_youtube',"
    "'Fetch_Global','fetch-global','global','spend-global')"
)


def _events(capsys) -> list[dict]:
    out = []
    for line in capsys.readouterr().err.splitlines():
        line = line.strip()
        if line.startswith("{"):
            rec = json.loads(line)
            rec["detail"] = json.loads(rec["detail"]) if rec.get("detail") else {}
            out.append(rec)
    return out


def _named(events: list[dict], name: str) -> list[dict]:
    return [e for e in events if e["event"] == name]


def _drop_role(c) -> None:
    if c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,)).fetchone():
        c.execute(f"DROP OWNED BY {ROLE}")
        c.execute(f"DROP ROLE {ROLE}")


def _restore_switch_acls(c) -> None:
    """Put back exactly what migration 011 installs, whatever a test did."""
    c.execute("ALTER TABLE public.kill_switches ENABLE ROW LEVEL SECURITY")
    c.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON public.kill_switches TO stemloops_app")
    c.execute("DROP POLICY IF EXISTS stemloops_app_all ON public.kill_switches")
    c.execute(
        "CREATE POLICY stemloops_app_all ON public.kill_switches FOR ALL TO stemloops_app "
        "USING (true) WITH CHECK (true)"
    )


def _set_brake(c, enabled: bool) -> None:
    c.execute(
        "INSERT INTO public.kill_switches(scope, enabled) VALUES ('spend_global', %s) "
        "ON CONFLICT (scope) DO UPDATE SET enabled = EXCLUDED.enabled",
        (enabled,),
    )


# ------------------------------------------------------------------------------ fixtures
@pytest.fixture(scope="module")
def restricted_url():
    """Create the NOSUPERUSER role once and hand back a conninfo string for it."""
    with psycopg.connect(DB, autocommit=True) as c:
        _drop_role(c)
        c.execute(
            f"CREATE ROLE {ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE "
            f"PASSWORD '{ROLE_PW}'"
        )
        c.execute(f"GRANT stemloops_app TO {ROLE}")
        db = c.info.dbname
        c.execute(f'GRANT CONNECT ON DATABASE "{db}" TO {ROLE}')
    url = make_conninfo(DB, user=ROLE, password=ROLE_PW)
    with psycopg.connect(url) as r:  # fail loudly if the role is not what we claim
        assert r.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone() == (False, False)
    yield url
    with psycopg.connect(DB, autocommit=True) as c:
        _drop_role(c)


@pytest.fixture
def admin():
    """Superuser connection (autocommit) with a known starting state, everything restored after.
    Touches only the scopes and jobs this file owns."""
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute("DELETE FROM public.jobs WHERE client_fingerprint = %s", (FP,))
        c.execute(_DELETE_OWN_SCOPES)
        _restore_switch_acls(c)
        _set_brake(c, False)  # the state migration 034 leaves: row present, released
        spend_gate.reset_log_state()
        try:
            yield c
        finally:
            _restore_switch_acls(c)
            if c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,)).fetchone():
                c.execute(f"ALTER ROLE {ROLE} RESET statement_timeout")
            c.execute(f"DROP SCHEMA IF EXISTS {ROLE} CASCADE")
            c.execute(_DELETE_OWN_SCOPES)
            _set_brake(c, False)
            c.execute("DELETE FROM public.jobs WHERE client_fingerprint = %s", (FP,))


@pytest.fixture
def as_worker(restricted_url, admin, monkeypatch):
    """Point the consumer (and the pipeline it would run) at the restricted role."""
    monkeypatch.setattr(consumer, "DATABASE_URL", restricted_url)
    monkeypatch.setattr(pipeline, "DATABASE_URL", restricted_url)
    monkeypatch.setenv("DATABASE_URL", restricted_url)
    return admin


@pytest.fixture
def http(monkeypatch):
    """Record every outbound HTTP request the process attempts; answer 422 to all of them.
    Replicate (httpx.post) and Klangio (httpx.Client) both bottom out in Client.send."""
    sent: list[tuple[str, str]] = []

    def fake_send(self, request, **kw):
        sent.append((request.method, str(request.url)))
        return httpx.Response(422, request=request, json={"detail": "recorded, not sent"})

    monkeypatch.setattr(httpx.Client, "send", fake_send)

    async def fake_asend(self, request, **kw):
        sent.append((request.method, str(request.url)))
        return httpx.Response(422, request=request, json={"detail": "recorded, not sent"})

    monkeypatch.setattr(httpx.AsyncClient, "send", fake_asend)
    return sent


@pytest.fixture
def spy_pipeline(monkeypatch):
    """A run_pipeline stand-in that records entry. The engaged tests assert it is NEVER entered."""
    entered: list[str] = []

    async def fake(job_id: str) -> None:
        entered.append(job_id)
        with psycopg.connect(DB) as c:
            c.execute("UPDATE public.jobs SET status='done' WHERE id=%s", (job_id,))

    monkeypatch.setattr(consumer, "run_pipeline", fake)
    return entered


def _new_job(admin, *, kind: str = "upload") -> str:
    """Queued job, created_at at the epoch so `ORDER BY created_at` picks it over any other
    queued row in a shared database."""
    jid = str(uuid.uuid4())
    admin.execute(
        "INSERT INTO public.jobs(id, input_kind, upload_r2_key, original_filename, youtube_url,"
        " requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint,"
        " created_at) VALUES (%s,%s,%s,%s,%s,%s,4,'queued','t',%s,'1970-01-01')",
        (
            jid,
            kind,
            f"uploads/{jid}.mp3" if kind == "upload" else None,
            "song.mp3" if kind == "upload" else None,
            None if kind == "upload" else "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            ["drums"],
            FP,
        ),
    )
    return jid


def _status(admin, jid: str) -> str:
    return admin.execute("SELECT status FROM public.jobs WHERE id=%s", (jid,)).fetchone()[0]


def _claim() -> bool:
    return asyncio.run(consumer.claim_and_run())


def _predictions_posts(sent) -> list[tuple[str, str]]:
    return [s for s in sent if s[0] == "POST" and s[1].endswith("/v1/predictions")]


# ======================================================================================
# 1 + 2. Engaged -> claims nothing; released -> the same job is claimed.
# ======================================================================================
def test_control_released_brake_claims_the_job_as_the_restricted_role(as_worker, spy_pipeline):
    """Positive control: without it every 'claims nothing' test below passes for any broken setup."""
    jid = _new_job(as_worker)
    assert _claim() is True
    assert spy_pipeline == [jid]
    assert _status(as_worker, jid) == "done"


def test_engaged_brake_claims_nothing_and_the_job_stays_queued(
    as_worker, spy_pipeline, http, capsys
):
    jid = _new_job(as_worker)
    _set_brake(as_worker, True)
    capsys.readouterr()

    assert _claim() is False
    # The absence of the side effects, not just the return value:
    assert _status(as_worker, jid) == "queued", "the job left 'queued' while the brake was engaged"
    assert spy_pipeline == [], "run_pipeline was entered while the brake was engaged"
    assert http == [], f"an outbound HTTP request was attempted: {http}"
    assert (
        as_worker.execute("SELECT attempts FROM public.jobs WHERE id=%s", (jid,)).fetchone()[0] == 0
    )
    ev = _named(_events(capsys), "spend_brake_engaged")
    assert len(ev) == 1 and ev[0]["level"] == "WARN"
    assert ev[0]["detail"]["reason"] == "switch_engaged"


def test_released_after_engaged_claims_the_same_job(as_worker, spy_pipeline, http):
    jid = _new_job(as_worker)
    _set_brake(as_worker, True)
    assert _claim() is False and _status(as_worker, jid) == "queued"
    _set_brake(as_worker, False)  # operator releases
    assert _claim() is True
    assert spy_pipeline == [jid]
    assert _status(as_worker, jid) == "done"


def test_engaged_brake_stops_an_UPLOAD_job_reaching_replicate_even_with_both_fetch_switches_on(
    as_worker, http, monkeypatch
):
    """The measured problem, end to end through the REAL pipeline. fetch_global and fetch_youtube
    are both engaged (the two switches that existed) and the job is an upload: before the brake
    existed this submitted POST /v1/predictions x1. Only the R2 download edge is faked."""
    monkeypatch.setenv("REPLICATE_API_TOKEN", "test-not-a-secret")
    monkeypatch.setattr(
        pipeline, "_prepare_upload_source", lambda job_id, key: "https://example.invalid/a.wav"
    )
    as_worker.execute(
        "INSERT INTO public.kill_switches(scope, enabled) VALUES ('fetch_global', true),"
        " ('fetch_youtube', true)"
    )
    jid = _new_job(as_worker, kind="upload")

    _set_brake(as_worker, True)
    assert _claim() is False
    assert _predictions_posts(http) == [], "Replicate was called while the brake was engaged"
    assert http == []
    assert _status(as_worker, jid) == "queued"

    _set_brake(as_worker, False)  # released: the identical job now reaches Replicate exactly once
    assert _claim() is True
    assert len(_predictions_posts(http)) == 1, http


# ======================================================================================
# 3. Fail-closed, each fault separately. Every case runs with the row ENGAGED (what an operator
#    leaves behind) and with it RELEASED; both must not claim. Each ends by repairing the fault
#    and proving the job IS then claimed, so "did not claim" cannot be a broken fixture.
# ======================================================================================
def _fault_row_absent(c):
    c.execute("DELETE FROM public.kill_switches WHERE scope = 'spend_global'")


def _repair_row_absent(c):
    _set_brake(c, False)


def _fault_select_revoked(c):
    c.execute("REVOKE SELECT ON public.kill_switches FROM stemloops_app")


def _fault_rls_policy_dropped(c):
    c.execute("DROP POLICY stemloops_app_all ON public.kill_switches")


FAULTS = {
    "row_absent": (_fault_row_absent, _repair_row_absent, "row_absent"),
    "select_revoked": (_fault_select_revoked, _restore_switch_acls, "read_failed"),
    "rls_policy_dropped": (_fault_rls_policy_dropped, _restore_switch_acls, "row_absent"),
}


@pytest.mark.parametrize("row_enabled", [True, False], ids=["row-engaged", "row-released"])
@pytest.mark.parametrize("fault", list(FAULTS))
def test_unreadable_or_missing_switch_fails_closed(
    as_worker, spy_pipeline, http, capsys, fault, row_enabled
):
    inject, repair, reason = FAULTS[fault]
    jid = _new_job(as_worker)
    _set_brake(as_worker, row_enabled)
    inject(as_worker)
    capsys.readouterr()

    assert _claim() is False
    assert _status(as_worker, jid) == "queued"
    assert spy_pipeline == [] and http == []
    ev = _named(_events(capsys), "spend_brake_engaged")
    assert ev and ev[0]["detail"]["reason"] == reason, ev

    repair(as_worker)
    _set_brake(as_worker, False)
    assert _claim() is True, "after repair the same job must be claimed (control)"
    assert spy_pipeline == [jid]


@pytest.mark.parametrize("row_enabled", [True, False], ids=["row-engaged", "row-released"])
def test_statement_timeout_with_an_operator_lock_fails_closed_and_is_bounded(
    as_worker, spy_pipeline, http, capsys, row_enabled
):
    """An operator holds ACCESS EXCLUSIVE on kill_switches (a maintenance ALTER, a stuck migration)
    and the role has a statement_timeout. The old gate failed OPEN here in 0.430 s."""
    jid = _new_job(as_worker)
    _set_brake(as_worker, row_enabled)
    as_worker.execute(f"ALTER ROLE {ROLE} SET statement_timeout = '300ms'")
    locker = psycopg.connect(DB)  # non-autocommit: the lock lives until rollback
    try:
        locker.execute("LOCK TABLE public.kill_switches IN ACCESS EXCLUSIVE MODE")
        capsys.readouterr()
        t0 = time.monotonic()
        claimed = _claim()
        elapsed = time.monotonic() - t0
    finally:
        locker.rollback()
        locker.close()

    assert claimed is False
    assert _status(as_worker, jid) == "queued"
    assert spy_pipeline == [] and http == []
    ev = _named(_events(capsys), "spend_brake_engaged")
    assert ev and ev[0]["detail"]["reason"] == "read_failed", ev
    assert "timeout" in ev[0]["detail"]["error"], ev
    # Bounded: gave up at the server-side bound (2 s) -- not hung on the lock, not the 5 s wall.
    assert elapsed < spend_gate.WALL_TIMEOUT_S, elapsed

    as_worker.execute(f"ALTER ROLE {ROLE} RESET statement_timeout")
    _set_brake(as_worker, False)
    assert _claim() is True  # lock released, brake released: control


def test_lock_with_no_role_timeout_is_still_bounded_by_the_gates_own_timeout(
    as_worker, spy_pipeline, http
):
    """No statement_timeout on the role at all (the production default): without the gate's own
    SET LOCAL bound the poll loop would hang on the lock forever, taking the reaper with it."""
    jid = _new_job(as_worker)
    locker = psycopg.connect(DB)
    try:
        locker.execute("LOCK TABLE public.kill_switches IN ACCESS EXCLUSIVE MODE")
        t0 = time.monotonic()
        assert _claim() is False
        elapsed = time.monotonic() - t0
    finally:
        locker.rollback()
        locker.close()
    assert _status(as_worker, jid) == "queued" and spy_pipeline == [] and http == []
    assert spend_gate.READ_TIMEOUT_MS / 1000 <= elapsed < spend_gate.WALL_TIMEOUT_S, elapsed


def test_a_read_that_never_answers_is_cut_off_by_the_wall_clock_bound(
    as_worker, spy_pipeline, http, monkeypatch, capsys
):
    """The server-side timers cannot fire on a network black hole after connect."""
    jid = _new_job(as_worker)

    async def hang(dsn):
        await asyncio.sleep(3600)

    monkeypatch.setattr(spend_gate, "_read", hang)
    monkeypatch.setattr(spend_gate, "WALL_TIMEOUT_S", 0.3)
    capsys.readouterr()
    t0 = time.monotonic()
    assert _claim() is False
    assert time.monotonic() - t0 < 2
    assert _status(as_worker, jid) == "queued" and spy_pipeline == [] and http == []
    ev = _named(_events(capsys), "spend_brake_engaged")
    assert ev and ev[0]["detail"]["reason"] == "read_timeout"


def test_a_shadow_kill_switches_in_the_login_roles_schema_cannot_release_the_brake(
    as_worker, spy_pipeline, http
):
    """`"$user"` resolves to the login role, so an unqualified `kill_switches` would read THIS
    table. The gate qualifies public. and pins search_path, so the engaged real row wins."""
    jid = _new_job(as_worker)
    _set_brake(as_worker, True)
    as_worker.execute(f"CREATE SCHEMA {ROLE}")
    as_worker.execute(
        f"CREATE TABLE {ROLE}.kill_switches (scope text PRIMARY KEY, enabled boolean NOT NULL)"
    )
    as_worker.execute(f"INSERT INTO {ROLE}.kill_switches VALUES ('spend_global', false)")
    as_worker.execute(f"GRANT USAGE ON SCHEMA {ROLE} TO {ROLE}")
    as_worker.execute(f"GRANT SELECT ON {ROLE}.kill_switches TO {ROLE}")
    # control: the role really does resolve the unqualified name to the shadow
    with psycopg.connect(consumer.DATABASE_URL) as r:
        assert r.execute(
            "SELECT enabled FROM kill_switches WHERE scope='spend_global'"
        ).fetchone() == (False,)

    assert _claim() is False
    assert _status(as_worker, jid) == "queued" and spy_pipeline == [] and http == []


def test_pre_migration_world_does_not_crash_and_claims_nothing(
    as_worker, spy_pipeline, http, capsys
):
    """Worker deployed BEFORE migration 034: no spend_global row. The call returns (no exception
    escapes), the job stays queued, nothing is spent, and the log says why."""
    jid = _new_job(as_worker)
    as_worker.execute("DELETE FROM public.kill_switches WHERE scope = 'spend_global'")
    capsys.readouterr()
    assert _claim() is False  # returned, did not raise
    assert _status(as_worker, jid) == "queued" and spy_pipeline == [] and http == []
    ev = _named(_events(capsys), "spend_brake_engaged")
    assert ev and ev[0]["detail"]["reason"] == "row_absent"


def test_the_whole_table_missing_is_also_just_engaged(as_worker, spy_pipeline, http):
    jid = _new_job(as_worker)
    as_worker.execute("ALTER TABLE public.kill_switches RENAME TO kill_switches_hidden")
    try:
        assert _claim() is False
    finally:
        as_worker.execute("ALTER TABLE public.kill_switches_hidden RENAME TO kill_switches")
    assert _status(as_worker, jid) == "queued" and spy_pipeline == [] and http == []


# ======================================================================================
# 5. The latch. The previous gate cached "not engaged" and, once SELECT was lost, served that
#    answer forever. This brake has no cache, so the bound is ONE claim attempt.
# ======================================================================================
def test_a_worker_that_saw_not_engaged_stops_claiming_the_moment_it_loses_select(
    as_worker, spy_pipeline, http, monkeypatch
):
    first = _new_job(as_worker)
    assert _claim() is True  # warm: the gate has just read "not engaged" and let a job through
    assert spy_pipeline == [first]

    t_loss = time.monotonic()
    as_worker.execute("REVOKE SELECT ON public.kill_switches FROM stemloops_app")  # SELECT lost
    second = _new_job(as_worker)
    assert _claim() is False, "the very next claim attempt after losing SELECT must refuse"
    first_refusal_s = time.monotonic() - t_loss
    assert _status(as_worker, second) == "queued"
    # THE BOUND: the next claim_and_run call (a worker idles POLL_INTERVAL = 2 s between calls;
    # a busy one calls again when its job ends). The read gives up in <= WALL_TIMEOUT_S (5 s).
    assert first_refusal_s < consumer.POLL_INTERVAL + spend_gate.WALL_TIMEOUT_S
    print(f"\nLATCH: first refusal {first_refusal_s * 1000:.0f} ms after SELECT was lost")

    # And it never un-refuses: jump the clock by the offsets the old gate's cache was blind at.
    real = time.monotonic
    for minutes in (1, 10, 60, 1440):
        monkeypatch.setattr(time, "monotonic", lambda m=minutes: real() + m * 60)
        jid = _new_job(as_worker)
        assert _claim() is False, f"claimed {minutes} min after SELECT was lost"
        assert _status(as_worker, jid) == "queued"
    assert spy_pipeline == [first] and http == []


# ======================================================================================
# Logging: transitions are logged, a standing engaged brake is rate-limited, never silent.
# ======================================================================================
def test_engaged_brake_logs_once_per_interval_and_logs_the_release(as_worker, capsys, monkeypatch):
    _set_brake(as_worker, True)
    capsys.readouterr()
    for _ in range(25):
        _claim()
    assert len(_named(_events(capsys), "spend_brake_engaged")) == 1

    real = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real() + spend_gate.LOG_EVERY_S + 1)
    _claim()
    assert len(_named(_events(capsys), "spend_brake_engaged")) == 1  # re-logged after the interval

    _set_brake(as_worker, False)
    _claim()
    assert len(_named(_events(capsys), "spend_brake_released")) == 1


# ======================================================================================
# 4. The scope CHECK (and the migration's own contract). Superuser connection: a CHECK binds
#    superusers too, which is the point.
# ======================================================================================
@pytest.mark.parametrize("bad", ["Fetch_Global", "fetch-global", "global"])
def test_scope_check_rejects_the_typos_that_used_to_do_nothing(admin, bad):
    with pytest.raises(psycopg.errors.CheckViolation, match="kill_switches_scope_known"):
        admin.execute("INSERT INTO public.kill_switches(scope, enabled) VALUES (%s, true)", (bad,))
    assert (
        admin.execute("SELECT 1 FROM public.kill_switches WHERE scope=%s", (bad,)).fetchone()
        is None
    )


def test_scope_check_rejects_renaming_a_live_switch_into_a_typo(admin):
    with pytest.raises(psycopg.errors.CheckViolation):
        admin.execute(
            "UPDATE public.kill_switches SET scope='spend-global' WHERE scope='spend_global'"
        )


@pytest.mark.parametrize(
    "good",
    [
        "fetch_global",
        "fetch_youtube",
        "fetch_spotify",
        "fetch_cobalt",
        "serve_mix_first",
        "payments_r",
        "spend_global",
    ],
)
def test_scope_check_accepts_every_documented_scope(admin, good):
    admin.execute("BEGIN")
    try:
        admin.execute(
            "INSERT INTO public.kill_switches(scope, enabled) VALUES (%s, false) "
            "ON CONFLICT (scope) DO UPDATE SET enabled = kill_switches.enabled",
            (good,),
        )
    finally:
        admin.execute("ROLLBACK")


def _run_034(c) -> None:
    with open(MIGRATION_034) as f:
        for stmt in split_sql_statements(f.read()):
            c.execute(stmt)


def test_migration_is_idempotent_and_never_releases_an_engaged_brake(admin):
    admin.execute("BEGIN")  # rolled back: the test must not leave the migration half-applied
    try:
        _set_brake(admin, True)  # operator engaged it
        for _ in range(2):
            _run_034(admin)  # re-applied twice
        assert admin.execute(
            "SELECT enabled FROM public.kill_switches WHERE scope='spend_global'"
        ).fetchone() == (True,)
        assert admin.execute(
            "SELECT count(*) FROM pg_constraint WHERE conname='kill_switches_scope_known'"
        ).fetchone() == (1,)
    finally:
        admin.execute("ROLLBACK")


def test_migration_does_not_fail_on_a_preexisting_bad_row_and_leaves_the_check_not_valid(admin):
    """A bad row left by the old free-text scope must not make the migration fail (that would block
    every later migration); it is warned about, and new writes are still checked."""
    admin.execute("BEGIN")
    try:
        admin.execute("ALTER TABLE public.kill_switches DROP CONSTRAINT kill_switches_scope_known")
        admin.execute("INSERT INTO public.kill_switches(scope, enabled) VALUES ('global', true)")
        _run_034(admin)  # must not raise
        assert admin.execute(
            "SELECT convalidated FROM pg_constraint WHERE conname='kill_switches_scope_known'"
        ).fetchone() == (False,)
        admin.execute("SAVEPOINT s")
        with pytest.raises(psycopg.errors.CheckViolation):
            admin.execute(
                "INSERT INTO public.kill_switches(scope, enabled) VALUES ('Fetch_Global', true)"
            )
        admin.execute("ROLLBACK TO SAVEPOINT s")
    finally:
        admin.execute("ROLLBACK")


def test_migration_seeds_the_brake_released_and_validates_the_check_on_a_clean_table(admin):
    row = admin.execute(
        "SELECT enabled FROM public.kill_switches WHERE scope='spend_global'"
    ).fetchone()
    assert row == (False,)
    assert admin.execute(
        "SELECT convalidated FROM pg_constraint WHERE conname='kill_switches_scope_known'"
    ).fetchone() == (True,)
