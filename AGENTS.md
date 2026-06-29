# stem-loops V2 — Agent Context

## What This Repo Is

**stem-loops V2** — a complete rewrite of stem-loops.com. Takes any YouTube song URL and separates it into individual instrument stems (drums, bass, vocals, guitar, keys, other), then extracts bar-aligned, BPM/key-tagged loops that bedroom producers can audition in-browser and drag into a DAW. Target: under 60 seconds, zero ceremony, no accounts.

## Monorepo Structure

```
stem-loops/
├── apps/web/          — Next.js 14+ App Router (TypeScript) — Vercel Hobby deploy
├── apps/worker/       — Python 3.11+ queue consumer + audio pipeline — Fly.io/Render
├── packages/types/    — Shared contract: Pydantic models (worker) + codegen'd TS (web)
└── docs/              — Architecture, runbook, secret convention
```

**Key principle:** `web` and `worker` NEVER share code directly. All cross-language contracts go through `packages/types`.

## Build Order (LOCKED — do not skip phases)

```
Phase 0 Spikes → Gate 0 (HUMAN) → Phase 1 Foundation → Gate 1 → Phase 2 Audio → Gate 2 → Phase 3 UX → Gate 3 → Phase 4 Ship → Gate 4 (HUMAN)
```

**Gate 0 warning:** NO Phase 1 production code on a spiked path until all 5 spike H-gates pass:
- S1: YouTube download path (Cobalt vs yt-dlp) — ≥95% success on 50 URLs
- S2: pg-boss queue validation — poison job isolation confirmed → **gates T4**
- S3: Phrase-boundary heuristic — ≥5 loops/stem, ≥70% boundary accuracy
- S4: Key-detection library (librosa vs essentia) + keys→piano validation
- S5: Loop seamlessness algorithm — unit tests pass on golden loop

## PRD §8 Anti-Goals Checklist (score every task against this BEFORE writing code)

1. ❌ Never ask users to paste cookies, secrets, or env vars → YouTube auth is infra-managed server-side
2. ❌ Never surface raw stderr or stack traces in user-facing errors → typed error taxonomy only
3. ❌ No CPU Demucs (2-3 min) → Replicate GPU only (≤30s separation)
4. ❌ No 24-hour signed URLs → 7-day persistent jobs, re-mint signed URLs on every GET /api/jobs/:id read
5. ❌ No single-worker SPOF → stateless worker, horizontally scalable, durable Postgres queue
6. ❌ No silent failures → every error path has a typed error code + user-actionable message
7. ❌ No Redis / unqueryable state → Postgres with proper schema (jobs, job_events, loops)
8. ❌ No deployed-env-only testing → `make dev` + `make test-job` work on fresh checkout

## PRD §6.1 Security Non-Negotiables

- **Never** ask the user for secrets, cookies, or env vars — ever
- **No stack traces or server state** in any user-facing response (including unhandled exceptions via Next.js error boundaries)
- **No raw IPs** — store only keyed HMAC-SHA256 (`IP_HASH_KEY`)
- **No browser secrets** — no `NEXT_PUBLIC_` prefix on any secret var
- **Typed error taxonomy** — errors rendered from a static code→copy map, never interpolated from server state
- **Secret redaction** in all logs before writing to `job_events.detail` or Better Stack drain

## Module Boundaries

| Module | Location | Responsibility |
|---|---|---|
| `web-ui` | `apps/web/src/app/` + `src/components/` | Submit, progress, results, history, error states |
| `api-routes` | `apps/web/src/app/api/` | POST /api/jobs (admission + enqueue), GET /api/jobs/:id (status + re-mint URLs) |
| `worker-core` | `apps/worker/src/worker/` | Queue consumer, job state machine, /health |
| `audio-pipeline` | `apps/worker/src/worker/` | download → separate → extract → tag → encode → upload |
| `types-contract` | `packages/types/` | Pydantic models → JSON Schema → TS codegen (single source of truth) |
| `infra` | `apps/worker/migrations/`, `docker-compose.dev.yml`, `.github/workflows/` | Migrations, local dev, CI |

