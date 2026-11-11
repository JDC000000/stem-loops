'use client';

/**
 * The /loops body. Pick a song you have already separated, ask for loops, get
 * them.
 *
 * THE ONE RULE THIS COMPONENT EXISTS TO KEEP: no audio is fetched, decoded,
 * sliced or encoded until the viewer presses "Cut loops". Everything above that
 * button — the four banks, the durations, the file sizes — is arithmetic over
 * the song's BPM (lib/loops/plan.ts), so the idle state costs one small JSON
 * request and nothing else. `test/loops-page.test.mjs` counts the loader's
 * calls before and after the click, so the rule is gated by behaviour rather
 * than by this comment.
 *
 * WHERE THE AUDIO COMES FROM, said plainly because it is the honest limit of
 * this page. The loops are cut from the OPUS PLAYBACK STEMS that the mixer
 * already streams (`GET /api/jobs/:id/stems`), not from the 24-bit WAVs the
 * worker cuts. 24-bit is therefore the container's precision, not the
 * recording's, and the page says so rather than implying studio provenance.
 * Cutting pipeline-grade loops on demand needs the WORKER to do the work, and
 * the worker has no way to be asked — see the PR body for why that needs a
 * migration and is deliberately not in this change.
 *
 * WHY THE SONG PICKER READS THIS BROWSER'S HISTORY AND THE NAV DOES NOT.
 * components/chrome/SignedInChrome.tsx sets out why the nav must never resolve
 * a job from the history cookie: that store is per-BROWSER and the bar is
 * per-SESSION, so on a shared machine it pointed one account's nav at another
 * account's job. None of that applies here. The nav links to /loops with no id
 * at all; this page then offers the ids this browser knows about as a
 * CONVENIENCE the viewer picks from explicitly, beside a field for pasting any
 * job link. Nothing is auto-selected and nothing is claimed to be "yours".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getHistoryEntries } from '@/lib/history';
import { loadStems } from '@/lib/play/load-stems';
import { PLAYABLE_STEMS, PLAYBACK_SAMPLE_RATE, type StemName } from '@/lib/play/types';
import {
  banksOf,
  downbeatAnchorSec,
  formatBytes,
  formatSeconds,
  planLoops,
  slug,
  type LoopSpec,
} from '@/lib/loops/plan';
import { cutPlan, downmixToMono, type CutLoop, type DecodedStem } from '@/lib/loops/cut';
import { formatExpiresIn, RETENTION_MS } from '@/lib/retention';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of `GET /api/jobs/:id` this page reads. Extra columns are ignored. */
export interface JobSummary {
  readonly id: string;
  readonly status: string;
  readonly bpm?: number | string | null;
  readonly musical_key?: string | null;
  readonly original_filename?: string | null;
  readonly expires_at?: string | null;
  readonly loops?: readonly { start_sec?: number | string | null; start_bar?: number | string | null }[] | null;
}

/** Decoded PCM for one stem, as the cutter wants it. */
export interface DecodedBytes {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
}

/**
 * Everything this component reaches outside itself, in one object so a test can
 * replace it. The defaults below are the production implementations; nothing
 * else is injectable, so a green test is a test of the real component.
 */
export interface LoopsDeps {
  listSongs(): { id: string; at: number }[];
  fetchJob(id: string, signal?: AbortSignal): Promise<JobSummary>;
  fetchStems(id: string, signal?: AbortSignal): Promise<{ name: StemName; bytes: ArrayBuffer }[]>;
  decode(bytes: ArrayBuffer): Promise<DecodedBytes>;
  objectUrl(bytes: ArrayBuffer): string;
  revokeUrl(url: string): void;
}

async function defaultFetchJob(id: string, signal?: AbortSignal): Promise<JobSummary> {
  const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(res.status === 404 ? 'NOT_FOUND' : `HTTP ${res.status}`);
  return (await res.json()) as JobSummary;
}

async function defaultFetchStems(id: string, signal?: AbortSignal) {
  const { sources } = await loadStems(id, { signal });
  return sources.map((s) => ({ name: s.name, bytes: s.bytes }));
}

