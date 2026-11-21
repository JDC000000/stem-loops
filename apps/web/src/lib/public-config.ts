// Browser-visible build-time config. NEXT_PUBLIC_* must be referenced literally so Next
// can inline them; everything client-side reads them from here, never process.env directly.

// R2 rollout gate for the YouTube-link input (mirrors the server-side ALLOW_YOUTUBE_INPUT,
// which is the real enforcement point). Off unless explicitly 'true'.
export const YOUTUBE_INPUT_ENABLED = process.env.NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT === 'true';

// Where the demo loop file lives (served cross-origin with CORS; audio is never committed to
// this repo): assets-v3/drums-8bar.wav, offered by the Download loops intro
// (components/loops/LoopsIntro.tsx). v3 = output of the tempo-fit / beat-anchoring worker
// (documents/stem-loops-landing/demo-assets-v3/FINDINGS.md). The host caches for 24h, so a new
// file goes in a NEW versioned dir. (The home page's example lanes, which read the rest of this
// host, were removed in A4, 2026-11-21.)
// Default: the live demo host, so no deploy env var is needed. NEXT_PUBLIC_DEMO_ASSET_BASE
// overrides it (set it to a single space to turn the demo file off, e.g. for an offline build).
const DEFAULT_DEMO_ASSET_BASE = 'https://myzone-jon-cartwright-stem-loops-demo.crhq.ai/';
const rawDemoBase = (process.env.NEXT_PUBLIC_DEMO_ASSET_BASE ?? DEFAULT_DEMO_ASSET_BASE).trim();
export const DEMO_ASSET_BASE = rawDemoBase && !rawDemoBase.endsWith('/') ? `${rawDemoBase}/` : rawDemoBase;
const DEMO_FILES_DIR = 'assets-v3/';

// The demo WAV and the file name it downloads as (the pipeline's real output name).
// (the key in it is the tool's estimate; the page says so)
export const DEMO_WAV_FILENAME = 'lucky_ticket_drums_102.0bpm_G_minor_verse_0006.wav';
export const DEMO_WAV_URL = DEMO_ASSET_BASE ? `${DEMO_ASSET_BASE}${DEMO_FILES_DIR}drums-8bar.wav` : '';
