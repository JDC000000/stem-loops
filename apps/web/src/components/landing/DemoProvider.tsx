'use client';

// Shared state for the landing: the stem / loop-length choice (the form's chips drive the
// example lanes, and a lane tap turns its stem back on), the demo data, and the one audio
// engine. Server-rendered sections sit inside this provider as children.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DEMO_ASSET_BASE } from '@/lib/public-config';
import { DemoAudioEngine, type EngineSnapshot, IDLE_SNAPSHOT } from './audio-engine';
import { type DemoData, STEM_ORDER, isSilentStem, loadDemoData, setKeyOf } from './demo-data';

export type DemoStatus = 'loading' | 'ready' | 'failed';
export type AbChoice = 'before' | 'drums';

interface DemoContextValue {
  stems: ReadonlySet<string>;
  bars: number;
  setStemChecked: (name: string, checked: boolean) => void;
  setBars: (bars: number) => void;
  status: DemoStatus;
  data: DemoData | null;
  reload: () => void;
  audio: EngineSnapshot;
  heroOn: boolean;
  abOn: boolean;
  toggleHeroStem: (name: string) => void;
  /** "Hear it": play every selected, non-silent stem; returns false if none are selected */
  toggleHeroAll: () => boolean;
  toggleAb: (choice: AbChoice) => void;
  switchAb: (choice: AbChoice) => void;
  retryAudio: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function useDemo() {
  const v = useContext(DemoContext);
  if (!v) throw new Error('useDemo must be used inside <DemoProvider>');
  return v;
}

const getServerSnapshot = () => IDLE_SNAPSHOT;

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const engineRef = useRef<DemoAudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new DemoAudioEngine();
  const engine = engineRef.current;
  const audio = useSyncExternalStore(engine.subscribe, engine.getSnapshot, getServerSnapshot);

  const [stems, setStems] = useState<ReadonlySet<string>>(() => new Set(STEM_ORDER));
  const [bars, setBarsState] = useState(2);
  const [status, setStatus] = useState<DemoStatus>('loading');
  const [data, setData] = useState<DemoData | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => () => engine.dispose(), [engine]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadDemoData()
      .then((d) => {
        if (cancelled) return;
        engine.setData(d, DEMO_ASSET_BASE);
        setData(d);
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[demo] sample did not load:', e instanceof Error ? e.message : e);
        setStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [engine, loadNonce]);

  // Layout hooks the CSS reads (kept from the prototype): bracket width, data-failure mode,
  // and which player is running (playhead visibility).
  useEffect(() => {
    document.documentElement.style.setProperty('--region', `${(bars / 8) * 100}%`);
  }, [bars]);
  useEffect(() => {
    document.body.classList.toggle('no-data', status === 'failed');
    return () => document.body.classList.remove('no-data');
  }, [status]);
  const heroOn = audio.owner === 'hero' && audio.playing.length > 0;
  const abOn = audio.owner === 'ab' && audio.playing.length > 0;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('is-playing-hero', heroOn);
    root.classList.toggle('is-playing-ab', abOn);
  }, [heroOn, abOn]);

  const silent = useCallback((n: string) => (data ? isSilentStem(data, n) : true), [data]);

  const setStemChecked = useCallback(
    (name: string, checked: boolean) => {
      const next = new Set(stems);
      if (checked) next.add(name);
      else next.delete(name);
      setStems(next);
      // keep the example in step with the chips while it plays
      if (engine.isOn('hero')) {
        const names = [...engine.playingNames(), ...(checked && !silent(name) ? [name] : [])].filter(
          (n, i, a) => next.has(n) && a.indexOf(n) === i,
        );
        if (names.length) void engine.play('hero', setKeyOf(bars), names);
        else engine.stop();
      }
    },
    [stems, bars, engine, silent],
  );

  const setBars = useCallback(
    (b: number) => {
      setBarsState(b);
      if (engine.isOn('hero')) {
        const names = engine.playingNames();
        engine.stop();
        void engine.play('hero', setKeyOf(b), names);
      }
    },
    [engine],
  );

  const toggleHeroStem = useCallback(
    (n: string) => {
      if (!stems.has(n)) setStems(new Set(Array.from(stems).concat(n)));
      const cur = new Set(engine.heroActive());
      if (cur.has(n)) cur.delete(n);
      else cur.add(n);
      if (!cur.size) engine.stop();
      else void engine.play('hero', setKeyOf(bars), Array.from(cur));
    },
    [stems, bars, engine],
  );

  const toggleHeroAll = useCallback(() => {
    if (engine.isOn('hero')) {
      engine.stop();
      return true;
    }
    const names = STEM_ORDER.filter((n) => stems.has(n) && !silent(n));
    if (!names.length) return false;
    void engine.play('hero', setKeyOf(bars), names);
    return true;
  }, [engine, stems, bars, silent]);

  const toggleAb = useCallback(
    (choice: AbChoice) => {
      if (engine.isOn('ab')) engine.stop();
      else void engine.play('ab', '4bar', [choice]);
    },
    [engine],
  );
  const switchAb = useCallback(
    (choice: AbChoice) => {
      if (engine.isOn('ab')) void engine.play('ab', '4bar', [choice]);
    },
    [engine],
  );

  const value = useMemo<DemoContextValue>(
    () => ({
      stems,
      bars,
      setStemChecked,
      setBars,
      status,
      data,
      reload: () => setLoadNonce((x) => x + 1),
      audio,
      heroOn,
      abOn,
      toggleHeroStem,
      toggleHeroAll,
      toggleAb,
      switchAb,
      retryAudio: () => engine.retry(),
    }),
    [stems, bars, setStemChecked, setBars, status, data, audio, heroOn, abOn, toggleHeroStem, toggleHeroAll, toggleAb, switchAb, engine],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
