// Live tab-audio capture for Variant Y.
//
// Contract (decision record v1.3 §1.6a — strict):
//   - getDisplayMedia is only invoked on an explicit user gesture (click).
//     Never on page load. Permission chip is user-driven, nothing more.
//   - Audio never leaves the browser. No network IO from this module.
//
// Browser support (per TSD §5.4 as amended for v3):
//   - Chrome + Edge desktop: audio-only tab capture works.
//   - Firefox: `getDisplayMedia` on audio drops silently on some builds.
//     Earlier plan was "warn + attempt"; TSD §5.4 now says BLOCK on Firefox.
//   - iOS Safari: `getDisplayMedia` is not implemented; block with a clear
//     "desktop only" banner.
//   - Desktop Safari: audio-only tab capture is unsupported; block.

export type UnsupportedReason =
  | 'firefox'
  | 'ios-safari'
  | 'safari-desktop'
  | 'no-display-media'
  | 'no-audio-worklet';

export interface SupportCheck {
  supported: boolean;
  reason?: UnsupportedReason;
  message?: string;
}

export interface TabCaptureOptions {
  /** Target sample rate for downstream CQT. Default 22050. */
  sampleRate?: number;
  /** Ring-buffer length in seconds. Default 5. */
  bufferSeconds?: number;
  /** Chunk emit interval in seconds. Default 1. */
  chunkSeconds?: number;
  /**
   * Fallback AudioWorklet URL. Default `/chord-capture-worklet.js`. In this
   * PR we use a ScriptProcessorNode fallback instead — AudioWorklet modules
   * ship in PR-Y1.7 together with the real model.
   */
  workletUrl?: string;
}

export interface TabCapture {
  /** Fires on every `chunkSeconds` of accumulated audio. */
  onAudioChunk(cb: (chunk: Float32Array) => void): () => void;
  /** Fires on fatal errors (device revoked, decode error, etc.). */
  onError(cb: (err: Error) => void): () => void;
  /** Stop capture and release the MediaStream + AudioContext. */
  stop(): Promise<void>;
}

/**
 * Feature-detect the browser. The brief requires:
 *   - Firefox → show "Chrome/Edge required" banner
 *   - iOS Safari → show "desktop only" banner
 *   - Desktop Safari → block (audio-only tab capture unsupported)
 */
export function checkTabCaptureSupport(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): SupportCheck {
  const uaLower = ua.toLowerCase();
  // iOS Safari detection — covers iPad-as-desktop via maxTouchPoints.
  const iPad =
    typeof navigator !== 'undefined' &&
    navigator.platform === 'MacIntel' &&
    (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints! > 1;
  const isIOS = /iphone|ipad|ipod/.test(uaLower) || iPad;
  if (isIOS) {
    return {
      supported: false,
      reason: 'ios-safari',
      message:
        'Live chord overlay is desktop-only. Open stem-loops in Chrome or Edge on a laptop or desktop.',
    };
  }
  // Firefox — TSD §5.4 block clause.
  if (/firefox/.test(uaLower)) {
    return {
      supported: false,
      reason: 'firefox',
      message:
        'Firefox does not support reliable tab-audio capture. Use Chrome or Edge for the live chord overlay.',
    };
  }
  // Desktop Safari — audio-only tab capture is not supported.
  // Order matters: Chrome's UA contains "Safari" too, so check !chrome.
  if (/safari/.test(uaLower) && !/chrome|chromium|edg/.test(uaLower)) {
    return {
      supported: false,
      reason: 'safari-desktop',
      message:
        'Safari does not support tab-audio capture. Use Chrome or Edge for the live chord overlay.',
    };
  }
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getDisplayMedia !== 'function'
  ) {
    return {
      supported: false,
      reason: 'no-display-media',
      message: 'This browser does not support screen capture.',
    };
  }
  return { supported: true };
}

interface RingBuffer {
  capacity: number;
  write: (chunk: Float32Array) => void;
  readSinceLast: () => Float32Array;
  totalSamples: () => number;
}

function createRingBuffer(capacity: number): RingBuffer {
  const buf = new Float32Array(capacity);
  let writeIdx = 0;
  let sinceLastRead = 0;
  let total = 0;
  return {
    capacity,
    write(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        buf[writeIdx] = chunk[i];
        writeIdx = (writeIdx + 1) % capacity;
      }
      sinceLastRead = Math.min(sinceLastRead + chunk.length, capacity);
      total += chunk.length;
    },
    readSinceLast() {
      const n = sinceLastRead;
      const out = new Float32Array(n);
      // Read the last n samples ending at writeIdx-1
      let idx = (writeIdx - n + capacity) % capacity;
      for (let i = 0; i < n; i++) {
        out[i] = buf[idx];
        idx = (idx + 1) % capacity;
      }
      sinceLastRead = 0;
      return out;
    },
    totalSamples() {
      return total;
    },
  };
}

