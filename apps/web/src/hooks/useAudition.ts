// In-browser loop audition (P3-3) via the Web Audio API. Fetches and decodes the
// loop WAV on demand (only the short loop, never the full track) and loops it.
//
// SINGLE ACTIVE PLAYER: only one loop plays at a time. `activeStop` holds the stop()
// of whatever is currently playing (so starting a new loop stops the previous one and
// unmounting a card always stops its audio). `activeLoad` holds the AbortController of
// the load that is ALLOWED to become the next player.
//
// RACE FIX (QA P1): both slots are claimed SYNCHRONOUSLY at click time — before the
// async fetch+decode — and any superseded in-flight load is aborted, with a post-decode
// re-check. Previously `activeStop` was only set AFTER decode (~hundreds of ms), so
// clicking several loops faster than decode time let 2-3 slip past the guard and play
// simultaneously. The unmount-cleanup half (below) already worked and is preserved.
import { useCallback, useEffect, useRef, useState } from 'react';

let activeStop: (() => void) | null = null;
let activeLoad: AbortController | null = null;

export function useAudition(signedUrl: string | null | undefined) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const loadRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    try {
      srcRef.current?.stop();
    } catch {
      /* already stopped */
    }
    srcRef.current = null;
    if (activeStop === stop) activeStop = null;
    // Abort this card's in-flight load (e.g. unmount mid-decode) and release the slot.
    if (loadRef.current) {
      loadRef.current.abort();
      if (activeLoad === loadRef.current) activeLoad = null;
      loadRef.current = null;
    }
    setPlaying(false);
    setLoading(false);
  }, []);

  const toggle = useCallback(async () => {
    if (!signedUrl) return;
    if (playing) {
      stop();
      return;
    }
    // Claim the active slot SYNCHRONOUSLY, before any await, so a burst of rapid clicks
    // resolves to exactly one winner: stop the current player, abort any in-flight load,
    // then register THIS load as the only one allowed to start.
    if (activeStop && activeStop !== stop) activeStop();
    if (activeLoad) activeLoad.abort();
    const ctrl = new AbortController();
    activeLoad = ctrl;
    loadRef.current = ctrl;
    setLoading(true);
    try {
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      const resp = await fetch(signedUrl, { signal: ctrl.signal });
      const buf = await ctx.decodeAudioData(await resp.arrayBuffer());
      // A later click may have superseded this load while we were decoding — bail so we
      // never start a second simultaneous player.
      if (activeLoad !== ctrl) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(ctx.destination);
      src.onended = () => setPlaying(false);
      src.start();
      srcRef.current = src;
      activeStop = stop;
      activeLoad = null;
      loadRef.current = null;
      setPlaying(true);
    } catch {
      // Aborted (superseded by a later click) or a network/decode error — just don't play.
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
