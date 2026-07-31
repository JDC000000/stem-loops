# AGENTS.md — Canonical Context File

> This is the SINGLE CANONICAL context file for the stem-loops repository.
> All agents (Claude Code, Cursor, Copilot, CI bots) must read this file first.
> CLAUDE.md is a thin pointer to this file only.

## Project Overview

**stem-loops** is a web app that takes a YouTube URL, separates the audio into stems (vocals/drums/bass/other) using AI (Replicate + demucs), extracts musical loops, and serves them for download.

## External Documents (on CRHQ platform)

- **PRD**: `documents/requirements/stem-loops/requirements.md`
  - Contains §10 Handoff Rules for Claude Code
  - Full product requirements, user stories, acceptance criteria
- **TSD**: `documents/requirements/stem-loops/technical-scope.md`
  - Contains §6 Data model (jobs/job_events/loops tables)
  - Contains §6.2 Error codes
  - Contains §6.3 State machine
  - Contains §8 Anti-goals (V1 mistakes to NOT repeat)
  - Contains §9 Build order
  - Contains FLAG 1 resolution (this file is the canonical context)

## FLAG 1 Resolution (TSD reference)

The TSD flags a potential ambiguity about which file is the canonical context for Claude Code.
**Resolution: AGENTS.md (this file) is the single source of truth.**
- CLAUDE.md points here and contains nothing else
- If any context file conflicts with AGENTS.md, AGENTS.md wins

## Architecture

```
apps/web/          Next.js 14 App Router → Vercel Hobby
apps/worker/       Python FastAPI + pipeline → Fly.io / Render
packages/types/    Pydantic → JSON Schema → TypeScript (codegen)
fixtures/          CI fixtures (cached audio, golden loops) — committed to git
evals/bugs.json    Regression tracking — pre-allocated per TSD §9
```

## State Machine (TSD §6.3)

```
jobs.status:  queued → downloading → separating → extracting → uploading → done
                                                                          → failed
```

Active stages emit events (job_events table):
- Each active stage (downloading/separating/extracting/uploading) emits: `started`, then `completed` OR `failed`

## Error Codes (TSD §6.2)

| Code | When |
|------|------|
| DOWNLOAD_BLOCKED | yt-dlp blocked/unavailable |
| DOWNLOAD_TIMEOUT | yt-dlp timed out |
| DOWNLOAD_INVALID_URL | Not a valid YouTube URL |
| DOWNLOAD_AGE_RESTRICTED | Video age-restricted |
| DOWNLOAD_PRIVATE | Video is private |
| SEPARATION_FAILED | Replicate/demucs error |
| EXTRACTION_FAILED | Loop extraction error |
| UPLOAD_FAILED | R2/MinIO upload error |
| UPLOAD_INVALID | Uploaded file is not a decodable audio/video container |
| UPLOAD_TOO_LARGE | Uploaded file exceeds the max upload size |
| INTERNAL_ERROR | Unexpected error |
| RATE_LIMITED | Rate limit exceeded |

Any code added here must exist in ALL FOUR places or the user sees generic copy:
`errors.py` (raise site) → `models.py::ERROR_CODES` (contract) → `make types-generate`
→ `apps/web/src/lib/error-copy.ts` (user-facing copy) → this table.

## §9 Build Order

1. **Foundation** — DB schema, migrations, worker health, types codegen, CI green
2. **Audio Pipeline** — Download (yt-dlp), Separate (Replicate demucs), Extract loops, Upload to R2
3. **UX Polish** — Web UI, job status polling, loop playback, download
4. **Production/Ship** — Rate limiting, IP hashing, expiry cleanup, deploy pipeline

## §8 Anti-Goals (V1 mistakes — DO NOT repeat)

- Do NOT expose secrets to the browser. All API tokens are server-side only.
- Do NOT call Replicate from the web layer. Only the worker calls Replicate.
- Do NOT store audio files in the database. Use R2/MinIO only.
- Do NOT block the event loop in the FastAPI worker. Use thread pool for pipeline.
- Do NOT skip the migration runner. Always run `make migrate` before `make dev`.
- Do NOT hard-code URLs or bucket names. Always use environment variables.
- Do NOT commit `.env`. Only `.env.example` is committed.
- Do NOT add audio files (*.wav, *.mp3, *.flac) outside of `fixtures/`.
- Do NOT generate TypeScript types by hand. Always run `make types-generate`.

## Secret Convention

**All secrets are server-side only. Never in the browser. Never requested from users.**

| Variable | Where used | How to get |
|----------|-----------|------------|
| REPLICATE_API_TOKEN | worker only | replicate.com/account |
| R2_ACCESS_KEY_ID | worker only | Cloudflare R2 dashboard |
| R2_SECRET_ACCESS_KEY | worker only | Cloudflare R2 dashboard |
| R2_ENDPOINT | worker only | Cloudflare R2 dashboard |
| R2_BUCKET_NAME | worker only | Create in R2 dashboard |
| DATABASE_URL | worker + web (server) | Supabase dashboard |
| DATABASE_POOL_URL | worker + web (server) | Supabase dashboard |
| BETTERSTACK_SOURCE_TOKEN | worker + web | betterstack.com |
| IP_HASH_KEY | worker + web (server) | `openssl rand -hex 32` |
| HISTORY_COOKIE_KEY | web (server) | `openssl rand -hex 32` |

See `.env.example` for the full list with documentation.

## Make Targets

| Target | What it does |
|--------|-------------|
| `make dev` | Spin up web + worker + Postgres + MinIO via docker-compose, run stub job end-to-end |
| `make test-job URL=...` | Run worker on one URL with verbose logging, no queue |
| `make types` | Run Pydantic → JSON Schema → TS codegen AND check for drift |
| `make types-generate` | Run codegen only (no drift check) |
| `make test` | Run pytest + pnpm test |
| `make lint` | Run ruff + black check + eslint |
| `make deploy-web` | Deploy to Vercel |
| `make deploy-worker` | Deploy to Fly.io |
| `make migrate` | Run database migrations (idempotent) |
| `make install` | pnpm install + pip install -r requirements.txt |

## Type Source of Truth

`apps/worker/src/models.py` — Pydantic models — is the SINGLE SOURCE OF TRUTH for all types.

- Any schema change → edit models.py → run `make types-generate` → commit both
- CI (types-drift job) will fail if generated types are out of sync with models.py
- TypeScript consumers import from `@stem-loops/types` (packages/types)

## PRD §10 Handoff Rules for Claude Code

1. Always read AGENTS.md first. It supersedes all other context.
2. Run `make install` before starting any work session.
3. Run `make dev` to verify the full stack is working before making changes.
4. Run `make lint` and `make test` before committing.
5. Never edit `packages/types/src/generated.ts` by hand — run `make types-generate`.
6. Follow the §9 build order — do not skip ahead to UX before the pipeline works.
7. When adding a new model field, update models.py and run `make types-generate`.
8. All new secrets go in `.env.example` with a comment explaining how to obtain them.
9. Regression bugs go in `evals/bugs.json`.
10. The state machine (§6.3) is fixed — do not add or rename statuses.
