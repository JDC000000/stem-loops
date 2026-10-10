// Browser-visible build-time config. NEXT_PUBLIC_* must be referenced literally so Next
// can inline them; everything client-side reads them from here, never process.env directly.

// R2 rollout gate for the YouTube-link input (mirrors the server-side ALLOW_YOUTUBE_INPUT,
// which is the real enforcement point). Off unless explicitly 'true'.
export const YOUTUBE_INPUT_ENABLED = process.env.NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT === 'true';

// Where the landing's demo audio + peaks live (served cross-origin with CORS; audio is
// never committed to this repo). Layout under the base, same as the prototype:
//   demo-assets-v2/{loops.json, song-context.json, 1bar|2bar|4bar|8bar/*.mp3}
//   assets/{before-peaks.json, drums-8bar.wav}
// The host caches for 24h, so new demo data goes in a NEW versioned dir (bump DEMO_DATA_DIR).
// Empty base (override set blank) → the landing shows its "sample didn't load" state; the tool still works.
// Default: the live demo host, so no deploy env var is needed. NEXT_PUBLIC_DEMO_ASSET_BASE
// overrides it (set it to a single space to turn the demo off, e.g. for an offline build).
const DEFAULT_DEMO_ASSET_BASE = 'https://myzone-jon-cartwright-stem-loops-demo.crhq.ai/';
const rawDemoBase = (process.env.NEXT_PUBLIC_DEMO_ASSET_BASE ?? DEFAULT_DEMO_ASSET_BASE).trim();
export const DEMO_ASSET_BASE = rawDemoBase && !rawDemoBase.endsWith('/') ? `${rawDemoBase}/` : rawDemoBase;
export const DEMO_DATA_BASE = DEMO_ASSET_BASE ? `${DEMO_ASSET_BASE}demo-assets-v2/` : '';
export const DEMO_BEFORE_PEAKS_URL = DEMO_ASSET_BASE ? `${DEMO_ASSET_BASE}assets/before-peaks.json` : '';

// The demo WAV and the file name it downloads as (the pipeline's real output name).
export const DEMO_WAV_FILENAME = 'lucky_ticket_drums_101.33bpm_G#_minor_chorus_0001.wav';
export const DEMO_WAV_URL = DEMO_ASSET_BASE ? `${DEMO_ASSET_BASE}assets/drums-8bar.wav` : '';
