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
        "client_fingerprint, user_id, loop_length_bars) "
        "VALUES (%s, 'https://example.test/x', 'done', 'h', '', %s, 8)",
        (jid, uid),
    )
    conn.commit()
    return jid


TRACK_HASH = "f" * 64  # 64-hex, satisfies migration 026's length check.


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
    track_hash: str = TRACK_HASH,
    provider_version: str = "k-1.0",
    cqt_plan_version: Any = None,
    original_confidence: Any = None,
) -> None:
    conn.execute(
        "INSERT INTO public.chord_edits (user_id, job_id, track_hash, provider, "
        "provider_version, start_sec, end_sec, original_label, corrected_label, "
        "alphabet_sha, cqt_plan_version, original_confidence) "
        "VALUES (%s,%s,%s,'klangio',%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            uid,
            jid,
            track_hash,
            provider_version,
            start,
            end,
            original,
            corrected,
            alphabet_sha,
            cqt_plan_version,
            original_confidence,
        ),
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


# ────────────────────────────────────────────────────────────────────────
# Migration 027 regression — security audit §3 M1.
# After 027 the anon + authenticated roles must hold NO privileges on
# public.chord_edits, and the pre-M1 "chord_edits_user_insert" /
# "chord_edits_user_read_own" policies must be gone.
# ────────────────────────────────────────────────────────────────────────


def test_m1_anon_has_no_privileges_on_chord_edits(conn):
    rows = conn.execute(
        "SELECT privilege_type FROM information_schema.role_table_grants "
        "WHERE table_schema='public' AND table_name='chord_edits' "
        "AND grantee='anon'"
    ).fetchall()
    assert rows == [], f"anon still holds privileges on chord_edits: {rows!r}"


def test_m1_authenticated_has_no_privileges_on_chord_edits(conn):
    rows = conn.execute(
        "SELECT privilege_type FROM information_schema.role_table_grants "
        "WHERE table_schema='public' AND table_name='chord_edits' "
        "AND grantee='authenticated'"
    ).fetchall()
    assert rows == [], f"authenticated still holds privileges on chord_edits: {rows!r}"


def test_m1_authenticated_insert_policy_removed(conn):
    names = {
        r[0]
        for r in conn.execute(
            "SELECT policyname FROM pg_policies "
            "WHERE schemaname='public' AND tablename='chord_edits'"
        ).fetchall()
    }
    assert "chord_edits_user_insert" not in names
    assert "chord_edits_user_read_own" not in names
    # stemloops_app policies survive — they are the intended writer/reader.
    assert "stemloops_app_insert" in names
    assert "stemloops_app_select" in names


def test_down_migration_round_trip(conn):
    """Down drops the table; re-applying 025 restores it."""
    down = (MIGRATIONS / "down" / "025_v3_chord_edits_down.sql").read_text()
    up = (MIGRATIONS / "025_v3_chord_edits.sql").read_text()
    up_026 = (MIGRATIONS / "026_chord_edits_length_checks.sql").read_text()
    try:
        conn.execute(down)
        conn.commit()
        exists = conn.execute("SELECT to_regclass('public.chord_edits')").fetchone()
        assert exists is not None and exists[0] is None
    finally:
        conn.rollback()
        conn.execute(up)
        # Re-apply 026 too so subsequent 026 tests run against the full
        # constraint set (025's down drops the table + all constraints
        # incl. 026's; the up only restores 025's half).
        conn.execute(up_026)
        conn.commit()
    exists = conn.execute("SELECT to_regclass('public.chord_edits')").fetchone()
    assert exists is not None and exists[0] is not None
    # Re-check an invariant after the round trip — the Harte regex is still live.
    uid = _user(conn, "rt")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, uid, jid, corrected="not_a_chord")
    conn.rollback()


# ---------------------------------------------------------------------------
# Migration 026 — defence-in-depth length / range CHECKs (audit v2 F3).
# ---------------------------------------------------------------------------


def test_026_track_hash_length_rejected(conn):
    uid = _user(conn, "th-len")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_track_hash_len"):
        _insert(conn, uid, jid, track_hash="f" * 63)
    conn.rollback()
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_track_hash_len"):
        _insert(conn, uid, jid, track_hash="f" * 65)
    conn.rollback()


def test_026_alphabet_sha_length_rejected(conn):
    uid = _user(conn, "as-len")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_alphabet_sha_len"):
        _insert(conn, uid, jid, alphabet_sha="a" * 63)
    conn.rollback()


