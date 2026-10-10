'use client';

// The landing's one input: a link field, "Choose a file", and drop-anywhere-on-the-hero.
// Submit runs the real flow (same as the old home page): file → POST /api/uploads (presign)
// → PUT straight to R2 (putToR2, with its retries) → POST /api/jobs; link → POST /api/jobs.
// Validation, rate limits, admission and error codes all stay server-side in those routes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPT_ATTR, validateUpload } from '@/lib/upload';
import { putToR2 } from '@/lib/upload-client';
import { canonicalizeYoutubeUrl, youtubeUrlProblem } from '@/lib/youtube-url';
import { addToHistory } from '@/lib/history';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import { useDemo } from './DemoProvider';
import { BAR_OPTIONS, STEM_ORDER } from './demo-data';
import { Ic } from './Icons';

const ERR = {
  empty_input: ['Add a song first.', 'Paste a YouTube link or choose a file.'],
  url: ['That isn’t a YouTube video link.', 'Paste the full address from youtube.com or youtu.be, or upload a file.'],
  playlist: ['That’s a playlist link.', 'Open one video from it and paste that link.'],
  channel: ['That’s a channel, not a video.', 'Open one video and paste its link.'],
  other: ['Only YouTube links work here.', 'For anything else, upload the audio file.'],
  yt_off: ['YouTube links are paused right now.', 'Upload the audio file instead.'],
  type: ['We can’t use that file type.', 'Choose mp3, wav, m4a, aac, flac, ogg, opus, aiff, mp4, m4v, mov or webm.'],
  empty: ['That file is empty.', 'Choose a different one.'],
  large: ['That file is over the 200 MB limit.', 'Export a shorter or compressed version (mp3 or m4a) and try again.'],
} as const;
type ErrCode = keyof typeof ERR;

const STAGES = ['sending', 'downloading', 'separating', 'extracting', 'uploading'] as const;
type Stage = (typeof STAGES)[number];

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; isFile: boolean; now: Stage | null; done: Stage | null; pct: number; label: string; msg: string }
  | { kind: 'done'; jobId: string }
  | { kind: 'failed'; head: string; body: string };

class ApiError extends Error {}

