'use client';

// The signature device: the example song's stems as waveform lanes, with the loop bracket
// sized by the chosen loop length. Lanes play in phase via the shared audio engine.
import { useMemo, useState } from 'react';
import { useDemo } from './DemoProvider';
import {
  SILENT_PEAKS,
  STEM_ORDER,
  barRange,
  detectedBpm,
  driftBoundMs,
  DEMO_ALIGNMENT,
  envPath,
  fmtT,
  isSilentStem,
  loopLen,
  setKeyOf,
  startBar,
  stemOf,
  stemStatus,
} from './demo-data';
import { Ic, Wave } from './Icons';

export function Lanes() {
  const { data, status, stems, bars, audio, heroOn, toggleHeroStem, toggleHeroAll, reload, retryAudio } = useDemo();
  const [hearMsg, setHearMsg] = useState('');
  const ready = status === 'ready' && !!data;
  const key = setKeyOf(bars);

  const lanes = useMemo(
    () =>
      data
        ? STEM_ORDER.map((n) => {
            const st = stemOf(data, '8bar', n);
            return { n, silent: isSilentStem(data, n), status: stemStatus(data, n), d: envPath(st ? st.peaks : SILENT_PEAKS) };
          })
        : [],
    [data],
  );
  const song = useMemo(() => (data ? envPath(data.ctx.song.peaks) : ''), [data]);
  const ruler = useMemo(() => {
    if (!data) return null;
    const { start_sec: t0, duration_sec: dur } = data.ctx.loop;
    const barSec = data.ctx.pipeline_grid.bar_sec;
    const barsX = Array.from({ length: 8 }, (_, i) => ({ i, x: `${((i * barSec) / dur) * 100}%`, label: String(startBar(data) + i) }));
    const beats = data.ctx.measured_grid.beat_times_sec
      .filter((t) => t >= t0 - 0.05 && t <= t0 + dur)
      .map((t) => `${Math.max(0, ((t - t0) / dur) * 100).toFixed(3)}%`);
    return { barsX, beats };
  }, [data]);

  // SSR fallbacks = demo v3 at the default 4 bars (no layout jump when the data arrives)
  const sf = data ? data.ctx.loop.start_fraction : 0.57273;
  const ef8 = data ? data.ctx.loop.nested_end_fraction['8bar'] : 0.66077;
  const efKey = data ? data.ctx.loop.nested_end_fraction[key] : 0.61675;
  const bpm = data ? detectedBpm(data) : '102.0';
  const range = data ? barRange(data, bars) : '53–56';
  const time = !data
    ? '0:00 / 0:09'
    : heroOn
      ? `${fmtT(audio.posSec)} / ${fmtT(loopLen(data, key))}`
      : `${fmtT(0)} / ${fmtT(data.loops.sets[key].duration_sec)}`;
  const drift = driftBoundMs(bars);
  const err = audio.heroError;

  const lanesCls = ['lanes', status === 'loading' ? 'is-loading' : '', status === 'failed' ? 'is-failed' : ''].filter(Boolean).join(' ');

  return (
    <section className={lanesCls} id="lanes" aria-label="Sample output: Lucky Ticket by Jon Cartwright">
      <div className="lanes-head">
        <div className="lanes-title">
          <p className="example-label">
            Example: <span className="ex-track">Lucky Ticket</span>
          </p>
          <p className="mono lanes-readout">
            <span id="lanes-readout">
              <span className="tok">{bpm} BPM (detected) ·</span> <span className="tok">{bars === 1 ? "bar" : "bars"} {range} ·</span>
            </span>{' '}
            <span className="tok" id="lanes-time">{time}</span>
          </p>
        </div>
        <button
          type="button"
          className={`btn btn-secondary btn-play${heroOn ? ' is-active' : ''}`}
          id="play-selected"
          disabled={!ready}
          onClick={() => setHearMsg(toggleHeroAll() ? '' : 'Turn on at least one stem under Stems to hear the example.')}
        >
          <Ic name={heroOn ? 'stop' : 'play'} />
          <span>{heroOn ? 'Stop' : 'Hear it'}</span>
        </button>
      </div>

      <div className="lanes-stage" id="lanes-stage">
        <div className="song" aria-hidden="true">
          <span className="song-label mono">
            whole song
            <br />
            <span id="song-dur">{data ? fmtT(Math.round(data.ctx.song.duration_sec)) : '3:34'}</span>
          </span>
          <div className="song-wave" id="song-wave" style={{ '--song-s': `${sf * 100}%`, '--song-e': `${efKey * 100}%` } as React.CSSProperties}>
            {data && (
              <>
                <Wave d={song} />
                <Wave d={song} variant="loop" />
                <div className="song-win" style={{ left: `${sf * 100}%`, width: `${(ef8 - sf) * 100}%` }} />
              </>
            )}
          </div>
        </div>
        <svg className="zoom" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={`${(sf * 100).toFixed(2)},0 ${(ef8 * 100).toFixed(2)},0 100,10 0,10`} />
        </svg>
        <div className="lanes-body" id="lanes-body">
          <div className="ruler" aria-hidden="true">
            {ruler?.barsX.map((b) => (
              <span key={`b${b.i}`} className="bar" style={{ left: b.x }}>
                {b.label}
              </span>
            ))}
            {ruler?.beats.map((x) => <span key={`t${x}`} className="beat" style={{ left: x }} />)}
          </div>
          <div className="lane-list" role="group" aria-label="Stem lanes">
            {lanes.map(({ n, silent, status: st, d }) => {
              const on = heroOn && audio.playing.includes(n);
              const pending = audio.owner === 'hero' && audio.loading.includes(n);
              const cls = ['lane', stems.has(n) ? '' : 'is-off', on ? 'is-on' : '', pending ? 'is-pending' : ''].filter(Boolean).join(' ');
              return (
                <div className={cls} data-stem={n} key={n}>
                  <button
                    type="button"
                    className="lane-btn"
                    data-stem={n}
                    disabled={silent}
                    aria-pressed={silent ? undefined : on}
                    aria-busy={pending ? true : undefined}
                    onClick={silent ? undefined : () => toggleHeroStem(n)}
                  >
                    <Ic name={on ? 'stop' : 'play'} />
                    <span className="nm">
                      {!silent && <span className="sr-only">Play </span>}
                      <span>{n}</span>
                      {(st === 'silent' || st === 'faint') && (
                        <>
                          {' '}
                          <span className="note">{st}</span>
                        </>
                      )}
                    </span>
                  </button>
                  <div className="lane-wave">
                    <Wave d={d} />
                    <Wave d={d} variant="loop" />
                    <Wave d={d} variant="played" />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="overlay" aria-hidden="true">
            <div className="gridlines">
              {ruler?.barsX.slice(1).map((b) => <span key={b.i} style={{ left: b.x }} />)}
            </div>
            <div className="bracket" />
            <div className="playhead" />
          </div>
        </div>
        {status === 'failed' ? (
          <div className="load-error" id="lanes-error" role="alert">
            <Ic name="alert" />
            <p>
              <strong>The sample didn’t load.</strong> <span>The tool still works; only the preview is missing.</span>{' '}
              <button type="button" className="link-btn" onClick={reload}>
                Try again
              </button>
            </p>
          </div>
        ) : err ? (
          <div className="load-error is-inline" id="lanes-error" role="alert">
            <Ic name="alert" />
            <p>
              <strong>{err.fails.length === 1 ? `The ${err.fails[0]} stem` : `${err.fails.length} stems`} didn’t load.</strong>{' '}
              <span>{err.partial ? 'The rest is playing.' : 'Check your connection.'}</span>{' '}
              <button type="button" className="link-btn" onClick={retryAudio}>
                Try again
              </button>
            </p>
          </div>
        ) : null}
      </div>
      <p className="drift" id="lanes-align">
        {`Cut at the detected ${bpm} BPM: this loop starts within about ${DEMO_ALIGNMENT.startWithinMs}\u00a0ms of a measured beat and drifts under ${drift}\u00a0ms per ${bars}\u2011bar repeat (measurement noise). Bar 1 isn’t detected, so it starts on beat 4 of the previous bar; nudge it in your DAW if you need the downbeat.`}
      </p>
      <p className="hint hear-msg" id="hear-msg" aria-live="polite">
        {hearMsg}
      </p>
      <details className="readme" id="readme">
        <summary>How to read this</summary>
        <ul>
          <li>
            One 8&#8209;bar loop from a real stem-loops job, 10 Oct 2026; the 1, 2 and 4&#8209;bar previews are cut from it. Playback is
            an MP3 preview; downloads are 24&#8209;bit WAV.
          </li>
          <li>The top strip is the whole song (3:34). The white part is the loop; the lanes below zoom in on it.</li>
          <li>
            Bar numbers are stem-loops’ own count of 4&#8209;beat bars from the first detected beat, not the song’s bar numbers. The
            small ticks are beats found by an independent beat tracker (Beat This!), at 102.0 BPM.
          </li>
          <li>
            Here the loop starts within about 1 ms of one of those beats, and every bar line inside it is within 3 ms. Across the
            whole song, loop starts were a median 3.5 ms from a measured beat, all within 8 ms.
          </li>
          <li>Bar 1 isn’t detected: this loop starts one beat before the bar line, on beat 4 of the previous bar.</li>
          <li>Each lane is scaled to its own peak, so quiet stems look as tall as loud ones. Keys are silent in this song.</li>
        </ul>
      </details>
    </section>
  );
}