**No cross-module coupling except via `types-contract`.** The `audio-pipeline` is a pure function: `(job_id, youtube_url, stems, options) → loops[] on R2`. The `api-routes` module never calls `audio-pipeline` directly — always via pg-boss queue.

## Make Targets Reference

```bash
make dev          # Start full local stack: web + worker + Postgres + MinIO (R2 emulator)
make test-job URL=<youtube-url>  # Run one job directly (no queue, verbose trace)
make migrate      # Run SQL migrations idempotently
make codegen      # Regenerate TS types from Pydantic models (run after Pydantic changes)
make lint         # Lint web (eslint + tsc) and worker (ruff + black)
```

**Rule:** `make dev` must work on a fresh git clone. If it doesn't, it's a bug.

## Key Reference Documents

- **PRD** (requirements): `documents/requirements/stem-loops/requirements.md` (on satellite)
- **TSD** (technical scope): `documents/requirements/stem-loops/technical-scope.md` (on satellite)
- **Task plan** (101 subtasks): `documents/requirements/stem-loops/tasks.md` (on satellite)
- **Visual Blueprint**: `apps/web/public/designs/` (vendored from satellite pipeline Step 3)
- **Secret convention**: `docs/secret-convention.md`
- **Agent registry**: `docs/agent-registry.md`

## Visual Blueprint

Visual Blueprint is at `apps/web/public/designs/`. QA loops the built product against these designs until pixel-perfect.

**Accent A (Neon Lime #a3e635) is locked — do not change.**

Mobile is operator-explicit first-class: all 5 screens must work at 375px (touch targets ≥44px, sticky CTAs, no horizontal scroll).

Design token CSS var: `--color-accent-a: #a3e635` defined in `apps/web/public/designs/design-tokens.css` — import in `apps/web/src/app/globals.css`.

## Stack Summary

- **Frontend**: Next.js 14+, TypeScript, Tailwind, wavesurfer.js, JSZip
- **Worker**: Python 3.11+, FastAPI (/health), psycopg3, librosa, soundfile, boto3
- **Queue**: pg-boss (Postgres-native — one less service)
- **Database**: Postgres on Supabase (free tier) — jobs, job_events, loops tables
- **Storage**: Cloudflare R2 (S3-compatible) — 24-bit WAVs, signed URLs
- **Separation**: Replicate htdemucs_6s (GPU, ~$0.01–0.03/job)
- **Local dev**: MinIO (R2 emulator), Docker Compose

## Typed Error Taxonomy (canonical — never deviate)

| error_code | Trigger |
|---|---|
| `DOWNLOAD_BLOCKED` | YouTube bot challenge |
| `DOWNLOAD_TIMEOUT` | Network/proxy timeout |
| `DOWNLOAD_INVALID_URL` | Not a valid YouTube URL |
| `DOWNLOAD_AGE_RESTRICTED` | Sign-in required |
| `DOWNLOAD_PRIVATE` | Video is private |
| `SEPARATION_FAILED` | Replicate error |
| `EXTRACTION_FAILED` | Too short / no beats |
| `UPLOAD_FAILED` | R2 issue |
| `INTERNAL_ERROR` | Catch-all (logged, never detailed) |
| `RATE_LIMITED` | Over IP/fingerprint window or global spend cap |

## Phase Gates

| Gate | Who | Condition |
|---|---|---|
| Gate 0 | **HUMAN** | All 5 spike decisions documented + operator sign-off |
| Gate 1 | code-review-agent | Stub job via UI completes with fake loops; `make dev` works fresh |
| Gate 2 | code-review-agent | Real YouTube→loops <60s p90; spend backstop live; typed errors |
| Gate 3 | code-review-agent | Waveform+audition+zip+history+mobile; friends use unaided |
| Gate 4 | **HUMAN** | CI green; security-review passed; cutover approved |
