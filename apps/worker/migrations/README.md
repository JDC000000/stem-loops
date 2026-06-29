# Migrations

Plain SQL migration files, run by `make migrate` (calls `python -m worker.migrations.run`).

## Conventions

- Files are named `NNN_description.sql` (e.g. `001_jobs.sql`)
- The runner tracks applied migrations in a `_migrations` table
- Migrations are **idempotent** — running `make migrate` twice is safe
- All schema changes go through migrations — never alter schema directly in Supabase UI

## State Machine (canonical — TSD §6.3)

`jobs.status` lifecycle: `queued → downloading → separating → extracting → uploading → done`
Terminal failure: `failed` (from any active stage)

`job_events.(stage, phase)` trace: each active stage emits `started`, then `completed` or `failed`.

## Running

```bash
make migrate              # Apply all pending migrations
DATABASE_URL=... make migrate  # Override database URL
```
