// Typed error display (P3-9). Copy comes from the single ERROR_COPY map keyed by
// error_code — never interpolated from server state, never a stack trace.
import { DEFAULT_ERROR, ERROR_COPY } from '@/lib/error-copy';

export function JobError({ errorCode }: { errorCode: string }) {
  const copy = ERROR_COPY[errorCode] ?? DEFAULT_ERROR;
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
      <p style={{ color: 'var(--status-failed)', fontSize: 18, fontWeight: 600, margin: 0 }}>
        {copy.headline}
      </p>
      {copy.action && <p style={{ color: 'var(--text-muted)', margin: 0 }}>{copy.action}</p>}
      <a
        href="/"
        style={{ color: 'var(--accent)', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
      >
        Try another URL →
      </a>
    </div>
  );
}