def test_026_provider_version_too_long_rejected(conn):
    uid = _user(conn, "pv-len")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_provider_version_len"):
        _insert(conn, uid, jid, provider_version="x" * 65)
    conn.rollback()


def test_026_cqt_plan_version_too_long_rejected(conn):
    uid = _user(conn, "cqt-len")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_cqt_plan_version_len"):
        _insert(conn, uid, jid, cqt_plan_version="x" * 65)
    conn.rollback()


def test_026_cqt_plan_version_null_allowed(conn):
    """NULL cqt_plan_version is legal — the field is optional."""
    uid = _user(conn, "cqt-null")
    jid = _job(conn, uid)
    _insert(conn, uid, jid, cqt_plan_version=None)
    conn.commit()


def test_026_original_label_too_long_rejected(conn):
    uid = _user(conn, "ol-len")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_original_label_len"):
        _insert(conn, uid, jid, original="x" * 17)
    conn.rollback()


def test_026_corrected_label_too_long_rejected(conn):
    """Length CHECK fires on an over-long Harte-valid label (would otherwise
    pass 025's valid_harte regex).
    """
    uid = _user(conn, "cl-len")
    jid = _job(conn, uid)
    # Harte-valid shape (C:<quality>) with quality = 20 'a's → 22 chars total.
    too_long = "C:" + "a" * 20
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_corrected_label_len"):
        _insert(conn, uid, jid, corrected=too_long)
    conn.rollback()


def test_026_start_sec_negative_rejected(conn):
    uid = _user(conn, "start-neg")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_start_sec_range"):
        _insert(conn, uid, jid, start=-1.0, end=1.0)
    conn.rollback()


def test_026_start_sec_over_cap_rejected(conn):
    uid = _user(conn, "start-cap")
    jid = _job(conn, uid)
    # Both start and end are over cap; either constraint may fire (Postgres
    # checks constraints in an unspecified order and the alphabetically-first
    # end_sec_range often fires first). We just assert that over-cap start
    # is rejected — by some range CHECK.
    with pytest.raises(psycopg.errors.CheckViolation, match=r"chord_edits_(start|end)_sec_range"):
        _insert(conn, uid, jid, start=86401.0, end=86402.0)
    conn.rollback()


def test_026_end_sec_over_cap_rejected(conn):
    uid = _user(conn, "end-cap")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_end_sec_range"):
        _insert(conn, uid, jid, start=0.0, end=86401.0)
    conn.rollback()


def test_026_original_confidence_range_rejected(conn):
    uid = _user(conn, "conf-range")
    jid = _job(conn, uid)
    with pytest.raises(
        psycopg.errors.CheckViolation, match="chord_edits_original_confidence_range"
    ):
        _insert(conn, uid, jid, original_confidence=1.5)
    conn.rollback()
    with pytest.raises(
        psycopg.errors.CheckViolation, match="chord_edits_original_confidence_range"
    ):
        _insert(conn, uid, jid, original_confidence=-0.1)
    conn.rollback()


def test_026_original_confidence_null_allowed(conn):
    uid = _user(conn, "conf-null")
    jid = _job(conn, uid)
    _insert(conn, uid, jid, original_confidence=None)
    conn.commit()


def test_026_down_migration_round_trip(conn):
    """026 down drops only its constraints; 025 CHECKs survive."""
    down = (MIGRATIONS / "down" / "026_chord_edits_length_checks.sql").read_text()
    up = (MIGRATIONS / "026_chord_edits_length_checks.sql").read_text()
    try:
        conn.execute(down)
        conn.commit()
        # After down, a too-long track_hash should INSERT cleanly (025 had no such check).
        uid = _user(conn, "026rt")
        jid = _job(conn, uid)
        _insert(conn, uid, jid, track_hash="f" * 70)
        conn.commit()
    finally:
        # Clean up the row so re-applying the CHECK succeeds (ALTER TABLE
        # ADD CONSTRAINT validates existing rows unless NOT VALID is used).
        conn.rollback()
        conn.execute("DELETE FROM public.chord_edits WHERE length(track_hash) <> 64")
        conn.commit()
        conn.execute(up)
        conn.commit()
    # 025 CHECKs are still live.
    uid = _user(conn, "026rt2")
    jid = _job(conn, uid)
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_valid_harte"):
        _insert(conn, uid, jid, corrected="not_a_chord")
    conn.rollback()
    # 026 CHECK is live again after re-up.
    with pytest.raises(psycopg.errors.CheckViolation, match="chord_edits_track_hash_len"):
        _insert(conn, uid, jid, track_hash="f" * 10)
    conn.rollback()
