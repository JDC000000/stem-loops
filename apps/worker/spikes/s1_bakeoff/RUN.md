# S1 bake-off — how to run

## Status (2026-06-30)
- **yt-dlp path: RUN.** Datacenter IP, no cookies → **0/50 (100% bot-block)**. `s1_ytdlp_results.json`.
- **Cobalt path: ready, NOT yet run.** Blocked on the Fly deploy token (vault `Fly.io` entry empty; secure form opened under slug `fly-io`).

## 1. Deploy Cobalt to Fly (needs the Fly token)
```bash
export PATH="$HOME/.fly/bin:$PATH"
export FLY_API_TOKEN="$(node /opt/projects/crhq-satellite/server/services/credentials-cli.js get-key fly-io)"   # or get-key Fly.io once populated
cd apps/worker/spikes/s1_bakeoff/cobalt
fly deploy --remote-only --ha=false      # app: stem-loops-cobalt-spike, region lax
fly status                                # confirm a machine is up
# smoke test the API:
COBALT_URL=https://stem-loops-cobalt-spike.fly.dev \
  python ../cobalt_client.py "https://www.youtube.com/watch?v=CPwd-Av9rwE"
```

## 2. Run BOTH paths over the 50-URL set
```bash
cd apps/worker
COBALT_URL=https://stem-loops-cobalt-spike.fly.dev \
  ./.venv/bin/python spikes/s1_bakeoff/datacenter_bakeoff.py spikes/fixtures/fixture_urls.txt
```
Prints per-path success% + p50/p90 (over successes) + a `GATE` line (PASS if ≥95% and p90<10s).
Writes `s1_ytdlp_results.json` and `s1_cobalt_results.json`.

## 3. Tear down (spike instance, $0 idle)
`fly apps destroy stem-loops-cobalt-spike --yes` (scale-to-zero means it costs ~nothing idle; destroy when the decision is locked).

## Notes
- `cobalt_client.py` uses the **Cobalt v10** API (`POST /`, `downloadMode:"audio"`). Set `COBALT_API_KEY` only if the instance enforces auth (the spike instance does not).
- The PRD bans residential proxies, so Fly's datacenter egress IS the production-like test for Cobalt.
