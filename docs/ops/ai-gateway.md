# Cloudflare AI Gateway — Anthropic

Fleet Playbook Move 1. This doc records the gateway that fronts any
server-side Anthropic API traffic from `apps/web` (Vercel) and
`apps/worker` (Fly), and how to wire new call sites to it.

## Purpose

- **Cost ceiling.** Hard daily spend cap on Anthropic traffic
  originated by stem-loops services, enforced at the gateway edge
  before the request hits Anthropic.
- **Rate limiting.** Protect against runaway loops in a service that
  starts calling `messages.create` in a hot path.
- **Per-request visibility.** Every call is logged in the Cloudflare
  AI Gateway dashboard (cost, latency, cache hit/miss, model,
  truncated prompt/response) without us building an observability
  shim ourselves.

## Status (2026-11-04)

stem-loops has **zero server-side Anthropic API calls today** —
verified by grepping `apps/web` and `apps/worker` for
`anthropic` / `@anthropic-ai` / `ANTHROPIC_API_KEY`. The only hits are
bot-user-agent strings in `apps/web/src/app/robots.ts`.

This gateway is therefore **future-proofing**: the `ANTHROPIC_BASE_URL`
env var is in place so the first `messages.create` call added to any
service automatically benefits from cost control and visibility,
without a follow-up PR.

For **today's actual agent spend** (Jon's Claude Code CLI sessions and
Cowork runs), the gateway is not in the loop — those clients hit
Anthropic directly. The control for that traffic is the **monthly
billing limit set in console.anthropic.com** (plus the $200 promo
credit covering Agent SDK / API / Batch / Playground / Managed Agents
usage).

## Gateway

| Field                | Value                                                                                                             |
|----------------------|-------------------------------------------------------------------------------------------------------------------|
| Name                 | `stem-loops-anthropic`                                                                                            |
| Cloudflare account   | `4d40ce112bdcfe0e6b731d16d5b03df3`                                                                                |
| Anthropic endpoint   | `https://gateway.ai.cloudflare.com/v1/4d40ce112bdcfe0e6b731d16d5b03df3/stem-loops-anthropic/anthropic`             |
| Dashboard            | `https://dash.cloudflare.com/4d40ce112bdcfe0e6b731d16d5b03df3/ai/ai-gateway/gateways/stem-loops-anthropic/overview` |
| Rate limit           | 60 req/min, fixed window                                                                                          |
| Daily spend ceiling  | $10/day (Cloudflare AI Gateway Beta feature, configured in dashboard — **not** in this repo)                      |
| Alert                | 80% of daily ceiling (configured in dashboard)                                                                    |

Caching is **on by default**. Determinism-sensitive calls must send
the header `cf-aig-skip-cache: true` on that specific call. Everything
else is fair game to cache.

## Env vars

Both services (`apps/web` on Vercel, `apps/worker` on Fly) read:

```
ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/4d40ce112bdcfe0e6b731d16d5b03df3/stem-loops-anthropic/anthropic
ANTHROPIC_API_KEY=<unchanged — real Anthropic key>
```

Rules:

- `ANTHROPIC_BASE_URL` is set as a platform secret per environment
  (Preview + Production). It is **not** committed to the repo. A
  placeholder is in `.env.example` so local dev knows about it.
- `ANTHROPIC_API_KEY` is unchanged. The Anthropic SDK sends it as
  `x-api-key` by default; AI Gateway accepts that.
- **Do NOT send `Authorization: Bearer <key>` on this endpoint.** AI
  Gateway's Anthropic provider rejects that header. If a library
  insists, override it to `x-api-key: <key>` or drop the Bearer
  header.

### Vercel

Set in the Vercel project settings for `stem-loops` (staging and prod
projects) under *Settings → Environment Variables*, scoped to `Preview`
and `Production` environments. Key: `ANTHROPIC_BASE_URL`, value: the
endpoint URL above.

### Fly

No MCP; run on Jon's workstation for each worker app:

```sh
fly secrets set ANTHROPIC_BASE_URL='https://gateway.ai.cloudflare.com/v1/4d40ce112bdcfe0e6b731d16d5b03df3/stem-loops-anthropic/anthropic' \
  -a <app-name>
```

Replace `<app-name>` with the real Fly app name for each environment
(Jon knows them — not committed here).

## Acceptance

- [ ] Dashboard at the URL above shows **≥1 request** after the first
      server-side `messages.create` is merged and deployed.
- [ ] Alert at 80% of the $10/day ceiling is configured (dashboard,
      Beta surface).
- [ ] `ANTHROPIC_BASE_URL` is present in Vercel (Preview + Production)
      and in Fly secrets for every worker app that calls Anthropic.

Until the first call ships, the dashboard will stay empty — that is
expected.

## References

- Cloudflare AI Gateway — Anthropic provider:
  <https://developers.cloudflare.com/ai-gateway/providers/anthropic/>
- Cloudflare AI Gateway — Rate limiting:
  <https://developers.cloudflare.com/ai-gateway/configuration/rate-limiting/>
