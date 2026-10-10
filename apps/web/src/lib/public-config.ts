// Browser-visible build-time config. NEXT_PUBLIC_* must be referenced literally so Next
// can inline them; everything client-side reads them from here, never process.env directly.

// R2 rollout gate for the YouTube-link input (mirrors the server-side ALLOW_YOUTUBE_INPUT,
// which is the real enforcement point). Off unless explicitly 'true'.
export const YOUTUBE_INPUT_ENABLED = process.env.NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT === 'true';

// Where the landing's demo audio + peaks live (served cross-origin with CORS; audio is
// never committed to this repo). Empty → the landing shows its "sample didn't load" state.
const rawDemoBase = (process.env.NEXT_PUBLIC_DEMO_ASSET_BASE ?? '').trim();
export const DEMO_ASSET_BASE = rawDemoBase && !rawDemoBase.endsWith('/') ? `${rawDemoBase}/` : rawDemoBase;

// File name the demo WAV downloads as (the pipeline's real output name).
export const DEMO_WAV_FILENAME = 'lucky_ticket_drums_101.33bpm_G#_minor_chorus_0001.wav';
export const DEMO_WAV_URL = DEMO_ASSET_BASE ? `${DEMO_ASSET_BASE}drums-8bar.wav` : '';
