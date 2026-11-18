'use client';

// The home page's LIVE play-along demo (Slice 2a; design v1.5 P4.1 item 2, P4.2; mockup
// Home.dc.html "Try it now · no account needed"). Signed out works (DB-12a).
//
// LOADING (P4.2): nothing loads until Play is tapped. Until then this is a static poster
// rendered from lib/demo-catalog.ts — no database call, no audio, no player code: the
// player is a separate chunk (a dynamic `import()`, which the bundler splits out) fetched
// on the tap, in parallel with the id lookup. The tap then asks
// GET /api/demos for the demo's job id (cacheable, no credential) and opens the REAL player
// (JobView → Player, the Slice 1a screen) over the page. Audio comes from the demo job's
// own stems through the public demo read path (lib/job-access.ts), because the static demo
// host carries only the old loop-cut files, not stems or chords (the P4.2 export was not
// done; TSD-V3-DELTA §12.11).
//
// The player is a fixed, full-screen layer on purpose: on a phone it IS the P1 screen,
// which was designed to fit 390×844 and 360×800 portrait without turning the phone. Its
// back arrow closes the layer in place and returns focus to the Play button.
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { DEMO_SONGS, demoHref, type DemoSong } from '@/lib/demo-catalog';
import { CHORDS_LINE_SHOWN } from '@/lib/chords-claim';
import { Ic } from './Icons';

type LayerComponent = ComponentType<{ jobId: string; onClose: () => void }>;

/** What GET /api/demos returns per song (lib/demo-songs.ts DemoJob). */
interface ApiDemo {
  readonly id: string;
  readonly slug: string | null;
}

type State =
  | { readonly kind: 'poster' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'open'; readonly jobId: string }
  | { readonly kind: 'error' };

export const DEMO_KICKER = 'Try it now · no account needed';
export const DEMO_ERROR = 'The demo song didn’t load. Check your connection and try again.';

/**
 * Which demo job to open for the chosen song: the catalogued row for its slug, or — when
 * that song is not available (e.g. a test stack whose demo row is not one of the three) —
 * the first playable demo. Null when there is none.
 */
export function pickDemoJob(demos: readonly ApiDemo[], slug: string): string | null {
  return (demos.find((d) => d.slug === slug) ?? demos[0])?.id ?? null;
}

export function factsLine(song: DemoSong): string {
  return `${song.artist} · ${song.bpm} BPM · ${song.musicalKey}`;
}

export function HomeDemo() {
  const [chosen, setChosen] = useState<DemoSong>(DEMO_SONGS[0]);
  const [state, setState] = useState<State>({ kind: 'poster' });
  const [Layer, setLayer] = useState<LayerComponent | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);

  const open = useCallback(async () => {
    setState({ kind: 'opening' });
    try {
      const [mod, res] = await Promise.all([import('./DemoPlayerLayer'), fetch('/api/demos')]);
      const body = (await res.json().catch(() => null)) as { demos?: ApiDemo[] } | null;
      const id = res.ok && body?.demos ? pickDemoJob(body.demos, chosen.slug) : null;
      // A component goes into state through the updater form, or React would call it.
      setLayer(() => mod.default);
      setState(id ? { kind: 'open', jobId: id } : { kind: 'error' });
    } catch {
      setState({ kind: 'error' });
    }
  }, [chosen.slug]);

  const close = useCallback(() => {
    restoreFocus.current = true;
    setState({ kind: 'poster' });
  }, []);

  useEffect(() => {
    if (state.kind === 'poster' && restoreFocus.current) {
      restoreFocus.current = false;
      playRef.current?.focus();
    }
  }, [state.kind]);

  const busy = state.kind === 'opening';
  return (
    <section className="hero-demo" id="demo" aria-labelledby="demo-h" data-testid="home-demo">
      <p className="demo-kicker">{DEMO_KICKER}</p>
      <h2 id="demo-h" className="demo-title" data-testid="home-demo-title">
        {chosen.title}
      </h2>
      <p className="demo-facts mono" data-testid="home-demo-facts">
        {factsLine(chosen)}
      </p>
      <div className="demo-songs" role="group" aria-label="Demo songs">
        {DEMO_SONGS.map((s) => (
          <button
            key={s.slug}
            type="button"
            className="demo-song"
            aria-pressed={s.slug === chosen.slug}
            data-testid={`home-demo-song-${s.slug}`}
            onClick={() => setChosen(s)}
          >
            {s.title}
          </button>
        ))}
      </div>
      <button
        ref={playRef}
        type="button"
        className="btn btn-secondary btn-play demo-play"
        data-testid="home-demo-play"
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={open}
      >
        <Ic name="play" />
        {busy ? 'Opening the player…' : 'Play along'}
      </button>
      <p className="demo-note">
        {/* Every chord claim on the home page hangs on the one DB-17 switch (lib/chords-claim.ts). */}
        {CHORDS_LINE_SHOWN ? 'The real player: chords in time, mute any part, loop a section.' : 'The real player: mute any part, loop a section.'}{' '}
        <a href={demoHref(chosen.slug)}>Open it on its own page</a>
      </p>
      {state.kind === 'error' ? (
        <p className="demo-error" role="alert" data-testid="home-demo-error">
          {DEMO_ERROR}
        </p>
      ) : null}
      {state.kind === 'open' && Layer ? <Layer jobId={state.jobId} onClose={close} /> : null}
    </section>
  );
}
