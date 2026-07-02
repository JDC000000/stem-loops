'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPT_ATTR, validateUpload, MAX_UPLOAD_BYTES } from '@/lib/upload';

const STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const BAR_OPTIONS = [1, 2, 4, 8];

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Upload the file directly to R2 via the presigned PUT URL, with progress.
// Large real files (50-100MB+) must not abort on a moderate connection and must
// surface a REAL failure reason (not a generic message) so issues are diagnosable.
function putToR2(uploadUrl: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
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
      reject(new Error(`Storage rejected the upload (HTTP ${xhr.status}${xhr.statusText ? ' ' + xhr.statusText : ''})${body ? ': ' + body : ''}`));
    };
    // status 0 + no body = network/CORS/DNS failure (browser hides the detail).
    xhr.onerror = () =>
      reject(new Error(`Upload failed: network or CORS error (no response; XHR status ${xhr.status}). If this persists the storage CORS/origin config may be blocking this domain.`));
    xhr.ontimeout = () => reject(new Error('Upload timed out.'));
    xhr.send(file);
  });
}

export default function HomePage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
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

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
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

      router.push(`/jobs/${jobJson.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-default)'}`,
    background: active ? 'var(--accent)' : 'var(--bg-elevated)',
    color: active ? 'var(--text-inverse)' : 'var(--text-secondary)',
    fontSize: 'var(--text-md)',
    cursor: 'pointer',
    userSelect: 'none',
  });

  const disabled = !file || busy || stems.length === 0;

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '64px 24px 96px', fontFamily: 'var(--font-sans)' }}>
      <h1 style={{ fontSize: 'var(--text-3xl)', margin: '0 0 8px', letterSpacing: 'var(--tracking-tight)' }}>
        stem<span style={{ color: 'var(--accent)' }}>loops</span>
      </h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 32px', fontSize: 'var(--text-lg)' }}>
        Upload a track — get bar-aligned, BPM-matched stem loops.
      </p>

      {/* Drop-zone */}
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

      {/* Stems */}
      <div style={{ marginTop: 28 }}>
        <div style={{ fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--text-subtle)', marginBottom: 10 }}>Stems</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {STEMS.map((s) => (
            <span key={s} onClick={() => !busy && toggleStem(s)} style={chip(stems.includes(s))}>{s}</span>
          ))}
        </div>
      </div>

      {/* Loop length */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--text-subtle)', marginBottom: 10 }}>Loop length</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {BAR_OPTIONS.map((b) => (
            <span key={b} onClick={() => !busy && setBars(b)} style={chip(bars === b)}>{b} {b === 1 ? 'bar' : 'bars'}</span>
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
