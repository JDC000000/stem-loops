"""Migration 031 (delete_chord_edits_for_user) regression tests.

025 makes chord_edits append-only for stemloops_app, so the account-deletion
route's raw ``DELETE FROM chord_edits`` raised 42501 in prod (the role the app
connects as). 031 adds a narrow SECURITY DEFINER erasure function instead of
re-granting DELETE. These tests run AS stemloops_app / anon / authenticated
(SET ROLE) because a superuser connection would pass even with the bug.

Requires a real local Postgres with migrations applied through 031; skipped
without DATABASE_URL, refused on non-local hosts (INSERTs into auth.users).
The connecting role must be a superuser or a member of the roles it SET ROLEs to.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import psycopg
import pytest
from psycopg import errors

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(
        reason="031 tests INSERT into auth.users; local throwaway DB only"
    )

EMAIL_LIKE = "test-erase-fn-%@example.com"


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    c.execute("RESET ROLE")
    c.execute(
        "DELETE FROM public.chord_edits WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE %s)",
        (EMAIL_LIKE,),
    )
    c.execute(
        "DELETE FROM public.jobs WHERE user_id IN "
        "(SELECT id FROM public.users WHERE email LIKE %s)",
        (EMAIL_LIKE,),
    )
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.commit()


def _user_with_edits(c: Any, tag: str, n: int) -> uuid.UUID:
    uid, jid = uuid.uuid4(), uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-erase-fn-{tag}@example.com"),
    )
    c.execute(
        "INSERT INTO public.jobs (id, youtube_url, status, client_ip_hash, "
        "client_fingerprint, user_id, loop_length_bars) "
        "VALUES (%s, 'https://example.test/x', 'done', 'h', '', %s, 8)",
        (jid, uid),
    )
    for i in range(n):
        c.execute(
            "INSERT INTO public.chord_edits (user_id, job_id, track_hash, provider, "
            "provider_version, start_sec, end_sec, original_label, corrected_label, "
            "alphabet_sha) VALUES (%s,%s,%s,'klangio','k-1.0',%s,%s,'C','C:min',%s)",
            (uid, jid, "f" * 64, float(i), float(i) + 1.0, "a" * 64),
        )
    c.commit()
    return uid


def _count(c: Any, uid: uuid.UUID) -> int:
    (n,) = c.execute("SELECT count(*) FROM public.chord_edits WHERE user_id=%s", (uid,)).fetchone()
    return n


def test_app_role_cannot_raw_delete_chord_edits(conn):
    """The append-only property of 025 is preserved: the raw DELETE still fails."""
    uid = _user_with_edits(conn, "raw", 1)
    conn.execute("SET ROLE stemloops_app")
    with pytest.raises(errors.InsufficientPrivilege):
        conn.execute("DELETE FROM public.chord_edits WHERE user_id = %s", (uid,))
    conn.rollback()
    conn.execute("RESET ROLE")
    assert _count(conn, uid) == 1


def test_app_role_can_erase_one_users_edits_via_function(conn):
    """THE regression: as stemloops_app, erasure works and touches only that user."""
    a = _user_with_edits(conn, "a", 3)
    b = _user_with_edits(conn, "b", 2)
    conn.execute("SET ROLE stemloops_app")
    (deleted,) = conn.execute("SELECT public.delete_chord_edits_for_user(%s)", (a,)).fetchone()
    conn.commit()
    conn.execute("RESET ROLE")
    assert deleted == 3
    assert _count(conn, a) == 0
    assert _count(conn, b) == 2, "another user's ledger rows must survive"


def test_function_returns_zero_for_user_without_edits(conn):
    a = _user_with_edits(conn, "none", 0)
    conn.execute("SET ROLE stemloops_app")
    (deleted,) = conn.execute("SELECT public.delete_chord_edits_for_user(%s)", (a,)).fetchone()
    conn.rollback()
    assert deleted == 0


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_unprivileged_roles_cannot_execute_function(conn, role):
    """REVOKE ... FROM PUBLIC (and the Supabase anon/authenticated defaults) holds."""
    uid = _user_with_edits(conn, f"priv-{role}", 1)
    conn.execute(f"SET ROLE {role}")
    with pytest.raises(errors.InsufficientPrivilege):
        conn.execute("SELECT public.delete_chord_edits_for_user(%s)", (uid,))
    conn.rollback()
    conn.execute("RESET ROLE")
    assert _count(conn, uid) == 1


def test_null_user_id_is_rejected(conn):
    with pytest.raises(errors.NullValueNotAllowed):
        conn.execute("SELECT public.delete_chord_edits_for_user(NULL)")
    conn.rollback()


def test_function_is_security_definer_with_pinned_search_path(conn):
    secdef, config = conn.execute(
        "SELECT prosecdef, proconfig FROM pg_proc "
        "WHERE oid = 'public.delete_chord_edits_for_user(uuid)'::regprocedure"
    ).fetchone()
    assert secdef is True
    assert config is not None and "search_path=public, pg_temp" in config


def test_execute_acl_is_stemloops_app_only(conn):
    """No PUBLIC (empty grantee) entry; only owner + stemloops_app."""
    (acl,) = conn.execute(
        "SELECT array_agg(coalesce(r.rolname, 'PUBLIC') ORDER BY 1) FROM pg_proc p, "
        "aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee "
        "WHERE p.oid = 'public.delete_chord_edits_for_user(uuid)'::regprocedure"
    ).fetchone()
    assert "PUBLIC" not in acl
    assert "anon" not in acl and "authenticated" not in acl
    assert "stemloops_app" in acl
