"""QA track B, B-01: `public._migrations` must be closed to Supabase's browser roles.

The runner creates the ledger itself, so no migration ever enabled RLS on it. On Supabase,
`anon` and `authenticated` get ALL on every new `public` table by default, and the anon key
is in the browser bundle: an anonymous caller could DELETE a ledger row and make the next
`make migrate` re-run that migration (locally: 014's seed, reverting 034's pricing).

Every test here builds its OWN scratch database, sets Supabase's default privileges in it
(`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`) and checks the
LIVE CATALOG after the real runner or the real migration file ran, not the SQL text.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import psycopg.sql
import pytest
from psycopg.conninfo import make_conninfo

import worker.migrate as migrate
from tests.test_chord_edits_schema import _not_local, _skip_or_fail

DB = os.environ.get("DATABASE_URL")
MIGRATION_041 = (
    Path(__file__).resolve().parents[1] / "migrations" / "041_v3_migrations_ledger_rls.sql"
)
PRIVS = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")


@pytest.fixture(autouse=True)
def _require_local_database() -> None:
    if not DB:
        _skip_or_fail("DATABASE_URL not set")
    problem = _not_local(DB)
    if problem:
        _skip_or_fail(f"DATABASE_URL is not provably local ({problem})")


@pytest.fixture
def scratch(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A fresh database with Supabase's default grants to the browser roles."""
    assert DB is not None
    name = f"ledger_rls_{uuid.uuid4().hex[:12]}"
    dsn = make_conninfo(DB, dbname=name)
    ident = psycopg.sql.Identifier(name)
    with psycopg.connect(DB, autocommit=True) as admin:
        for role in ("anon", "authenticated", "stemloops_app"):
            admin.execute(
                psycopg.sql.SQL(
                    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {r}) "
                    "THEN EXECUTE format('CREATE ROLE %I NOLOGIN', {r}); END IF; END $$"
                ).format(r=psycopg.sql.Literal(role))
            )
        admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8'").format(ident)
        )
        try:
            with psycopg.connect(dsn, autocommit=True) as c:
                c.execute(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                    "GRANT ALL ON TABLES TO anon, authenticated"
                )
            monkeypatch.setenv("DATABASE_URL", dsn)
            yield dsn
        finally:
            admin.execute(psycopg.sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(ident))


def _browser_privs(conn: psycopg.Connection) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for role in ("anon", "authenticated"):
        out[role] = [
            p
            for p in PRIVS
            if conn.execute(
                "SELECT has_table_privilege(%s, 'public._migrations', %s)", (role, p)
            ).fetchone()[0]
        ]
    return out


def _rls_on(conn: psycopg.Connection) -> bool:
    return conn.execute(
        "SELECT relrowsecurity FROM pg_class WHERE oid = 'public._migrations'::regclass"
    ).fetchone()[0]


def _open_old_style_ledger(conn: psycopg.Connection) -> None:
    """The ledger as the pre-fix runner left it: no RLS, default grants to anon/authenticated."""
    conn.execute(
        "CREATE TABLE public._migrations (filename text PRIMARY KEY, "
        "applied_at timestamptz DEFAULT now())"
    )
    conn.execute("INSERT INTO public._migrations(filename) VALUES ('014_v3_seed_plans.sql')")
    assert _browser_privs(conn)["anon"], "precondition: the default grants did not apply"


def test_fresh_migrate_leaves_the_ledger_closed_to_anon_and_authenticated(scratch):
    migrate.run()
    with psycopg.connect(scratch) as conn:
        assert _rls_on(conn)
        assert _browser_privs(conn) == {"anon": [], "authenticated": []}
        conn.execute("SET ROLE anon")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("DELETE FROM public._migrations WHERE filename LIKE '014%'")
        conn.rollback()
    # Re-run is idempotent and still closed.
    migrate.run()
    with psycopg.connect(scratch) as conn:
        assert _rls_on(conn)
        assert _browser_privs(conn) == {"anon": [], "authenticated": []}
        assert conn.execute("SELECT count(*) FROM public._migrations").fetchone()[0] == len(
            migrate.discover_migration_paths()
        )


def test_runner_closes_an_already_open_ledger_on_its_next_run(scratch, monkeypatch, tmp_path):
    """Staging today: the ledger exists, RLS off, browser roles hold ALL. The runner must fix
    that on its next run even with nothing to apply (empty migrations dir)."""
    with psycopg.connect(scratch, autocommit=True) as conn:
        _open_old_style_ledger(conn)
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", str(tmp_path))
    migrate.run()
    with psycopg.connect(scratch) as conn:
        assert _rls_on(conn)
        assert _browser_privs(conn) == {"anon": [], "authenticated": []}
        assert conn.execute("SELECT count(*) FROM public._migrations").fetchone()[0] == 1


