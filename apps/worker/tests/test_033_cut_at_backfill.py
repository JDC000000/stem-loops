"""Migration 033 — `loops.cut_at` must not lie about the rows that predate it.

033 adds `cut_at` to a table the eager pipeline has been filling for months.
Every row already there IS cut: `_one` uploaded the WAV to R2 *before* it
INSERTed the row, so the row's existence is the proof. A bare `ADD COLUMN`
leaves all of them NULL, which 033 itself defines as "described, not cut", and
two pieces of shipped behaviour read that:

  * `apps/web/src/app/api/jobs/[id]/route.ts` returns `signed_url: null` for an
    uncut row — so every download link for every job inside its 24h window dies
    the moment the migration lands; and
  * `down/033`'s FIRST statement is `DELETE FROM public.loops WHERE cut_at IS
    NULL` — so a rollback deletes the entire table, and with it the play-along
    player's section regions, which `lib/play/sections.ts` derives from exactly
    these rows.

So the gates below are the cutover rehearsal, not a schema spot-check:

  1. a row written the way the PRE-033 pipeline wrote it comes out of 033 CUT;
  2. that same row SURVIVES `down/033`;
  3. and a genuinely uncut row — one 033's own on-demand flow created — is
     still deleted by `down/033`. Without (3), (2) could be satisfied by a
     backfill that simply disarmed the down migration, which would be a
     different defect wearing this test as a disguise.

HOW THE PRE-033 STATE IS REACHED. `down/033` is applied first, inside a
transaction that is always rolled back. That is the real pre-033 schema built
by the real file, rather than a hand-written imitation of it, and each test
asserts the column is actually gone before seeding — a test that silently kept
running against a post-033 schema would pass while proving nothing.

Everything happens in ONE transaction per test and is rolled back, so the
session database is left exactly as it was found. Skipped without
DATABASE_URL, refused outright against a non-local host: these tests run a
DELETE-bearing down migration, which has no business pointing at production.
"""

from __future__ import annotations

import contextlib
import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(
        reason="033 backfill tests apply down/033, which DELETEs from loops; "
        "local throwaway DB only"
    )

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
UP_033 = MIGRATIONS / "033_v3_loop_requests.sql"
DOWN_033 = MIGRATIONS / "down" / "033_v3_loop_requests_down.sql"

# Every statement is bounded. A missing backfill must make these tests go RED,
# not hang: an UPDATE over `loops` that blocked on another session's lock would
# otherwise turn a real failure into a timed-out job, which reads as
# infrastructure rather than as the defect it is. 30 s is ~1000x what the whole
# migration pair takes on a throwaway database.
STATEMENT_TIMEOUT_MS = 30_000


@contextlib.contextmanager
def _session() -> Iterator[Any]:
    """One connection, one transaction, ALWAYS rolled back.

    Deliberately not `with psycopg.connect(...)`: that context manager COMMITS
    on a clean exit, which would leave a dropped `cut_at` column or a truncated
    `loops` table behind in the session database for every test that follows.
    """
    conn = psycopg.connect(DB)  # type: ignore[arg-type]
    try:
        conn.execute(f"SET statement_timeout = {STATEMENT_TIMEOUT_MS}")
        conn.execute(f"SET lock_timeout = {STATEMENT_TIMEOUT_MS}")
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _has_cut_at(conn: Any) -> bool:
    row = conn.execute("""SELECT count(*) FROM pg_attribute
            WHERE attrelid = 'public.loops'::regclass
              AND attname = 'cut_at' AND attnum > 0 AND NOT attisdropped""").fetchone()
    assert row is not None
    return bool(row[0])


def _to_pre_033(conn: Any) -> None:
    """Rewind to the schema 033 is about to be applied to, using the real file."""
    conn.execute(DOWN_033.read_text())
    assert not _has_cut_at(conn), (
        "down/033 did not remove loops.cut_at — this test would otherwise run "
        "against a post-033 schema and prove nothing"
    )


def _apply_033(conn: Any) -> None:
    conn.execute(UP_033.read_text())
    assert _has_cut_at(conn), "033 did not add loops.cut_at"


def _seed_eager_job(conn: Any, loops: int = 3) -> tuple[str, list[str]]:
    """A job and its loop rows, written the way the PRE-033 pipeline wrote them.

    No `cut_at` is supplied — at this point the column does not exist, which is
    the whole point: these are rows that predate the migration, with their WAVs
    already in R2 under the pre-033 key scheme.
    """
    job_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars,
                            status, client_ip_hash, client_fingerprint)
           VALUES(%s,%s,%s,%s,'done','test','test')""",
        (job_id, f"https://www.youtube.com/watch?v={uuid.uuid4().hex[:11]}", ["drums"], 4),
    )
    ids: list[str] = []
    for idx, section in enumerate(("intro", "verse", "chorus")[:loops]):
        loop_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO loops(id, job_id, stem, section_label, energy_class,
                                 start_sec, end_sec, start_bar, bar_count,
                                 r2_key, filename)
               VALUES(%s,%s,'drums',%s,'mid',%s,%s,%s,4,%s,%s)""",
            (
                loop_id,
                job_id,
                section,
                idx * 8,
                idx * 8 + 8,
                idx * 4,
                # The pre-033 key scheme, bar count absent.
                f"{job_id}/drums/{section}_{idx:04d}.wav",
                f"drums_{section}_{idx:04d}.wav",
            ),
        )
        ids.append(loop_id)
    return job_id, ids


