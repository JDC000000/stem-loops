/**
 * Phase C C1 (Beta): slow down to 90% / 75% with pitch kept, client-side.
 *
 * The stretcher is the SoundTouch AudioWorklet (@soundtouchjs/audio-worklet
 * 2.1.1, MPL-2.0). Its processor file is shipped UNMODIFIED at
 * `SOUNDTOUCH_PROCESSOR_URL` (public/vendor/soundtouch/, with its LICENSE),
 * and a test pins it byte-for-byte to the installed package. Licence gate: the
 * package README says it moved from LGPL to MPL-2.0; confirm that relicensing
 * before promoting beyond Beta (Jon, 2026-11-23).
 *
 * The engine owns the graph (engine.ts: `StretchProvider`); this file only
 * builds nodes, knows their latency, and remembers the speed per song.
 */
import type { PlaybackRate, StretchNode, StretchProvider } from './engine.ts';
import { isPlaybackRate } from './engine.ts';

/** Where the unmodified SoundTouch processor is served from. */
export const SOUNDTOUCH_PROCESSOR_URL = '/vendor/soundtouch/soundtouch-processor.js';

/**
 * Gate G2 — measured SoundTouch latency, in seconds, per rate: from a sample
 * entering a node that is already running (fed silence, as the engine keeps
 * it) to the same sample leaving it. Measured offline in headless Chromium at
 * 24 kHz and 48 kHz (docs/perf/slowdown-2026-11-23.md); the WSOLA window sizes
 * are in milliseconds, so the figure is per rate, not per sample rate.
 * play-slowdown.test.mjs pins these values.
 */
export const SOUNDTOUCH_LATENCY_SEC: Readonly<Record<number, number>> = Object.freeze({
  // 0.9: 129.9–131.8 ms across 4 markers, identical at 24 and 48 kHz.
  0.9: 0.131,
  // 0.75: 113.0–126.9 ms (mean 121) — WSOLA picks its splice per segment, so
  // single markers scatter ±7 ms around this.
  0.75: 0.121,
});

export function soundTouchLatencySec(rate: number): number {
  if (rate === 1) return 0;
  const l = SOUNDTOUCH_LATENCY_SEC[rate];
  return typeof l === 'number' ? l : 0;
}

/** How long to wait for a node's first metrics message before using it anyway. */
export const STRETCH_READY_TIMEOUT_MS = 1500;

type SoundTouchModule = typeof import('@soundtouchjs/audio-worklet');

/**
 * The browser provider. The package is imported lazily: `SoundTouchNode`
 * extends `AudioWorkletNode`, which does not exist on the server, and nobody
 * who stays at 100% should download it.
 */
export function soundTouchStretch(processorUrl: string = SOUNDTOUCH_PROCESSOR_URL): StretchProvider {
  let mod: SoundTouchModule | null = null;
  return {
    async register(ctx) {
      mod = await import('@soundtouchjs/audio-worklet');
      await mod.SoundTouchNode.register(ctx, processorUrl);
    },
    create(ctx) {
      if (!mod) throw new Error('SoundTouch is not registered');
      // Mono in, mono out: the engine's stems are mono.
      return new mod.SoundTouchNode({ context: ctx, outputChannelCount: 1 }) as unknown as StretchNode;
    },
    ready(node) {
      // The processor posts 'metrics' every 100 render blocks once it is
      // processing input (the engine feeds it silence). Seeing one means it is
      // instantiated and running on the render thread.
      return new Promise<void>((resolve) => {
        const n = node as unknown as EventTarget & { metrics?: unknown };
        if (n.metrics) return resolve();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          n.removeEventListener?.('metrics', finish);
          resolve();
        };
        n.addEventListener?.('metrics', finish);
        setTimeout(finish, STRETCH_READY_TIMEOUT_MS);
      });
    },
    latencySec: soundTouchLatencySec,
    release(node) {
      try {
        (node as unknown as AudioWorkletNode).port?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ── remembered speed, per song ───────────────────────────────────────────────

/** localStorage key prefix; one entry per job id. */
export const SPEED_KEY_PREFIX = 'sl.play.speed.v1.';

/** The speed remembered for this song, or 1. Never throws (private mode, quota, bad data). */
export function readSpeed(jobId: string | null | undefined): PlaybackRate {
  if (!jobId) return 1;
  try {
    const raw = globalThis.localStorage?.getItem(SPEED_KEY_PREFIX + jobId);
    const n = raw == null ? NaN : Number(raw);
    return isPlaybackRate(n) ? n : 1;
  } catch {
    return 1;
  }
}

/** Remember this song's speed; 100% clears the entry. Never throws. */
export function writeSpeed(jobId: string | null | undefined, rate: number): void {
  if (!jobId || !isPlaybackRate(rate)) return;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    if (rate === 1) ls.removeItem(SPEED_KEY_PREFIX + jobId);
    else ls.setItem(SPEED_KEY_PREFIX + jobId, String(rate));
  } catch {
    /* private mode: the speed simply resets next time */
  }
}

/** "75%" for the pill and the menu; null at 100% (no pill). */
export function speedLabel(rate: number | null | undefined): string | null {
  if (rate == null || rate === 1 || !isPlaybackRate(rate)) return null;
  return `${Math.round(rate * 100)}%`;
}
