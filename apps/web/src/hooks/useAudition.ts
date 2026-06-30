// In-browser loop audition (P3-3) via the Web Audio API. Fetches and decodes the
// loop WAV on demand (only the short loop, never the full track) and loops it.
import { useCallback, useRef, useState } from 'react';

export function useAudition(signedUrl: string | null | undefined) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const stop = useCallback(() => {
    try {
      srcRef.current?.stop();
    } catch {
      /* already stopped */
    }
    srcRef.current = null;
    setPlaying(false);
  }, []);

  const toggle = useCallback(async () => {
    if (!signedUrl) return;
    if (playing) {
      stop();
      return;
    }
    setLoading(true);
    try {
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      const resp = await fetch(signedUrl);
      const buf = await ctx.decodeAudioData(await resp.arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(ctx.destination);
      src.onended = () => setPlaying(false);
      src.start();
      srcRef.current = src;
      setPlaying(true);
    } catch {
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }, [signedUrl, playing, stop]);

  return { playing, loading, toggle, stop };
}
