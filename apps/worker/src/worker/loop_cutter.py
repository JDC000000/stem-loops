"""On-demand loop cutting: the second claim loop (migration 033).

Jon, 2026-11-11: "only do the processing work to create loops when the user asks
for the loops to be created." `pipeline.record_loops` now describes every loop
without cutting it; this module is what cuts them when someone asks.

WHY A SECOND CLAIM LOOP AND NOT A SECOND `jobs.status`
-----------------------------------------------------
`jobs.status` is CHECK (status IN ('queued','downloading','separating',
'extracting','uploading','done','failed')) — 001_jobs.sql — and `consumer.py`
claims fresh work with `WHERE status='queued'`. Putting "cutting loops" on that
column would mean a loop request got claimed as a separation. So requests live in
their own table and are claimed the same way: `SELECT … FOR UPDATE SKIP LOCKED`,
exactly the shape `consumer.claim_and_run` uses on `jobs`. No broker, per
consumer.py's header: "No Redis, no sidecar."

THE TWO CONCURRENCY GUARANTEES, AND WHICH MECHANISM PROVIDES EACH
-----------------------------------------------------------------
  1. Two workers never cut the same request. `FOR UPDATE SKIP LOCKED` inside the
     claiming UPDATE: the loser's subquery skips the row the winner has locked
     and returns no row, so the loser claims nothing rather than blocking.
  2. One job never has two live requests. `loop_requests_live_idx`, a UNIQUE
     index on (job_id) WHERE status IN ('queued','running'). This is a WRITE-side
     guarantee and belongs to the API route, not here: two simultaneous POSTs
     cannot both insert, and the loser gets 23505.
Both are pinned by tests/test_loop_cutter.py, under real contention, against a
real Postgres.

WHERE THE AUDIO COMES FROM
--------------------------
The full-length stem WAVs V3-J2 already retains: `{job_id}/_stems/dl/{stem}.wav`
(r2_uploader.stem_download_r2_key). Those are the same bytes `extract_loops` saw,
so a row cut here is byte-identical to what the eager cut used to produce — the
cut is a pure slice of a stored WAV at the row's own start/end, with no beat grid
re-fit and no re-extraction. If a stem is missing (a retention sweep got there
first, or V3-J2 stem retention was incomplete for that job), the rows for that
stem are skipped and the request still closes `done` with a lower count: a
partial cut is better than a failed one, and the count is reported.
"""

from __future__ import annotations

import asyncio
import os

import psycopg
import sentry_sdk

from . import tmpdirs
from .logger import log_structured
from .pipeline import cut_recorded_loops
from .storage.r2_uploader import download_object, stem_download_r2_key

DATABASE_URL = os.environ.get("DATABASE_URL", "")


async def claim_and_cut() -> bool:
    """Claim one queued loop request and cut it. True if a request was claimed.

    Mirrors consumer.claim_and_run: a single UPDATE … WHERE id = (SELECT …
    FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING, committed before any slow work
    starts, so the row is marked 'running' and out of every other worker's reach
    for the whole of the cut rather than only for the claiming transaction.
    """
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        row = await (await conn.execute("""
                UPDATE loop_requests
                   SET status='running', claimed_at=now(), updated_at=now()
                 WHERE id = (
                     SELECT id FROM loop_requests WHERE status='queued'
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                 )
                RETURNING id, job_id
                """)).fetchone()
        await conn.commit()
    if not row:
        return False

    request_id, job_id = str(row[0]), str(row[1])
    log_structured("INFO", "loop_request_claimed", request_id=request_id, job_id=job_id)
    try:
        # Every scratch dir this creates is removed when the scope ends — the
        # retained stem WAVs are user audio and must not survive the cut.
        with tmpdirs.job_scope():
            cut = await _cut_request(job_id)
    except Exception as exc:  # noqa: BLE001 — isolate the failure, never crash the loop
        log_structured(
            "ERROR",
            "loop_request_failed",
            request_id=request_id,
            job_id=job_id,
            error_type=type(exc).__name__,
            error=str(exc)[:200],
        )
        # Worth reporting: a request that fell through `cut_recorded_loops`'s own
        # per-loop skips is something nobody anticipated.
        sentry_sdk.capture_exception(exc)
        await _close(request_id, "failed", 0, error_code="INTERNAL_ERROR")
        return True

    await _close(request_id, "done", cut)
    log_structured("INFO", "loop_request_done", request_id=request_id, job_id=job_id, loops=cut)
    return True


async def _cut_request(job_id: str) -> int:
    """Download the stems this job's uncut rows need, then cut them."""
    stems = await asyncio.to_thread(_uncut_stems, job_id)
    if not stems:
        return 0
    stem_paths = await asyncio.to_thread(_download_stems, job_id, stems)
    return await asyncio.to_thread(cut_recorded_loops, job_id, stem_paths)


def _uncut_stems(job_id: str) -> list[str]:
    """Which stems still have uncut rows. Only those WAVs need downloading."""
    with psycopg.connect(DATABASE_URL) as c:
        rows = c.execute(
            "SELECT DISTINCT stem FROM loops WHERE job_id=%s AND cut_at IS NULL",
            (job_id,),
        ).fetchall()
    return sorted(r[0] for r in rows)


def _download_stems(job_id: str, stems: list[str]) -> dict[str, str]:
    """Pull `{job_id}/_stems/dl/{stem}.wav` for each stem. Missing ones are omitted.

    A missing stem is not an error here. `cut_recorded_loops` logs and skips the
    rows it cannot serve, so a job whose stems were partly lost still yields the
    loops it can.
    """
    tmpdir = tmpdirs.mkdtemp(prefix="sl_cutstems_")
    paths: dict[str, str] = {}
    for stem in stems:
        local = os.path.join(tmpdir, f"{stem}.wav")
        try:
            download_object(stem_download_r2_key(job_id, stem), local)
            paths[stem] = local
        except Exception as exc:  # noqa: BLE001
            log_structured(
                "WARN",
                "loop_cut_stem_unavailable",
                job_id=job_id,
                stem=stem,
                error_type=type(exc).__name__,
                error=str(exc)[:200],
            )
    return paths


async def _close(
    request_id: str, status: str, loops_cut: int, error_code: str | None = None
) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "UPDATE loop_requests SET status=%s, loops_cut=%s, error_code=%s, updated_at=now() "
            "WHERE id=%s",
            (status, loops_cut, error_code, request_id),
        )
        await conn.commit()
