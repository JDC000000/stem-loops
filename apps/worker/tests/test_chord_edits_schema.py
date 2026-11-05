"""Migration 025 (chord_edits) regression tests — PR-Y1.7 chord-edit flywheel.

Covers: all three CHECK constraints reject bad shapes, the training-data index
exists, the append-only REVOKE on stemloops_app holds, and the down-migration
round trip works. Mirrors test_credit_adjustments_schema.py (023).

Requires a real local Postgres with migrations applied through 025; skipped
without DATABASE_URL, refused on non-local hosts (INSERTs into auth.users).
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(
        reason="025 tests INSERT into auth.users; local throwaway DB only"
    )

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
EMAIL_LIKE = "test-chord-edits-%@example.com"
ALPHABET_SHA = "a" * 64  # stand-in sha256; shape not enforced by the schema.


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _cleanup(c)
        yield c
        _cleanup(c)


def _cleanup(c: Any) -> None:
    c.rollback()
    # chord_edits does NOT cascade from public.users (Phase 4 sweep is the
    # intended removal path); remove rows directly before the user is gone.
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


def _user(conn: Any, tag: str) -> uuid.UUID:
    uid = uuid.uuid4()
    conn.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-chord-edits-{tag}@example.com"),
    )
    conn.commit()
    return uid


def _job(conn: Any, uid: uuid.UUID) -> uuid.UUID:
    jid = uuid.uuid4()
    conn.execute(
        "INSERT INTO public.jobs (id, youtube_url, status, client_ip_hash, "
        "client_fingerprint, user_id) "
        "VALUES (%s, 'https://example.test/x', 'done', 'h', '', %s)",
        (jid, uid),
    )
    conn.commit()
    return jid


def _insert(
    conn: Any,
    uid: uuid.UUID,
    jid: uuid.UUID,
    *,
    start: float = 0.0,
    end: float = 2.0,
    original: str = "C",
    corrected: str = "C:min",
    alphabet_sha: str = ALPHABET_SHA,
) -> None:
    conn.execute(
        "INSERT INTO public.chord_edits (user_id, job_id, track_hash, provider, "
        "provider_version, start_sec, end_sec, original_label, corrected_label, "
        "alphabet_sha) VALUES (%s,%s,'th','klangio','k-1.0',%s,%s,%s,%s,%s)",
        (uid, jid, start, end, original, corrected, alphabet_sha),
    )


def test_happy_path_insert(conn):
    uid = _user(conn, "happy")
    jid = _job(conn, uid)
    _insert(conn, uid, jid)
    conn.commit()
    row = conn.execute(
        "SELECT corrected_label FROM public.chord_edits WHERE user_id = %s", (uid,)
    ).fetchone()
    assert row is not None and row[0] == "C:min"


def test_reverse_time_range_rejected(conn):
    uid = _user(conn, "revtime")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, uid, jid, start=2.0, end=1.0)
    conn.rollback()


def test_zero_width_time_range_rejected(conn):
    uid = _user(conn, "zerowidth")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, uid, jid, start=1.0, end=1.0)
    conn.rollback()


def test_same_label_rejected(conn):
    uid = _user(conn, "same")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, uid, jid, original="C", corrected="C")
    conn.rollback()


def test_invalid_harte_rejected(conn):
    """Non-Harte labels fail the regex CHECK (e.g. slash chords, lowercase, Unicode flats)."""
    uid = _user(conn, "harte")
    jid = _job(conn, uid)
    for bad in ["H", "c", "A♭", "C/G", "Cmaj7", "C:MIN", "", " C", "C:"]:
        with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_valid_harte"):
            _insert(conn, uid, jid, corrected=bad)
        conn.rollback()


def test_valid_harte_labels_accepted(conn):
    """Representative Harte labels pass the regex — N, X, pitches, accidentals, qualities."""
    uid = _user(conn, "hartegood")
    jid = _job(conn, uid)
    for good in ["N", "X", "A", "G#", "Bb", "C:maj", "F#:min7", "D:sus4", "G:7"]:
        # Pick an original that differs so chord_edits_labels_differ is OK.
        _insert(conn, uid, jid, original="C", corrected=good)
    conn.commit()
    (count,) = conn.execute(
        "SELECT COUNT(*) FROM public.chord_edits WHERE user_id = %s", (uid,)
    ).fetchone()
    assert count == 9


def test_multiple_edits_same_frame_allowed(conn):
    """No UNIQUE on (job_id, start_sec, end_sec) — a user can refine a correction."""
    uid = _user(conn, "refine")
    jid = _job(conn, uid)
    _insert(conn, uid, jid, start=0.0, end=2.0, corrected="A:min")
    _insert(conn, uid, jid, start=0.0, end=2.0, corrected="A:min7")
    conn.commit()
    (count,) = conn.execute(
        "SELECT COUNT(*) FROM public.chord_edits WHERE job_id = %s", (jid,)
    ).fetchone()
    assert count == 2


def test_training_index_exists(conn):
    idx = {
        r[0]
        for r in conn.execute(
            "SELECT indexname FROM pg_indexes WHERE tablename='chord_edits'"
        ).fetchall()
    }
    assert "chord_edits_training_idx" in idx
    assert "chord_edits_user_idx" in idx


def test_stemloops_app_is_append_only(conn):
    """stemloops_app may SELECT/INSERT but holds no UPDATE/DELETE privilege."""
    rows = conn.execute(
        "SELECT privilege_type FROM information_schema.role_table_grants "
        "WHERE table_schema='public' AND table_name='chord_edits' "
        "AND grantee='stemloops_app'"
    ).fetchall()
    privs = {r[0] for r in rows}
    assert {"SELECT", "INSERT"} <= privs
    assert "UPDATE" not in privs
    assert "DELETE" not in privs


def test_rls_enabled(conn):
    (relrowsecurity,) = conn.execute(
        "SELECT relrowsecurity FROM pg_class WHERE relname='chord_edits'"
    ).fetchone()
    assert relrowsecurity is True


def test_down_migration_round_trip(conn):
    """Down drops the table; re-applying 025 restores it."""
    down = (MIGRATIONS / "down" / "025_v3_chord_edits_down.sql").read_text()
    up = (MIGRATIONS / "025_v3_chord_edits.sql").read_text()
    try:
        conn.execute(down)
        conn.commit()
        exists = conn.execute("SELECT to_regclass('public.chord_edits')").fetchone()
        assert exists is not None and exists[0] is None
    finally:
        conn.rollback()
        conn.execute(up)
        conn.commit()
    exists = conn.execute("SELECT to_regclass('public.chord_edits')").fetchone()
    assert exists is not None and exists[0] is not None
    # Re-check an invariant after the round trip — the Harte regex is still live.
    uid = _user(conn, "rt")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, uid, jid, corrected="not_a_chord")
    conn.rollback()
