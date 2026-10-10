// Browser-side direct-to-R2 upload (moved unchanged from the old home page so the
// landing form keeps the same retry/diagnostics behaviour). Client-only: uses XHR.

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
export async function putToR2(uploadUrl: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
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