def _apply_041(dsn: str) -> None:
    with psycopg.connect(dsn) as conn:
        for stmt in migrate.split_sql_statements(MIGRATION_041.read_text()):
            conn.execute(stmt)
        conn.commit()


def _policies(conn: psycopg.Connection) -> list[tuple]:
    return conn.execute(
        "SELECT policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies "
        "WHERE schemaname = 'public' AND tablename = '_migrations' ORDER BY policyname"
    ).fetchall()


def test_041_on_the_production_shape_changes_only_the_grants(scratch):
    """Production: RLS already on, one `stemloops_app_all` policy. 041 must leave both alone
    and only revoke the browser roles' grants."""
    with psycopg.connect(scratch, autocommit=True) as conn:
        _open_old_style_ledger(conn)
        conn.execute("ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY")
        conn.execute(
            "CREATE POLICY stemloops_app_all ON public._migrations FOR ALL TO stemloops_app "
            "USING (true) WITH CHECK (true)"
        )
        before = _policies(conn)
        rows_before = conn.execute("SELECT filename FROM public._migrations").fetchall()
    _apply_041(scratch)
    _apply_041(scratch)  # re-run safe
    with psycopg.connect(scratch) as conn:
        assert _rls_on(conn)
        assert _policies(conn) == before and len(before) == 1
        assert conn.execute("SELECT filename FROM public._migrations").fetchall() == rows_before
        assert _browser_privs(conn) == {"anon": [], "authenticated": []}


def test_041_on_the_staging_shape_enables_rls_and_revokes(scratch):
    with psycopg.connect(scratch, autocommit=True) as conn:
        _open_old_style_ledger(conn)
    _apply_041(scratch)
    with psycopg.connect(scratch) as conn:
        assert _rls_on(conn)
        assert _policies(conn) == []
        assert _browser_privs(conn) == {"anon": [], "authenticated": []}


def test_hardening_does_not_need_ownership_once_the_ledger_is_closed(scratch):
    """A runner that does not own the ledger (but can read and write it) must pass through
    the guarded block once RLS is on and the browser roles hold nothing: no ALTER TABLE
    (needs ownership), no REVOKE (would need a privilege on the table)."""
    role = f"ledger_nonowner_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(scratch, autocommit=True) as conn:
        _open_old_style_ledger(conn)
        conn.execute(migrate.LEDGER_HARDEN_SQL)  # as owner: closes it
        conn.execute(psycopg.sql.SQL("CREATE ROLE {} NOLOGIN").format(psycopg.sql.Identifier(role)))
        conn.execute(
            psycopg.sql.SQL("GRANT SELECT, INSERT ON public._migrations TO {}").format(
                psycopg.sql.Identifier(role)
            )
        )
        try:
            conn.execute(psycopg.sql.SQL("SET ROLE {}").format(psycopg.sql.Identifier(role)))
            conn.execute(migrate.LEDGER_HARDEN_SQL)  # must not raise
            conn.execute("RESET ROLE")
            assert _rls_on(conn)
            assert _browser_privs(conn) == {"anon": [], "authenticated": []}
        finally:
            conn.execute("RESET ROLE")
            conn.execute(psycopg.sql.SQL("DROP OWNED BY {}").format(psycopg.sql.Identifier(role)))
            conn.execute(
                psycopg.sql.SQL("DROP ROLE IF EXISTS {}").format(psycopg.sql.Identifier(role))
            )


def test_hardening_raises_when_a_non_owner_cannot_revoke(scratch):
    """REVOKE by a non-owner without grant option is only a WARNING in Postgres (psycopg drops
    it). The block must notice the grant survived and fail loudly, never leave it open."""
    role = f"ledger_nonowner_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(scratch, autocommit=True) as conn:
        _open_old_style_ledger(conn)
        conn.execute("ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY")
        conn.execute(psycopg.sql.SQL("CREATE ROLE {} NOLOGIN").format(psycopg.sql.Identifier(role)))
        conn.execute(
            psycopg.sql.SQL("GRANT SELECT, INSERT ON public._migrations TO {}").format(
                psycopg.sql.Identifier(role)
            )
        )
        try:
            conn.execute(psycopg.sql.SQL("SET ROLE {}").format(psycopg.sql.Identifier(role)))
            with pytest.raises(psycopg.errors.RaiseException, match="still accessible to anon"):
                conn.execute(migrate.LEDGER_HARDEN_SQL)
        finally:
            conn.execute("RESET ROLE")
            conn.execute(psycopg.sql.SQL("DROP OWNED BY {}").format(psycopg.sql.Identifier(role)))
            conn.execute(
                psycopg.sql.SQL("DROP ROLE IF EXISTS {}").format(psycopg.sql.Identifier(role))
            )
