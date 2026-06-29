"""Idempotent SQL migration runner.

Applies every `apps/worker/migrations/*.sql` exactly once, tracked in a
`_migrations` table. Safe to run repeatedly. Migrations dir is resolved relative
to this file so it works from any working directory.
"""

import glob
import os

import psycopg

# apps/worker/src/worker/migrate.py -> apps/worker/migrations
MIGRATIONS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "migrations"))


def run() -> None:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS _migrations (
                filename   text PRIMARY KEY,
                applied_at timestamptz DEFAULT now()
            )
            """)
        conn.commit()
        for path in sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql"))):
            fname = os.path.basename(path)
            already = conn.execute(
                "SELECT 1 FROM _migrations WHERE filename=%s", (fname,)
            ).fetchone()
            if already:
                print(f"  skip  {fname} (already applied)")
                continue
            with open(path) as f:
                conn.execute(f.read())
            conn.execute("INSERT INTO _migrations(filename) VALUES(%s)", (fname,))
            conn.commit()
            print(f"  apply {fname}")
    print("Migrations complete.")


if __name__ == "__main__":
    run()