/**
 * Decode with the browser's own codec.
 *
 * A fresh AudioContext per call would be wrong — browsers cap how many may
 * exist — so one is made lazily and reused. `decodeAudioData` DETACHES the
 * buffer it is handed, which would strand the caller's bytes, so it is given a
 * copy; the engine does the same for the same reason (lib/play/engine.ts).
 */
let sharedCtx: AudioContext | null = null;
async function defaultDecode(bytes: ArrayBuffer): Promise<DecodedBytes> {
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('NO_WEB_AUDIO');
  if (!sharedCtx) sharedCtx = new Ctor({ sampleRate: PLAYBACK_SAMPLE_RATE });
  const decoded = await sharedCtx.decodeAudioData(bytes.slice(0));
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
  // Mono, before anything else holds a reference to the stereo pair. See
  // downmixToMono for the measured memory reason and for why the plan's size
  // figures depend on it.
  return { channels: downmixToMono(channels), sampleRate: decoded.sampleRate };
}

export const productionDeps: LoopsDeps = {
  listSongs: () => getHistoryEntries(),
  fetchJob: defaultFetchJob,
  fetchStems: defaultFetchStems,
  decode: defaultDecode,
  objectUrl: (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

type Phase = 'idle' | 'cutting' | 'ready';

/** A cut loop with the href its Download control points at. */
interface Downloadable {
  readonly cut: CutLoop;
  readonly url: string;
}

export default function LoopsView({ deps = productionDeps }: { deps?: LoopsDeps }) {
  const [songs, setSongs] = useState<{ id: string; at: number }[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [job, setJob] = useState<JobSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [cutError, setCutError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Downloadable[]>([]);
  const urlsRef = useRef<string[]>([]);

  // The history store is localStorage, which only exists in the browser, so it
  // is read in an effect rather than during render — the same shape as
  // app/history/page.tsx.
  useEffect(() => {
    setSongs(deps.listSongs());
  }, [deps]);

  const releaseUrls = useCallback(() => {
    for (const u of urlsRef.current) deps.revokeUrl(u);
    urlsRef.current = [];
  }, [deps]);

  // Object URLs are a document-lifetime leak if nothing revokes them, and this
  // page can make 24 of them per cut.
  useEffect(() => releaseUrls, [releaseUrls]);

  // Selecting a different song throws away whatever was cut from the last one:
  // leaving 24 cards from song A on screen under song B's heading is the kind
  // of stale view that gets downloaded and only noticed in a DAW.
  useEffect(() => {
    releaseUrls();
    setDownloads([]);
    setPhase('idle');
    setCutError(null);
    setJob(null);
    setLoadError(null);
    if (!jobId) return;
    const ac = new AbortController();
    let stopped = false;
    deps
      .fetchJob(jobId, ac.signal)
      .then((j) => {
        if (!stopped) setJob(j);
      })
      .catch((e: unknown) => {
        if (!stopped) setLoadError(e instanceof Error ? e.message : 'FAILED');
      });
    return () => {
      stopped = true;
      ac.abort();
    };
  }, [jobId, deps, releaseUrls]);

  const bpm = job ? Number(job.bpm) : NaN;
  const title = job?.original_filename ?? null;

  /**
   * The plan. Built at the PLAYBACK sample rate because that is the rate the
   * Opus stems decode at, so the sizes shown before the cut are the sizes the
   * files actually have. Recomputed only when the song changes.
   */
  const plan: LoopSpec[] = useMemo(() => {
    if (!job || job.status !== 'done' || !Number.isFinite(bpm)) return [];
    try {
      return planLoops({
        bpm,
        anchorSec: downbeatAnchorSec(job.loops ?? [], bpm),
        sampleRate: PLAYBACK_SAMPLE_RATE,
        channels: 1,
        title,
        musicalKey: job.musical_key,
      });
    } catch {
      return [];
    }
  }, [job, bpm, title]);

  const onCut = useCallback(async () => {
    if (!jobId || plan.length === 0) return;
    setPhase('cutting');
    setCutError(null);
    try {
      const raw = await deps.fetchStems(jobId);
      if (raw.length === 0) throw new Error('NO_STEMS');
      const decoded: DecodedStem[] = [];
      // Sequentially, not in parallel: concurrent decodeAudioData is what
      // jetsams iOS (WebKit bug 227636, cited in lib/play/engine.ts), and six
      // whole-track buffers is already the memory peak this app runs near.
      for (const s of raw) {
        const d = await deps.decode(s.bytes);
        decoded.push({ name: s.name, channels: d.channels, sampleRate: d.sampleRate });
      }
      const cuts = cutPlan(decoded, plan);
      if (cuts.length === 0) throw new Error('NO_LOOPS');
      const made = cuts.map((cut) => {
        const url = deps.objectUrl(cut.bytes);
        urlsRef.current.push(url);
        return { cut, url };
      });
      setDownloads(made);
      setPhase('ready');
    } catch (e: unknown) {
      setCutError(e instanceof Error ? e.message : 'CUT_FAILED');
      setPhase('idle');
    }
  }, [jobId, plan, deps]);

  const onHide = useCallback(() => {
    releaseUrls();
    setDownloads([]);
    setPhase('idle');
  }, [releaseUrls]);

  const onZip = useCallback(async () => {
    if (downloads.length === 0) return;
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const d of downloads) zip.file(d.cut.spec.filename, d.cut.bytes);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(title)}-loops.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [downloads, title]);

  const banks = banksOf(phase === 'ready' ? downloads.map((d) => d.cut.spec) : plan);
  const urlOf = new Map(downloads.map((d) => [d.cut.spec.id, d.url]));
  const cutOf = new Map(downloads.map((d) => [d.cut.spec.id, d.cut]));
  const rate = downloads[0]?.cut.sampleRate ?? PLAYBACK_SAMPLE_RATE;

  return (
    <main className="lp-wrap">
      <header className="lp-head">
        <h1 className="lp-h1">Download loops</h1>
        <p className="lp-lede">
          Bar-length loops cut from a song you have already separated — one 24-bit WAV per loop,
          named by stem, bar count, tempo and key estimate. For building a sample folder rather
          than playing along.
        </p>
        <p className="lp-note">
          <strong>Loops are cut only when you ask.</strong> They are not made for every song, so
          nothing is produced that nobody wants. Ask any time in the 24 hours after a song
          finishes; after that the audio is deleted and the song has to be run again.
        </p>
      </header>

      <section className="lp-songs" aria-labelledby="lp-songs-h">
        <h2 id="lp-songs-h" className="lp-h2">
          Your songs
        </h2>
        {songs.length === 0 ? (
          <p className="lp-muted">
            No songs on this browser yet.{' '}
            <a href="/" className="lp-link">
              Separate a song →
            </a>
          </p>
        ) : (
          <ul className="lp-song-list">
            {songs.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="lp-song"
                  aria-pressed={jobId === s.id}
                  onClick={() => setJobId(s.id)}
                >
                  <span className="lp-song-id">{s.id}</span>
                  <span className="lp-song-clock">expires {formatExpiresIn(s.at + RETENTION_MS)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="lp-paste"
          onSubmit={(e) => {
            e.preventDefault();
            const found = paste.trim().match(UUID_RE) ?? paste.trim().match(/[0-9a-f-]{36}/i);
            if (found) setJobId(found[0].toLowerCase());
          }}
        >
          <label className="lp-paste-label" htmlFor="lp-paste-input">
            Or paste a song link
          </label>
          <div className="lp-paste-row">
            <input
              id="lp-paste-input"
              className="lp-input"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="https://stem-loops.com/jobs/…"
              spellCheck={false}
            />
            <button type="submit" className="lp-secondary">
              Use it
            </button>
          </div>
        </form>
      </section>

      {jobId && (
        <section className="lp-job" aria-labelledby="lp-job-h">
          <h2 id="lp-job-h" className="lp-h2">
            {title ?? jobId}
          </h2>

          {loadError ? (
            <p className="lp-error" role="status">
              {loadError === 'NOT_FOUND'
                ? 'That song is gone — audio is deleted 24 hours after a song is run.'
                : 'We could not read that song just now. Try again in a moment.'}
            </p>
          ) : !job ? (
            <p className="lp-muted">Loading…</p>
          ) : job.status !== 'done' ? (
            <p className="lp-muted" role="status">
              That song is still {job.status}. Loops can be cut once it has finished —{' '}
              <a href={`/jobs/${jobId}`} className="lp-link">
                watch it in the player →
              </a>
            </p>
          ) : plan.length === 0 ? (
            <p className="lp-error" role="status">
              We could not read a usable tempo for that song, so there is no bar grid to cut
              against.
            </p>
          ) : (
            <>
              <p className="lp-meta" data-testid="lp-summary">
                {plan.length} loops · {new Set(plan.map((s) => s.stem)).size} stems · 1, 2, 4 and 8
                bars · 24-bit WAV, {Math.round(rate / 1000)} kHz · {Math.round(bpm)} BPM
                {job.musical_key ? ` · ${job.musical_key}` : ''}
              </p>
              <p className="lp-provenance">
                Cut in your browser from this song&apos;s playback stems, so nothing is made on our
                side until you ask — and nothing is kept afterwards.
              </p>

              <div className="lp-actions">
                {phase === 'ready' ? (
                  <>
                    <button type="button" className="lp-primary" onClick={onZip}>
                      Download all (ZIP)
                    </button>
                    <button type="button" className="lp-secondary" onClick={onHide}>
                      Hide loops
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="lp-primary"
                    onClick={onCut}
                    disabled={phase === 'cutting'}
                    aria-busy={phase === 'cutting'}
                  >
                    {phase === 'cutting' ? 'Cutting…' : 'Cut loops'}
                  </button>
                )}
              </div>

              {phase === 'idle' && (
                <p className="lp-muted" data-testid="lp-not-cut" role="status">
                  Not cut yet.
                </p>
              )}
              {cutError && (
                <p className="lp-error" role="status">
                  {cutError === 'NO_STEMS'
                    ? 'This song has no playback stems, so there is nothing to cut from.'
                    : 'Cutting failed partway through. Try again.'}
                </p>
              )}

              {banks.map((bank) => (
                <section className="lp-bank" key={bank.bars} aria-label={`${bank.bars}-bar loops`}>
                  <h3 className="lp-h3">
                    {bank.bars} {bank.bars === 1 ? 'bar' : 'bars'}
                    <span className="lp-bank-meta">
                      {formatSeconds(bank.specs[0].durationSec)} ·{' '}
                      {formatBytes(bank.specs[0].byteLength)}
                    </span>
                  </h3>
                  <div className="lp-grid">
                    {bank.specs.map((spec) => {
                      const url = urlOf.get(spec.id);
                      const cut = cutOf.get(spec.id);
                      // Once a loop exists, its size is MEASURED off the file
                      // rather than re-read from the plan. The plan assumes the
                      // playback rate; a browser that decodes at some other
                      // rate would otherwise be shown a figure its download
                      // does not match.
                      const bytes = cut ? cut.bytes.byteLength : spec.byteLength;
                      return (
                        <article className="lp-card" key={spec.id} data-stem={spec.stem}>
                          <div className="lp-card-head">
                            <span className="lp-stem">{spec.stem}</span>
                            <span className="lp-card-meta">
                              {formatSeconds(spec.durationSec)} · {formatBytes(bytes)}
                            </span>
                          </div>
                          <div className="lp-wave" role="img" aria-label={`${spec.stem} loop`}>
                            {(cut?.peaks ?? []).map((p, i) => (
                              // eslint-disable-next-line react/no-array-index-key
                              <span key={i} className="lp-bar" style={{ height: `${Math.max(2, p * 100)}%` }} />
                            ))}
                          </div>
                          {url ? (
                            <a className="lp-download" href={url} download={spec.filename}>
                              Download
                            </a>
                          ) : (
                            <span className="lp-download lp-download-idle" aria-disabled="true">
                              Not cut yet
                            </span>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </>
          )}
        </section>
      )}

      <footer className="lp-foot">
        <p className="lp-muted">
          Nothing here you want?{' '}
          <a href="/" className="lp-link">
            Run a new song →
          </a>{' '}
          It opens in the player, and its loops stay available here for 24 hours.
        </p>
        <p className="lp-muted">
          Loops are free to use in your own music. Splitting a song does not change who owns it —
          see the{' '}
          <a href="/terms" className="lp-link">
            terms
          </a>
          .
        </p>
      </footer>
    </main>
  );
}

/** Re-exported so a test can assert the page offers every stem it claims to. */
export const OFFERED_STEMS: readonly StemName[] = PLAYABLE_STEMS;