// "5 MB" / "200 MB" (no ".0"); one decimal under 10 MB.
function fmtSize(b: number): string {
  const mb = b / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('We couldn’t reach stem-loops. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.message ?? 'Something went wrong on our side. Please try again.');
  return json as T;
}

export function ToolForm() {
  const { stems, bars, setStemChecked, setBars } = useDemo();
  const formRef = useRef<HTMLFormElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const firstStemRef = useRef<HTMLInputElement>(null);
  const jobLinkRef = useRef<HTMLAnchorElement>(null);
  const focusNext = useRef<'source' | 'replace' | 'stem' | 'job' | null>(null);

  const [text, setText] = useState('');
  const [file, setFileState] = useState<File | null>(null);
  const [err, setErr] = useState<{ code: ErrCode; suffix?: string } | null>(null);
  const [stemsErr, setStemsErr] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [live, setLive] = useState('');
  const [narrow, setNarrow] = useState(false);
  const busy = phase.kind === 'busy';

  // focus after the DOM reflects the new state (e.g. the picked-file row now exists)
  useEffect(() => {
    const f = focusNext.current;
    focusNext.current = null;
    if (f === 'source') sourceRef.current?.focus();
    else if (f === 'replace') replaceRef.current?.focus();
    else if (f === 'stem') firstStemRef.current?.focus();
    else if (f === 'job') jobLinkRef.current?.focus();
  });

  const resetJob = useCallback(() => setPhase((p) => (p.kind === 'busy' ? p : { kind: 'idle' })), []);

  const setFile = useCallback(
    (f: File | null) => {
      if (busy) return;
      setErr(null);
      resetJob();
      if (fileRef.current) fileRef.current.value = '';
      if (!f) {
        setFileState(null);
        return;
      }
      const v = validateUpload(f.name, f.size);
      if (!v.ok) {
        // keep the previous valid file (if any) and say why the new one was refused
        const code: ErrCode = v.error_code === 'UPLOAD_TOO_LARGE' ? 'large' : f.size <= 0 ? 'empty' : 'type';
        setErr({ code, suffix: file ? ` Still using ${file.name}.` : undefined });
        focusNext.current = file ? 'replace' : 'source';
        return;
      }
      setFileState(f);
      setText('');
      setLive(`File chosen: ${f.name}, ${fmtSize(f.size)}`);
      focusNext.current = 'replace';
    },
    [busy, file, resetJob],
  );

  // Drop: the hero takes files (or a dragged link); the rest of the page never navigates away.
  useEffect(() => {
    const hero = formRef.current?.closest('.hero');
    if (!hero) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    const onDocOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDocDrop = (e: DragEvent) => {
      if (hasFiles(e) && !hero.contains(e.target as Node)) e.preventDefault();
    };
    const onEnter = (e: Event) => {
      if (hasFiles(e as DragEvent)) {
        depth++;
        setDragging(true);
      }
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onDrop = (ev: Event) => {
      const e = ev as DragEvent;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files[0]) setFile(dt.files[0]);
      else {
        const t = dt.getData('text/uri-list') || dt.getData('text/plain');
        if (t && !busy) {
          setFileState(null);
          setText(t.trim());
          setErr(null);
          resetJob();
        }
      }
    };
    document.addEventListener('dragover', onDocOver);
    document.addEventListener('drop', onDocDrop);
    hero.addEventListener('dragenter', onEnter);
    hero.addEventListener('dragleave', onLeave);
    hero.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDocOver);
      document.removeEventListener('drop', onDocDrop);
      hero.removeEventListener('dragenter', onEnter);
      hero.removeEventListener('dragleave', onLeave);
      hero.removeEventListener('drop', onDrop);
    };
  }, [setFile, busy, resetJob]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 359px)');
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const orderedStems = STEM_ORDER.filter((s) => stems.has(s));
  const n = orderedStems.length;
  const stemTxt = `${n}${n === 1 ? ' stem' : ' stems'}`;
  const showStemsErr = stemsErr && n === 0;

  async function runJob(canonicalUrl: string | null) {
    const isFile = !!file;
    const base = { isFile, done: null, pct: 0 } as const;
    try {
      let jobId: string;
      if (file) {
        const sending = (pct: number) =>
          setPhase({ kind: 'busy', ...base, now: 'sending', pct, label: `Sending file… ${pct}%`, msg: `Sending ${file.name}. Keep this tab open.` });
        sending(0);
        const pres = await postJson<{ jobId: string; key: string; uploadUrl: string; contentType: string }>('/api/uploads', {
          filename: file.name,
          size: file.size,
        });
        try {
          await putToR2(pres.uploadUrl, file, pres.contentType, sending);
        } catch (e) {
          setPhase({ kind: 'failed', head: 'The upload didn’t finish.', body: e instanceof Error ? e.message : 'Please try again.' });
          return;
        }
        setPhase({ kind: 'busy', ...base, now: null, done: 'sending', pct: 100, label: 'Starting…', msg: 'File sent. Starting your job…' });
        const job = await postJson<{ id: string }>('/api/jobs', {
          jobId: pres.jobId,
          uploadKey: pres.key,
          filename: file.name,
          stems: orderedStems,
          loop_length_bars: bars,
        });
        jobId = job.id;
      } else {
        setPhase({ kind: 'busy', ...base, now: null, pct: 100, label: 'Starting…', msg: 'Starting your job…' });
        const job = await postJson<{ id: string }>('/api/jobs', { url: canonicalUrl, stems: orderedStems, loop_length_bars: bars });
        jobId = job.id;
      }
      addToHistory(jobId);
      setPhase({ kind: 'done', jobId });
      focusNext.current = 'job';
      // Full navigation (not router.push): the job page has its own styles, and the
      // landing's stylesheet must not follow it there.
      window.location.assign(`/jobs/${jobId}`);
    } catch (e) {
      setPhase({
        kind: 'failed',
        head: 'We couldn’t start that job.',
        body: e instanceof Error ? e.message : 'Something went wrong. Please try again.',
      });
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const t = text.trim();
    if (!file && !t) {
      setErr({ code: 'empty_input' });
      focusNext.current = 'source';
      setPhase({ kind: 'idle' });
      return;
    }
    if (!n) {
      setOptionsOpen(true);
      setStemsErr(true);
      focusNext.current = 'stem';
      setPhase((p) => (p.kind === 'failed' ? p : { kind: 'idle' }));
      return;
    }
    let canonical: string | null = null;
    if (!file) {
      canonical = canonicalizeYoutubeUrl(t);
      if (!canonical) {
        setPhase({ kind: 'idle' });
        setErr({ code: youtubeUrlProblem(t) });
        focusNext.current = 'source';
        return;
      }
      if (!YOUTUBE_INPUT_ENABLED) {
        setPhase({ kind: 'idle' });
        setErr({ code: 'yt_off' });
        focusNext.current = 'source';
        return;
      }
    }
    setErr(null);
    void runJob(canonical);
  }

  function cutAnother() {
    setPhase({ kind: 'idle' });
    setFileState(null);
    setText('');
    focusNext.current = 'source';
  }

  const ctaLabel = phase.kind === 'busy' ? phase.label : phase.kind === 'failed' ? 'Try again' : 'Cut loops';
  const errText = err ? ERR[err.code] : null;
  const formCls = ['tool', err ? 'is-invalid' : '', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ');

  return (
    <form id="tool" ref={formRef} className={formCls} noValidate autoComplete="off" aria-label="stem-loops tool" tabIndex={-1} onSubmit={onSubmit}>
      <div className="field">
        <div className="label-row">
          <label htmlFor="source" className="label">Link or file</label>
          <span className="drop-hint" aria-hidden="true">or drop a file here</span>
        </div>
        <div className="source" id="source-wrap" hidden={!!file}>
          <input
            id="source"
            ref={sourceRef}
            name="source"
            type="text"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={narrow ? 'YouTube link' : 'Paste a YouTube link'}
            aria-describedby="source-help source-error"
            aria-invalid={err ? true : undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setErr(null);
              resetJob();
            }}
          />
          <button type="button" id="file-btn" className="btn btn-secondary btn-field" onClick={() => fileRef.current?.click()}>
            <Ic name="file" />
            <span>Choose a file</span>
          </button>
          <input
            type="file"
            id="file"
            ref={fileRef}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept={ACCEPT_ATTR}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
            }}
          />
        </div>
        <div className="picked" id="picked" hidden={!file}>
          <Ic name="file" />
          <span className="picked-text">
            <span className="picked-name" id="picked-name">{file?.name}</span>
            <span className="mono" id="picked-meta">{file ? fmtSize(file.size) : ''}</span>
          </span>
          <button type="button" className="btn btn-ghost" id="picked-replace" ref={replaceRef} onClick={() => fileRef.current?.click()}>
            Replace
          </button>
          <button
            type="button"
            className="btn btn-icon"
            id="picked-clear"
            aria-label="Remove file"
            onClick={() => {
              setFile(null);
              setLive('File removed');
              focusNext.current = 'source';
            }}
          >
            <Ic name="x" />
          </button>
        </div>
        <p className="sr-only" id="picked-live" aria-live="polite">{live}</p>
        <p className="hint" id="source-help">A public YouTube link, or an audio or video file up to 200&nbsp;MB.</p>
        <p className="error" id="source-error" role="alert" hidden={!errText}>
          <Ic name="alert" />
          <span>
            <strong>{errText?.[0]}</strong> <span>{errText ? errText[1] + (err?.suffix ?? '') : ''}</span>
          </span>
        </p>
      </div>

      <button
        type="button"
        className="options-toggle"
        id="options-toggle"
        aria-expanded={optionsOpen}
        aria-controls="options"
        onClick={() => setOptionsOpen((o) => !o)}
      >
        <span className="mono" id="options-summary">{`${n ? stemTxt : 'No stems'} · ${bars}-bar loops`}</span>
        <span className="options-change">
          Change <Ic name="chev" />
        </span>
      </button>

      <div className="options" id="options">
        <fieldset className="group" id="stems-group">
          <legend className="label">Stems</legend>
          <div className="chips chips-3">
            {STEM_ORDER.map((s, i) => (
              <label className="chip" key={s}>
                <input
                  type="checkbox"
                  name="stem"
                  value={s}
                  ref={i === 0 ? firstStemRef : undefined}
                  checked={stems.has(s)}
                  aria-describedby={s === 'other' ? 'other-hint' : undefined}
                  onChange={(e) => setStemChecked(s, e.target.checked)}
                />
                <span className="chip-face">
                  <Ic name="check" className="chip-check" />
                  {s}
                </span>
              </label>
            ))}
          </div>
          <p className="hint hint-tight other-hint" id="other-hint">Other: whatever is left after the five.</p>
          <p className="error" id="stems-error" role="alert" hidden={!showStemsErr}>
            <Ic name="alert" />
            <span>
              <strong>Pick at least one stem.</strong> Tap any stem above.
            </span>
          </p>
        </fieldset>

        <fieldset className="group" id="length-group">
          <legend className="label">Loop length</legend>
          <div className="seg seg-4" id="len-seg">
            {BAR_OPTIONS.map((b) => (
              <label className="seg-opt" key={b}>
                <input type="radio" name="bars" value={b} checked={bars === b} onChange={() => setBars(b)} />
                <span>{b === 1 ? '1 bar' : `${b} bars`}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <p className="readout mono sr-only" id="readout" aria-live="polite">
        {n ? `${stemTxt} × ${bars}-bar loops, up to 10 per stem` : 'No stems selected'}
      </p>

      <button
        type="submit"
        id="cta"
        className="btn btn-primary btn-cta"
        hidden={phase.kind === 'done'}
        aria-busy={busy ? true : undefined}
        style={busy ? ({ '--progress': `${phase.pct}%` } as React.CSSProperties) : undefined}
      >
        <span className="cta-fill" aria-hidden="true" />
        <span className="cta-label" id="cta-label">{ctaLabel}</span>
      </button>

      <div className="job" id="job" hidden={phase.kind === 'idle'}>
        <ol className="job-stages mono" id="job-stages" aria-label="Job stages" hidden={phase.kind === 'done'}>
          {STAGES.map((s, i) => {
            const isFile = phase.kind === 'busy' && phase.isFile;
            const cur = phase.kind === 'busy' && phase.now ? STAGES.indexOf(phase.now) : -1;
            const doneIdx = phase.kind === 'busy' && phase.done ? STAGES.indexOf(phase.done) : -1;
            const cls = [i < cur || i <= doneIdx ? 'is-done' : '', i === cur ? 'is-now' : ''].filter(Boolean).join(' ');
            return (
              <li key={s} data-stage={s} className={cls || undefined} hidden={s === 'sending' && !isFile}>
                {s[0].toUpperCase() + s.slice(1)}
              </li>
            );
          })}
        </ol>
        <div
          className={`job-msg${phase.kind === 'done' ? ' is-done' : phase.kind === 'failed' ? ' is-failed' : ''}`}
          id="job-msg"
          role="status"
          aria-live="polite"
        >
          {phase.kind === 'busy' && phase.msg}
          {phase.kind === 'failed' && (
            <>
              <Ic name="alert" />
              <span>
                <strong>{phase.head}</strong> {phase.body}
              </span>
            </>
          )}
          {phase.kind === 'done' && (
            <>
              <p className="job-h">
                <Ic name="done" />
                Job started
              </p>
              <p>Opening the job page. Loops appear there as each stage finishes.</p>
              <div className="job-actions">
                <a className="btn btn-secondary" href={`/jobs/${phase.jobId}`} ref={jobLinkRef}>
                  Open your job
                </a>
                <button type="button" className="btn btn-ghost" onClick={cutAnother}>
                  Cut another song
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="hint cta-note">
        Our 3:34 example song took about 1–3 minutes. Files are deleted after 24 hours. Use audio you have the rights to.
      </p>
    </form>
  );
}
