/**
 * Cutting a planned loop out of a decoded stem.
 *
 * Pure and synchronous: decoded PCM in, WAV bytes out. The decoding itself —
 * the only part that needs an AudioContext — is the caller's job, so this file
 * is testable under `node:test` with hand-built Float32Arrays and nothing else.
 */
import type { StemName } from '@/lib/play/types';
import type { LoopSpec } from './plan';
import { encodeWav24 } from './wav';

/** One decoded stem: channel-major PCM plus the rate it was decoded at. */
export interface DecodedStem {
  readonly name: StemName;
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
}

/**
 * Edge declick, in seconds.
 *
 * NOT a seamless loop join. The worker applies one (`dsp/seamless.apply`) by
 * crossfading the loop's tail over its head, which keeps the loop point
 * inaudible when it wraps. This is the lesser thing: a 1 ms linear ramp at each
 * end so the file does not begin and end on a hard step, which is an audible
 * tick at any level. Said plainly because the two are easy to confuse and the
 * product should not claim the better one.
 */
export const DECLICK_SEC = 0.001;

/**
 * Slice `[startSec, startSec + frames)` out of a decoded stem.
 *
 * Reads past the end of the source are filled with silence rather than
 * returning a short buffer: every card in a bank must produce a file of the
 * length its label promises, and a stem that ends a few milliseconds early
 * (the encoder's padding differs per stem) must not yield a shorter loop than
 * its neighbours.
 */
export function sliceFrames(
  channels: readonly Float32Array[],
  startFrame: number,
  frames: number,
): Float32Array[] {
  return channels.map((src) => {
    const out = new Float32Array(frames);
    const from = Math.max(0, startFrame);
    const available = Math.max(0, Math.min(frames, src.length - from));
    if (available > 0) out.set(src.subarray(from, from + available), 0);
    return out;
  });
}

/** Apply the edge declick in place and return the same arrays. */
export function declick(channels: Float32Array[], sampleRate: number): Float32Array[] {
  const ramp = Math.min(Math.floor(DECLICK_SEC * sampleRate), Math.floor((channels[0]?.length ?? 0) / 2));
  if (ramp <= 0) return channels;
  for (const c of channels) {
    for (let i = 0; i < ramp; i += 1) {
      const g = i / ramp;
      c[i] *= g;
      c[c.length - 1 - i] *= g;
    }
  }
  return channels;
}

/** The finished article: one loop's bytes, plus the spec that asked for it. */
export interface CutLoop {
  readonly spec: LoopSpec;
  readonly bytes: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
  /** Peak magnitude per channel-sum, 0..1 — enough to draw a bar meter. */
  readonly peaks: number[];
}

/** Coarse peak envelope, `buckets` values in 0..1, for the card's waveform. */
export function peakEnvelope(channels: readonly Float32Array[], buckets = 48): number[] {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0 || buckets <= 0) return [];
  const out: number[] = new Array(buckets).fill(0);
  const per = frames / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor(b * per);
    const to = Math.min(frames, Math.floor((b + 1) * per));
    let peak = 0;
    for (const c of channels) {
      for (let i = from; i < to; i += 1) {
        const v = Math.abs(c[i]);
        if (v > peak) peak = v;
      }
    }
    out[b] = peak > 1 ? 1 : peak;
  }
  return out;
}

/** Cut one planned loop out of one decoded stem. */
export function cutLoop(source: DecodedStem, spec: LoopSpec): CutLoop {
  const startFrame = Math.round(spec.startSec * source.sampleRate);
  const frames = Math.round(spec.durationSec * source.sampleRate);
  const sliced = declick(sliceFrames(source.channels, startFrame, frames), source.sampleRate);
  return {
    spec,
    bytes: encodeWav24(sliced, source.sampleRate),
    sampleRate: source.sampleRate,
    channels: sliced.length,
    peaks: peakEnvelope(sliced),
  };
}

/**
 * Cut every spec in a plan from the stems that were decoded.
 *
 * A spec whose stem is absent is skipped, not failed: a job whose `guitar`
 * never encoded should still yield the other five stems' loops rather than
 * nothing at all.
 */
export function cutPlan(sources: readonly DecodedStem[], specs: readonly LoopSpec[]): CutLoop[] {
  const byStem = new Map(sources.map((s) => [s.name, s]));
  const out: CutLoop[] = [];
  for (const spec of specs) {
    const source = byStem.get(spec.stem);
    if (source) out.push(cutLoop(source, spec));
  }
  return out;
}
