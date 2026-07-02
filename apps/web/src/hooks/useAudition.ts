// In-browser loop audition (P3-3) via the Web Audio API. Fetches and decodes the
// loop WAV on demand (only the short loop, never the full track) and loops it.
//
// SINGLE ACTIVE PLAYER: only one loop plays at a time. A module-level ref holds the
// stop() of whatever is currently playing, so (a) starting a new loop stops the
// previous one (SoundCloud/Splice-style UX) and (b) unmounting a card — e.g. clicking
// a stem-filter tab re-renders the grid — always stops its audio. Without this, a
// looping AudioBufferSourceNode (loop=true) gets orphaned on unmount and plays forever
// with no UI left to stop it (only a page reload silences it).
import { useCallback, useEffect, useRef, useState } from 'react';

let activeStop: (() => void) | null = null;

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
    if (activeStop === stop) activeStop = null;
    setPlaying(false);
  }, []);

  const toggle = useCallback(async () => {
    if (!signedUrl) return;
    if (playing) {
      stop();
      return;
    }
    // Single active player: stop whatever other loop is currently playing first.
    if (activeStop && activeStop !== stop) activeStop();
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
      activeStop = stop;
      setPlaying(true);
    } catch {
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }, [signedUrl, playing, stop]);

  // Kill this card's audio when it unmounts (filter-tab re-render, navigation, etc.)
  // so a looping source can never be orphaned. `stop` is stable, so this runs on unmount.
  useEffect(() => stop, [stop]);

  return { playing, loading, toggle, stop };
}
