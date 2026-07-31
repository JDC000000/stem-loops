'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPT_ATTR, validateUpload, MAX_UPLOAD_BYTES } from '@/lib/upload';
import { canonicalizeYoutubeUrl } from '@/lib/youtube-url';
import { addToHistory } from '@/lib/history';

const STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const BAR_OPTIONS = [1, 2, 4, 8];

// R2 rollout (youtube-input-v2-research.md): mirrors the server-side ALLOW_YOUTUBE_INPUT
// gate (worker + /api/jobs) but as a build-time public flag purely for UI visibility — the
// API is the real enforcement point either way, this just avoids showing a tab that would
// 403 on submit while the feature is being staged. Defaults to hidden (off).
const YOUTUBE_INPUT_ENABLED = process.env.NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT === 'true';

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type UploadErr = Error & { retriable?: boolean };

// One PUT attempt to R2. Logs real XHR detail (status/statusText/readyState) to the
// console so a failure is diagnosable, and tags network/timeout errors as retriable
// while a definitive 4xx/5xx storage rejection is not.
function putOnce(uploadUrl: string, file: File, contentType: string, onProgress: (pct: number) => void, attempt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.timeout = 0; // no client timeout — a slow 50-100MB upload must not be aborted
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      // R2 returns an XML <Error><Code>…</Code></Error> body — surface it verbatim.
      const body = (xhr.responseText || '').slice(0, 300);
      console.error('[upload] storage rejected PUT', { attempt, status: xhr.status, statusText: xhr.statusText, readyState: xhr.readyState, body });
      const err: UploadErr = new Error(`Storage rejected the upload (HTTP ${xhr.status}${xhr.statusText ? ' ' + xhr.statusText : ''})${body ? ': ' + body : ''}`);
      err.retriable = false; // definitive server response — retrying won't help
      reject(err);
    };
    // status 0 + no body = network/CORS/DNS failure (browser hides the detail).
    xhr.onerror = () => {
      console.error('[upload] PUT network error', { attempt, status: xhr.status, statusText: xhr.statusText, readyState: xhr.readyState, fileSize: file.size });
      const err: UploadErr = new Error(`Upload failed: network or CORS error (no response; XHR status ${xhr.status}).`);
      err.retriable = true;
      reject(err);
    };
    xhr.ontimeout = () => {
      console.error('[upload] PUT timeout', { attempt, readyState: xhr.readyState, fileSize: file.size });
      const err: UploadErr = new Error('Upload timed out.');
      err.retriable = true;
      reject(err);
    };
    xhr.send(file);
  });
}

// Upload the file directly to R2 via the presigned PUT URL, with progress.
// Large real files (50-100MB+) over a real residential connection have more surface
// for a transient drop, so retry network/timeout failures with backoff (a definitive
// 4xx/5xx storage rejection is NOT retried). The presign is valid ~15 min, so re-PUTs
// to the same URL are fine. Final failure surfaces a specific, actionable message.
async function putToR2(uploadUrl: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let lastErr: UploadErr | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await putOnce(uploadUrl, file, contentType, onProgress, attempt);
      if (attempt > 1) console.info(`[upload] succeeded on attempt ${attempt}`);
      return;
    } catch (e) {
      lastErr = e as UploadErr;
      if (!lastErr.retriable || attempt === MAX_ATTEMPTS) break;
      onProgress(0); // reset the progress bar for the retry
      await new Promise((r) => setTimeout(r, 1500 * attempt)); // backoff: 1.5s, 3s
    }
  }
  if (lastErr?.retriable) {
    throw new Error(
      'Upload failed after 3 tries. This is usually a browser extension/ad-blocker blocking r2.cloudflarestorage.com, or a dropped connection — try disabling extensions or switching networks.',
    );
  }
  throw new Error(lastErr?.message ?? 'Upload failed.');
}

const chipStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  // ≥44px touch target (PRD mobile requirement; QA P2 — was ~30px). inline-flex
  // centres the label inside the enforced min box; horizontal padding keeps width.
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  minWidth: 44,
  padding: '0 16px',
  borderRadius: 999,
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border-default)'}`,
  background: active ? 'var(--accent)' : 'var(--bg-elevated)',
  color: active ? 'var(--text-inverse)' : 'var(--text-secondary)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-md)',
  cursor: disabled ? 'default' : 'pointer',
  userSelect: 'none',
});

// A real <button>, not a <span onClick> (hardening review H13). These chips are the only
// way to deselect a stem, change loop length or switch input mode, and as spans they were
// unreachable by keyboard and invisible to screen readers — while the drop-zone directly
// below already implemented the accessible pattern. aria-pressed makes the on/off state
// audible; a native button gets focus, Enter/Space and disabled semantics for free.
function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick} style={chipStyle(active, disabled)}>
      {children}
    </button>
  );
}

export default function HomePage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'upload' | 'youtube'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [stems, setStems] = useState<string[]>(STEMS);
  const [bars, setBars] = useState(4);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function pick(f: File | null) {
    setError(null);
    if (!f) return;
    const v = validateUpload(f.name, f.size);
    if (!v.ok) {
      setError(v.message);
      setFile(null);
      return;
    }
    setFile(f);
  }

  function toggleStem(s: string) {
    setStems((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function submitUpload() {
    if (!file) return;
    // 1. presign
    const pres = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size }),
    });
    const presJson = await pres.json();
    if (!pres.ok) throw new Error(presJson.message ?? 'Could not start the upload.');

    // 2. direct-to-R2 upload
    await putToR2(presJson.uploadUrl, file, presJson.contentType, setProgress);

    // 3. create job
    const jobRes = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: presJson.jobId,
        uploadKey: presJson.key,
        filename: file.name,
        stems: stems.length ? stems : STEMS,
        loop_length_bars: bars,
      }),
    });
    const jobJson = await jobRes.json();
    if (!jobRes.ok) throw new Error(jobJson.message ?? 'Could not create the job.');
    addToHistory(jobJson.id);
    router.push(`/jobs/${jobJson.id}`);
  }

  async function submitYoutube() {
    const url = youtubeUrl.trim();
    if (!url) return;
    // Progress bar has nothing to track pre-fetch (no client-side upload step), so just
    // show the indeterminate "Starting separation…" copy immediately.
    setProgress(100);
    const jobRes = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        stems: stems.length ? stems : STEMS,
        loop_length_bars: bars,
      }),
    });
    const jobJson = await jobRes.json();
    if (!jobRes.ok) throw new Error(jobJson.message ?? 'Could not create the job.');
    addToHistory(jobJson.id);
    router.push(`/jobs/${jobJson.id}`);
  }

  async function submit() {
    if (busy) return;
    if (mode === 'upload' && !file) return;
    if (mode === 'youtube' && !canonicalizeYoutubeUrl(youtubeUrl)) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      if (mode === 'upload') await submitUpload();
      else await submitYoutube();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  const youtubeValid = !!canonicalizeYoutubeUrl(youtubeUrl);
  const disabled =
    busy ||
    stems.length === 0 ||
    (mode === 'upload' ? !file : !youtubeValid);

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '64px 24px 96px', fontFamily: 'var(--font-sans)' }}>
      <h1 style={{ fontSize: 'var(--text-3xl)', margin: '0 0 8px', letterSpacing: 'var(--tracking-tight)' }}>
        stem<span style={{ color: 'var(--accent)' }}>loops</span>
      </h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 32px', fontSize: 'var(--text-lg)' }}>
        {mode === 'upload'
          ? 'Upload a track — get bar-aligned, BPM-matched stem loops.'
          : 'Paste a YouTube link — get bar-aligned, BPM-matched stem loops.'}
      </p>

      {/* Input-source toggle (hidden entirely until NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT=true) */}
      {YOUTUBE_INPUT_ENABLED && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }} role="group" aria-label="Input source">
          <Chip active={mode === 'upload'} disabled={busy} onClick={() => setMode('upload')}>Upload file</Chip>
          <Chip active={mode === 'youtube'} disabled={busy} onClick={() => setMode('youtube')}>YouTube link</Chip>
        </div>
      )}

      {mode === 'upload' ? (
        /* Drop-zone */
        <div
          role="button"
          tabIndex={0}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !busy && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) pick(e.dataTransfer.files?.[0] ?? null); }}
          style={{
            border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border-strong)'}`,
            background: dragging ? 'var(--bg-hover)' : 'var(--bg-elevated)',
            borderRadius: 12,
            padding: '40px 24px',
            textAlign: 'center',
            cursor: busy ? 'default' : 'pointer',
            transition: 'border-color 120ms, background 120ms',
          }}
        >
          <input ref={inputRef} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          {file ? (
            <div>
              <div style={{ fontSize: 'var(--text-lg)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{file.name}</div>
              <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginTop: 4 }}>{fmtSize(file.size)} · click to replace</div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 'var(--text-lg)', color: 'var(--text-secondary)' }}>Drop an audio or video file here</div>
              <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-subtle)', marginTop: 6 }}>
                or click to browse · mp3, wav, m4a, flac, ogg, mp4, mov · max {fmtSize(MAX_UPLOAD_BYTES)}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* YouTube URL input — a real form so Enter submits, which is what anyone
           pasting a link expects (and the only affordance on a mobile keyboard). */
        <form onSubmit={(e) => { e.preventDefault(); if (!disabled) submit(); }}>
          <input
            type="url"
            inputMode="url"
            enterKeyHint="go"
            placeholder="https://www.youtube.com/watch?v=…"
            value={youtubeUrl}
            disabled={busy}
            onChange={(e) => { setYoutubeUrl(e.target.value); setError(null); }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '16px 18px',
              fontSize: 'var(--text-lg)',
              borderRadius: 12,
              border: `2px solid ${youtubeUrl && !youtubeValid ? 'var(--status-failed)' : 'var(--border-strong)'}`,
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
            }}
          />
          <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-subtle)', marginTop: 8 }}>
            youtube.com or youtu.be links only · the video must be public
          </div>
        </form>
      )}

      {/* Stems */}
      <div style={{ marginTop: 28 }}>
        <div id="stems-label" style={{ fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--text-subtle)', marginBottom: 10 }}>Stems</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} role="group" aria-labelledby="stems-label">
          {STEMS.map((s) => (
            <Chip key={s} active={stems.includes(s)} disabled={busy} onClick={() => toggleStem(s)}>{s}</Chip>
          ))}
        </div>
      </div>

      {/* Loop length */}
      <div style={{ marginTop: 24 }}>
        <div id="bars-label" style={{ fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--text-subtle)', marginBottom: 10 }}>Loop length</div>
        <div style={{ display: 'flex', gap: 8 }} role="group" aria-labelledby="bars-label">
          {BAR_OPTIONS.map((b) => (
            <Chip key={b} active={bars === b} disabled={busy} onClick={() => setBars(b)}>{b} {b === 1 ? 'bar' : 'bars'}</Chip>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 24, padding: '12px 16px', borderRadius: 8, background: 'var(--status-failed-bg)', color: 'var(--status-failed)', fontSize: 'var(--text-md)' }}>
          {error}
        </div>
      )}

      {busy && (
        <div style={{ marginTop: 24 }}>
          <div style={{ height: 6, borderRadius: 999, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent)', transition: 'width 120ms' }} />
          </div>
          <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginTop: 8 }}>
            {progress < 100 ? `Uploading… ${progress}%` : 'Starting separation…'}
          </div>
        </div>
      )}

      <div className="submit-cta" style={{ marginTop: 32 }}>
        <button
          onClick={submit}
          disabled={disabled}
          style={{
            width: '100%',
            padding: '14px 24px',
            fontSize: 'var(--text-lg)',
            fontWeight: 600,
            borderRadius: 10,
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: disabled ? 'var(--bg-selected)' : 'var(--accent)',
            color: disabled ? 'var(--text-disabled)' : 'var(--text-inverse)',
          }}
        >
          {busy ? 'Working…' : 'Extract Loops'}
        </button>
      </div>
    </main>
  );
}
