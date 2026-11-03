# Restore point: stem-loops.com as live on 2026-11-02

This file records exactly what stem-loops.com runs on 2026-11-02, before the Phase 0 change (PR #4, "Stem-Loops Play"), and how to put it back. If Play fails, this is the way back to today's product.

Git tags: `stem-loops-com-2026-11-02` (main `c3f6a911`, the website and the worker source) and `stem-loops-worker-v23-image-source` (`52ffe33`, see "Worker" below). GitHub release: "stem-loops.com restore point 2026-11-02".

## What is live today (checked 2026-11-02 by the Stem-Loops operator)

| Part | Where it runs | Exact id |
|---|---|---|
| Website (stem-loops.com, www, stem-loops-web.vercel.app) | Vercel project `stem-loops-web` (root `apps/web`, Next.js), team `jdci-nc` | deployment `dpl_CbpmufrEWUtc6t9esMf7psrc5e3t`, commit `c3f6a911ab64fae7cce60c90d9185c641fe14471` (READY, production) |
| Worker (stems, loops, uploads) | Fly app `stem-loops`, region `iad`, 1 machine | release v23 (2026-10-13), image `registry.fly.io/stem-loops:deployment-01M4HZX3RQSSZ59749ZBQD99JS`, digest `sha256:2d62754e834c5124dbb8c22551c403cdb648239cae1bac1c1544fdd066f2872a` |
| Database | Supabase project `qthrhamfljhifhfwvvwj` (Postgres) | schema = migrations `001` to `007` in `apps/worker/migrations/` |
| Audio storage | Cloudflare R2 (bucket from `R2_BUCKET_NAME`) | 24 h retention; no permanent user files |
| Stem separation | Replicate (Demucs; model from `REPLICATE_DEMUCS_MODEL` / `REPLICATE_MODEL_VERSION`) | external API |

YouTube link input is ON (`ALLOW_YOUTUBE_INPUT=true` / `NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT=true` since 2026-07-18); users can also upload their own file.

### Worker source
The v23 image has no git SHA inside it. v22 (2026-10-10T04:07Z) and v23 use the same image; main was at `52ffe33` when it was built. Between `52ffe33` and `c3f6a911`, worker runtime files changed only in `05b967d` ("style(worker): clear ruff + black findings"), plus test files and `packages/types/scripts/codegen.py`. So `c3f6a911` builds the same worker behaviour (inferred from the git history, not proven byte for byte). For a byte-exact worker, use the image above. For a rebuild, use either tag.

### Configuration names (values live in the providers, never in git)
- Vercel production env: ALLOW_YOUTUBE_INPUT, DATABASE_URL, DATABASE_URL_POOLED, HISTORY_COOKIE_KEY, IP_HASH_KEY, NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT, NEXT_PUBLIC_SENTRY_DSN, R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_SECRET_ACCESS_KEY, SENTRY_AUTH_TOKEN, SENTRY_DSN, SENTRY_ORG, SENTRY_PROJECT.
- Fly secrets (app `stem-loops`): ALLOW_YOUTUBE_INPUT, DATABASE_URL, R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_SECRET_ACCESS_KEY, REPLICATE_API_TOKEN, SENTRY_DSN, YTDLP_MAX_ATTEMPTS.
- Fly env (`apps/worker/fly.toml`): LOG_LEVEL, LOOP_ENCODE_WORKERS, REPLICATE_DEADLINE, REPLICATE_DEMUCS_MODEL, REPLICATE_MODEL_VERSION.

If a Play change edits any of these, write the old value's NAME and purpose in the change's PR so it can be set back.

## How to go back

Undo in this order: worker first, then database, then git.

1. **Worker.** Fast way: `fly deploy -a stem-loops --image registry.fly.io/stem-loops:deployment-01M4HZX3RQSSZ59749ZBQD99JS` (the image was still in the Fly registry on 2026-11-02; Fly may drop old images over time). Lasting way: `git checkout stem-loops-com-2026-11-02 && cd apps/worker && fly deploy` (same as `make deploy-worker`).
2. **Database.** Phase 0 only ADDS tables (migration `008`: kill_switches, blocklist, fetch_attempts). Today's worker ignores them, so leaving them is harmless. To remove them: run `apps/worker/migrations/down/008_fetch_gates_down.sql` (it also deletes the `008_fetch_gates.sql` row from `_migrations`; it exists from PR #4 onward). Do the same, newest first, for any later migration that has a `down/` file.
3. **Website.** Phase 0 does not touch the website. If a later phase changes it: fast way, in Vercel open project `stem-loops-web` > Deployments > `dpl_CbpmufrEWUtc6t9esMf7psrc5e3t` > Promote to Production (Vercel keeps old production deployments only 30 days and the newest 10 after they stop being current). Lasting way: `git checkout stem-loops-com-2026-11-02 && cd apps/web && npx vercel deploy --prod` (same as `make deploy-web`).
4. **Git.** Revert the Play merge commit(s) on `main`, or reset a branch to the tag `stem-loops-com-2026-11-02` and merge that through a PR. CI must be green.
5. **Check.** Open https://stem-loops.com/, upload a short song, confirm stems and loops download. The operator's health check (synthetic upload job end to end, deployed ids against expected state) must report 0 concerns.

## What does not come back
Jobs and audio expire after 24 h by design, so there is no user library to restore. Sentry history and provider billing are outside git.
