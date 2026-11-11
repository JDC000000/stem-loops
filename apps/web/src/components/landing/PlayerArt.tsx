// The player, drawn. Three bands on one time axis — the chord ribbon, the six-channel
// mixer rail, the transport with a section loop — each paired with the sentence that
// explains it. This is a PICTURE of what /jobs/[id] opens when a job finishes, not a
// live player: the real one needs a real job, and a fake one on the front door would be
// a claim we can't keep. Static markup, no client JS, no audio.
//
// Faithful to the real components on purpose:
//  - faders are VERTICAL, because Mixer.tsx's are (components/play/Mixer.module.css).
//  - mute AND solo, because the mixer has both.
//  - the loop is a NAMED song section, because SectionLoop.tsx names regions.
//  - six stems in lane order, wearing the same --stem-* hues as everywhere else.
// The chords and the fader positions are drawn, not measured — the caption says so.

import { STEM_ORDER } from './demo-data';

// A plain G-minor turnaround, matching the key the rest of the page reports for the
// example song. It illustrates a chord track; it is not a transcription of anything.
const CHORDS = ['Gm', 'E♭', 'B♭', 'F'];
const NOW = 1;

// Fader positions, 0–100. Guitar is down and muted: that is the whole product in one
// picture — the part you play is the part you turn off.
const LEVELS: Record<string, number> = { drums: 88, bass: 72, vocals: 46, guitar: 10, keys: 58, other: 40 };
const MUTED = new Set(['guitar']);

function ChordRibbon() {
  return (
    <div className="pl-chords">
      {CHORDS.map((c, i) => (
        <span key={c} className={`pl-chord mono${i === NOW ? ' is-now' : ''}`}>
          {c}
        </span>
      ))}
      <span className="pl-playhead" style={{ left: `${((NOW + 0.8) / CHORDS.length) * 100}%` }} />
    </div>
  );
}

function MixerRail() {
  return (
    <div className="pl-rail">
      {STEM_ORDER.map((s) => {
        const lvl = LEVELS[s] ?? 50;
        const muted = MUTED.has(s);
        return (
          <div className={`pl-ch${muted ? ' is-muted' : ''}`} data-stem={s} key={s}>
            <span className="pl-ch-name mono">{s}</span>
            <div className="pl-fader" style={{ '--lvl': `${lvl}%` } as React.CSSProperties}>
              <span className="pl-fader-fill" />
              <span className="pl-cap" />
            </div>
            <span className="pl-toggles mono">
              <span className={`pl-tog${muted ? ' is-on' : ''}`}>M</span>
              <span className="pl-tog">S</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Transport() {
  return (
    <div className="pl-transport">
      <span className="pl-time mono">1:12</span>
      <div className="pl-track">
        <span className="pl-loop">
          <span className="pl-loop-name mono">chorus</span>
        </span>
        <span className="pl-pos" />
      </div>
      <span className="pl-time mono">3:34</span>
    </div>
  );
}

const BANDS = [
  {
    name: 'Chords',
    art: <ChordRibbon />,
    text: 'The chord track moves with the song, so the change arrives on the page before it arrives in your hands.',
  },
  {
    name: 'Stems',
    art: <MixerRail />,
    text: 'Six stems, six faders, each with a mute and a solo. Turn off the part you are playing, or solo it to learn it first.',
  },
  {
    name: 'Section loop',
    art: <Transport />,
    text: 'Mark a verse, a chorus or a stretch you choose, and it repeats until you have it.',
  },
];

export function PlayerArt() {
  return (
    <figure className="player">
      <ul className="pl-bands">
        {BANDS.map((b) => (
          <li className="pl-band" key={b.name}>
            <p className="pl-band-name">{b.name}</p>
            <div className="pl-art" aria-hidden="true">
              {b.art}
            </div>
            <p className="pl-band-text">{b.text}</p>
          </li>
        ))}
      </ul>
      <figcaption className="pl-cap-note">
        An illustration of the player, drawn for this page. The chord names and the fader
        positions are examples, not a recorded result.
      </figcaption>
    </figure>
  );
}