// Testing seam so unit tests can drive the capture flow without a real
// browser. The default uses globals. See `src/chord/__tests__/tab-capture.test.mjs`.
export interface TabCaptureEnv {
  checkSupport?: typeof checkTabCaptureSupport;
  getDisplayMedia?: () => Promise<MediaStream>;
  AudioContext?: typeof AudioContext;
  now?: () => number;
}

/**
 * Request tab-audio capture and wire the MediaStream → AudioContext →
 * ring-buffer pipeline. MUST be called from a user gesture handler
 * (e.g. a button `onClick`) — browsers reject `getDisplayMedia` otherwise.
 */
export async function startTabCapture(
  opts: TabCaptureOptions = {},
  env: TabCaptureEnv = {},
): Promise<TabCapture> {
  const check = (env.checkSupport ?? checkTabCaptureSupport)();
  if (!check.supported) {
    throw new UnsupportedBrowserError(check);
  }
  const sampleRate = opts.sampleRate ?? 22050;
  const bufferSeconds = opts.bufferSeconds ?? 5;
  const chunkSeconds = opts.chunkSeconds ?? 1;

  const getDisplayMedia =
    env.getDisplayMedia ??
    (() =>
      navigator.mediaDevices.getDisplayMedia({
        audio: true,
        // `video: true` is required by some Chrome versions for audio tracks
        // even when we only want audio; we immediately stop the video track.
        video: true,
      }));

  const stream = await getDisplayMedia();
  // Only audio matters — stop the video track immediately.
  stream.getVideoTracks().forEach((t) => t.stop());
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      'tab-capture: user did not share tab audio. Re-share the tab and tick "Share tab audio".',
    );
  }

  const AudioCtor =
    env.AudioContext ??
    (typeof AudioContext !== 'undefined'
      ? AudioContext
      : (
          globalThis as unknown as {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext);
  if (!AudioCtor) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('tab-capture: AudioContext unavailable in this browser.');
  }

  const ctx = new AudioCtor({ sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  const chunkSamples = Math.round(sampleRate * chunkSeconds);
  const ring = createRingBuffer(Math.round(sampleRate * bufferSeconds));

  const chunkCbs = new Set<(chunk: Float32Array) => void>();
  const errorCbs = new Set<(err: Error) => void>();
  let stopped = false;

  // NOTE: we use ScriptProcessorNode (deprecated but universally available).
  // Proper AudioWorklet lands with PR-Y1.7 together with the real model —
  // this PR's goal is to prove the pipeline. ScriptProcessor is the correct
  // choice for the stub since AudioWorklet modules need an extra script to
  // ship as a public asset and that is out of scope here.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  let samplesSinceEmit = 0;
  proc.onaudioprocess = (ev) => {
    if (stopped) return;
    try {
      const input = ev.inputBuffer.getChannelData(0);
      // Copy — the underlying buffer is reused by the Web Audio runtime.
      const copy = new Float32Array(input.length);
      copy.set(input);
      ring.write(copy);
      samplesSinceEmit += copy.length;
      if (samplesSinceEmit >= chunkSamples) {
        const payload = ring.readSinceLast();
        samplesSinceEmit = 0;
        chunkCbs.forEach((cb) => {
          try {
            cb(payload);
          } catch (err) {
            errorCbs.forEach((ecb) => ecb(err as Error));
          }
        });
      }
    } catch (err) {
      errorCbs.forEach((ecb) => ecb(err as Error));
    }
  };
  source.connect(proc);
  // Required for ScriptProcessor to fire on some browsers: wire to a muted
  // destination. We create a GainNode with gain 0 so no audio plays back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.connect(mute);
  mute.connect(ctx.destination);

  // If the user revokes capture (stops sharing from the Chrome chip), the
  // audio track ends — surface that as an error.
  audioTracks.forEach((t) => {
    t.addEventListener('ended', () => {
      errorCbs.forEach((ecb) =>
        ecb(new Error('tab-capture: sharing stopped by the user.')),
      );
    });
  });

  return {
    onAudioChunk(cb) {
      chunkCbs.add(cb);
      return () => chunkCbs.delete(cb);
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => errorCbs.delete(cb);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        proc.disconnect();
      } catch {
        /* no-op */
      }
      try {
        source.disconnect();
      } catch {
        /* no-op */
      }
      try {
        mute.disconnect();
      } catch {
        /* no-op */
      }
      try {
        await ctx.close();
      } catch {
        /* no-op */
      }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export class UnsupportedBrowserError extends Error {
  readonly reason: UnsupportedReason;
  constructor(check: SupportCheck) {
    super(check.message ?? 'Browser unsupported for tab capture');
    this.name = 'UnsupportedBrowserError';
    this.reason = check.reason ?? 'no-display-media';
  }
}

/** Expose the ring buffer factory for tests. */
export const __internal = { createRingBuffer };
