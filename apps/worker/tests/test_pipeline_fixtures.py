"""Fixture pipeline test: the audio core (extract→tag→seamless→encode→upload→DB)
runs end-to-end on synthetic stems against a real Postgres + S3/MinIO.

This is the Gate-2 proxy for the non-gated portion of p90 — it does NOT call
YouTube or Replicate; it feeds pre-separated stems straight into process_stems.
Skips cleanly unless DATABASE_URL + R2/MinIO creds are present.
"""

import os
import sys
import time
import uuid

import psycopg
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "fixtures"))
from make_stem_fixtures import ensure_fixtures  # noqa: E402

from worker import pipeline  # noqa: E402

DB = os.environ.get("DATABASE_URL", "")
R2_READY = bool(
    os.environ.get("R2_ACCESS_KEY_ID")
    and os.environ.get("R2_SECRET_ACCESS_KEY")
    and os.environ.get("R2_BUCKET_NAME")
    and (os.environ.get("MINIO_ENDPOINT") or os.environ.get("R2_ENDPOINT_URL"))
)
pytestmark = pytest.mark.skipif(not (DB and R2_READY), reason="DATABASE_URL/R2 not configured")


def _ensure_bucket():
    from worker.storage.r2_uploader import _r2

    try:
        _r2().create_bucket(Bucket=os.environ["R2_BUCKET_NAME"])
    except Exception:  # noqa: BLE001 — already-exists is fine
        pass


def test_process_stems_end_to_end():
    _ensure_bucket()
    paths = ensure_fixtures()
    requested = ["drums", "bass", "vocals"]
    job_id = str(uuid.uuid4())
    with psycopg.connect(DB) as c:
        c.execute(
            """INSERT INTO jobs(id,youtube_url,requested_stems,loop_length_bars,status,client_ip_hash)
               VALUES(%s,%s,%s,%s,'extracting','test')""",
            (job_id, "https://www.youtube.com/watch?v=7Jj83FOlBF8", requested, 4),
        )
        c.commit()

    t0 = time.monotonic()
    count = pipeline.process_stems(job_id, paths, requested, 4)
    elapsed = time.monotonic() - t0

    with psycopg.connect(DB) as c:
        rows = c.execute(
            "SELECT stem, COUNT(*) FROM loops WHERE job_id=%s GROUP BY stem", (job_id,)
        ).fetchall()
        job_tags = c.execute("SELECT bpm, musical_key FROM jobs WHERE id=%s", (job_id,)).fetchone()
        sample = c.execute(
            "SELECT r2_key, filename, section_label, energy_class, bpm, musical_key FROM loops WHERE job_id=%s LIMIT 1",
            (job_id,),
        ).fetchone()
    by_stem = {r[0]: r[1] for r in rows}

    print(f"\nAUDIO-CORE: {count} loops in {elapsed:.2f}s  per-stem={by_stem}")
    print(f"job bpm/key={job_tags}  sample={sample}")

    assert count > 0, "no loops produced"
    assert by_stem, "no loops persisted"
    for stem, c2 in by_stem.items():
        assert c2 >= 5, f"{stem}: only {c2} loops"
    assert "piano" not in by_stem, "piano stem leaked (must map to keys)"
    # musical_key is legitimately nullable since C2 (no key below the confidence
    # floor), so only bpm is required; the key must be a real key string or null.
    assert job_tags[0] is not None, "job bpm not written"
    assert job_tags[1] is None or job_tags[1].split()[-1] in ("major", "minor"), job_tags[1]
    assert sample[0].startswith(f"{job_id}/"), "r2_key not deterministic"
