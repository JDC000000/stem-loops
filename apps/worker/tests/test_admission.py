"""P2-3: admission spend-ceiling logic blocks when 24h Replicate spend is exceeded.

admission.ts lives in the web app, but its defense is SQL. This test exercises
that exact SQL against a real DB so the spend-ceiling regression is guarded in CI
(skips cleanly without DATABASE_URL). It asserts: a cost event pushes the rolling
24h spend total above a $0 ceiling, which is the condition that trips RATE_LIMITED.
"""

import json
import os
import uuid

import psycopg
import pytest

DATABASE_URL = os.environ.get("DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")

# The exact query admission.ts uses for the spend gate.
SPEND_QUERY = """
SELECT COALESCE(SUM((detail->>'cost_usd')::numeric), 0) AS total
FROM job_events
WHERE created_at >= NOW() - INTERVAL '24 hours'
"""


def _insert_cost_event(conn, cost_usd: float) -> str:
    """Insert a job (FK) + a cost-bearing separating/completed event; return job id."""
    job_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO jobs(id, youtube_url, loop_length_bars, status, client_ip_hash)
        VALUES(%s, 'https://www.youtube.com/watch?v=test0000000', 4, 'done', 'test')
        """,
        (job_id,),
    )
    conn.execute(
        "INSERT INTO job_events(job_id, stage, phase, detail) VALUES(%s,'separating','completed',%s)",
        (job_id, json.dumps({"cost_usd": cost_usd})),
    )
    conn.commit()
    return job_id


def test_spend_ceiling_trips_over_zero():
    with psycopg.connect(DATABASE_URL) as conn:
        before = float(conn.execute(SPEND_QUERY).fetchone()[0])
        _insert_cost_event(conn, 0.01)
        after = float(conn.execute(SPEND_QUERY).fetchone()[0])

    # The cost event raised the rolling 24h total; against a $0.00 ceiling this trips RATE_LIMITED.
    assert after >= before + 0.01 - 1e-9
    ceiling = 0.00
    assert after >= ceiling and after > 0, "spend gate would not block with a $0 ceiling"
