# Stemloop

> Loops from anything. In seconds.

Paste a YouTube URL, pick a stem (drums / bass / vocals / guitar / keys), and
get five bar-aligned, BPM-detected 24-bit WAV loops ready to drop into your DAW.

---

## What's in this repo

```
stemloop/
├── src/                    Next.js 16 web app (App Router, Tailwind v4)
│   ├── app/
│   │   ├── page.tsx        Landing page (hero + form)
│   │   ├── jobs/[id]/      Job status + results page (polls API)
│   │   ├── login/          Google sign-in page (freemium wall)
│   │   └── api/jobs/       REST endpoints for job submission + polling
│   ├── components/         UI primitives (button, input, chip, waveform, logo)
│   └── lib/
│       ├── types.ts        Shared TS types (frontend + API agree)
│       └── jobs-store.ts   In-memory store — swap for Redis in prod
├── worker/                 Python queue consumer
│   ├── pipeline.py         yt-dlp + Demucs + librosa end-to-end
│   ├── worker.py           Redis queue consumer + R2 uploader
│   ├── requirements.txt
│   └── Dockerfile
├── Dockerfile              Next.js production image
├── railway.toml            Railway deployment config
└── .env.example            All env vars documented
```

---

## Architecture

```
User ──> stem-loops.com (Next.js)
             │
             ├── Freemium: 3 free jobs per IP, then Google OAuth
             ↓
         POST /api/jobs  ──>  Redis queue
                                 │
                                 ↓
                          Python worker
                                 ├── yt-dlp (download)
                                 ├── Demucs htdemucs_6s (separate 6 stems)
                                 ├── librosa (BPM + bar alignment)
                                 └── upload to Cloudflare R2 (24hr signed URLs)
                                 │
                                 ↓
                          POST /api/worker/jobs/[id]  (status callback)
                                 │
                                 ↓
             Frontend polls /api/jobs/[id] every 1.5s ──> download page
```

### Hosting stack

| Service | Provider | Cost |
|---|---|---|
| Web (Next.js) | Railway | ~$5/mo |
| Worker (Python + Demucs) | Railway | ~$10-15/mo (CPU) |
| Redis (queue + IP counter) | Upstash | Free tier |
| Object storage (24hr WAVs) | Cloudflare R2 | Free tier at this scale |
| Database (users + history) | Supabase | Free tier |
| Auth | Google OAuth via NextAuth | Free |
| Domain | Cloudflare Registrar | $32/yr |

Total: **~$15-20/month** at low volume.

---

## Running locally

### 1. Next.js dev server

```bash
cd stemloop
npm install
npm run dev
```

Open http://localhost:3000. The landing page works immediately. Job submissions
are handled by the in-memory store in `src/lib/jobs-store.ts` which runs a fake
pipeline so you can test the progress UI and results page without Redis or the
worker running.

### 2. Real worker (optional for local)

```bash
cd worker
pip install -r requirements.txt
# Make sure yt-dlp and ffmpeg are on PATH
export REDIS_URL=redis://localhost:6379/0
export API_BASE_URL=http://localhost:3000
python worker.py
```

Then remove `void simulateJob(id)` from `src/lib/jobs-store.ts` and push real
jobs to Redis from the API route instead.

---

## Deploying to Railway

1. Push this repo to GitHub
2. Create a new Railway project
3. Add **two services** from the same repo:
   - `web` → root directory, uses `Dockerfile`
   - `worker` → root directory, uses `worker/Dockerfile`
4. Add a **Redis** plugin — Railway auto-injects `REDIS_URL`
5. Set the env vars from `.env.example` on both services
6. Deploy

### DNS

- Point `stem-loops.com` to Railway via Cloudflare (CNAME from `@` to the Railway domain)
- Railway provisions an SSL cert automatically

---

## What needs to be wired in before launch

This scaffold is functional but has explicit stubs where real services belong.
Search the codebase for `TODO` to find them all. The important ones:

- [ ] **NextAuth + Google OAuth** in `src/app/login/page.tsx` and a new
      `src/app/api/auth/[...nextauth]/route.ts`
- [ ] **Redis-backed queue** in `src/lib/jobs-store.ts` — replace the `Map`
      with an Upstash Redis client, and publish messages to the queue
      that `worker/worker.py` consumes from
- [ ] **Supabase Postgres** for user records + job history
- [ ] **Worker callback endpoint** `src/app/api/worker/jobs/[id]/route.ts`
      that verifies the `x-worker-secret` header and updates job state
- [ ] **Zip download** — generate a streaming ZIP of all loops on
      `/api/jobs/[id]/zip` (use `archiver` in Node)
- [ ] **R2 lifecycle rule** — auto-delete objects under `jobs/*` after 24 hours
- [ ] **Analytics** — Plausible, Vercel Analytics, or Umami

---

## Visual / brand

- **Palette:** near-black background `#0A0A0B`, electric lime accent `#C4FE50`,
  off-white text. Dark mode first.
- **Fonts:** Geist Sans (UI) + Geist Mono (BPM, timestamps, file names)
- **Tone:** Producer-tool aesthetic. Minimal. Grid-aware. Monospace digits for
  everything measured.
- **References:** Splice, Arc, Linear, Vercel, Ableton Live.

All tokens live in `src/app/globals.css` under `:root` and are exposed to
Tailwind via `@theme inline`. Change one variable and the whole app reflows.

---

## License

TBD