def _count(conn: Any, job_id: str) -> int:
    row = conn.execute("SELECT count(*) FROM loops WHERE job_id = %s", (job_id,)).fetchone()
    assert row is not None
    return int(row[0])


# ───────────────────────── gate 1: the backfill runs ─────────────────────────


def test_033_marks_every_pre_existing_loop_row_as_cut():
    """...→032, seed the rows the eager pass wrote, apply 033: nothing is uncut.

    Without the backfill this is `uncut == 3` and the API stops minting signed
    URLs for all three.
    """
    with _session() as conn:
        _to_pre_033(conn)
        job_id, ids = _seed_eager_job(conn)

        _apply_033(conn)

        rows = conn.execute(
            "SELECT id, cut_at, created_at FROM loops WHERE job_id = %s ORDER BY start_sec",
            (job_id,),
        ).fetchall()
        assert len(rows) == 3, "the seeded rows must still be there"
        for loop_id, cut_at, created_at in rows:
            assert cut_at is not None, (
                f"loop {loop_id} came out of 033 uncut — its WAV is in R2 but "
                "GET /api/jobs/:id will now withhold the download URL"
            )
            # Not merely non-null: the value is the row's own INSERT time, which
            # the eager pass took moments after the upload it followed.
            assert cut_at == created_at, (cut_at, created_at)

        uncut = conn.execute(
            "SELECT count(*) FROM loops WHERE job_id = %s AND cut_at IS NULL", (job_id,)
        ).fetchone()
        assert uncut is not None and uncut[0] == 0, f"uncut rows after 033: {uncut[0]}"


def test_033_backfill_covers_the_whole_table_not_just_one_job():
    """`created_at` is NOT NULL, so the predicate cannot leave a row behind.

    Asserted against the live schema rather than read off 003_loops.sql: if a
    future migration made `created_at` nullable, `cut_at = created_at` would
    silently leave those rows uncut and the one-line backfill would need a
    COALESCE. This is where that shows up.
    """
    with _session() as conn:
        notnull = conn.execute("""SELECT attnotnull FROM pg_attribute
                WHERE attrelid = 'public.loops'::regclass AND attname = 'created_at'""").fetchone()
        assert notnull is not None and notnull[0] is True, (
            "loops.created_at is nullable — 033's `cut_at = created_at` backfill "
            "would leave NULL-created_at rows uncut and needs a COALESCE"
        )

        _to_pre_033(conn)
        _seed_eager_job(conn)
        _seed_eager_job(conn)
        _apply_033(conn)

        total_uncut = conn.execute("SELECT count(*) FROM loops WHERE cut_at IS NULL").fetchone()
        assert (
            total_uncut is not None and total_uncut[0] == 0
        ), f"{total_uncut[0]} row(s) in the whole table are still uncut after 033"


# ──────────────────── gate 2: the row survives coming back down ────────────────────


def test_a_pre_033_loop_row_survives_down_033():
    """down/033 opens with `DELETE FROM loops WHERE cut_at IS NULL`.

    With the backfill, a row that predates 033 is cut, so the DELETE does not
    match it and the rollback is non-destructive. Without the backfill this is
    `rows AFTER down: 0` — every loop row in the database, and with them every
    section region the play-along player draws.
    """
    with _session() as conn:
        _to_pre_033(conn)
        job_id, _ = _seed_eager_job(conn)
        before = _count(conn, job_id)
        assert before == 3

        _apply_033(conn)
        conn.execute(DOWN_033.read_text())

        # The column is gone again, so the row really did survive the DELETE
        # rather than the DELETE having been skipped.
        assert not _has_cut_at(conn), "down/033 left cut_at in place"
        after = _count(conn, job_id)
        assert after == before, (
            f"rows BEFORE {before} -> rows AFTER down {after}: a rollback of 033 "
            "deleted loop rows whose WAVs are in R2, wiping the play-along "
            "player's section regions"
        )


def test_down_033_still_deletes_a_genuinely_uncut_row():
    """The complement — and the reason gate 2 cannot be satisfied by cheating.

    A row the ON-DEMAND flow created and never cut has an `r2_key` naming an
    object that does not exist. `cut_at` is the only column that says so, so it
    MUST NOT outlive the column. If a backfill ever marked these cut too, gate 2
    would stay green over a down migration that left 404s behind.
    """
    with _session() as conn:
        _to_pre_033(conn)
        job_id, _ = _seed_eager_job(conn)
        _apply_033(conn)

        # Post-033: the eager pass describes a loop and cuts nothing.
        uncut_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO loops(id, job_id, stem, section_label, energy_class,
                                 start_sec, end_sec, start_bar, bar_count,
                                 r2_key, filename, cut_at)
               VALUES(%s,%s,'bass','verse','mid',0,8,0,4,%s,'bass.wav',NULL)""",
            (uncut_id, job_id, f"{job_id}/bass/4bar_verse_0000.wav"),
        )
        assert _count(conn, job_id) == 4

        conn.execute(DOWN_033.read_text())

        survivors = conn.execute(
            "SELECT id::text FROM loops WHERE job_id = %s", (job_id,)
        ).fetchall()
        got = {r[0] for r in survivors}
        assert uncut_id not in got, (
            "down/033 kept an uncut row after dropping cut_at — its r2_key now "
            "points at an object that was never written and nothing says so"
        )
        assert len(got) == 3, f"the three cut rows must survive; got {len(got)}"
