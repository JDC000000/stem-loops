// Chord-edit collector — PR-Y1.7 flywheel seed (TSD §1.6a).
//
// The chord overlay UI calls bufferChordEdit() when a user corrects a label.
// Edits are enqueued in localStorage (so a refresh never drops them) and
// flushed to POST /api/chord-edits in the background with exponential
// backoff on transient errors. submitChordEdit() sends a single edit
// synchronously — used in tests and by code paths that WANT to block on
// delivery.
//
// Why localStorage instead of a more durable store (per-viewer convenience
// only, Artifact-rules spirit — a buffered edit that didn't leave the
// browser is UX-equivalent to the user never having made the edit):
//   * The authoritative record is the DB row created by the API call.
//   * The buffer exists to survive a navigation or a flaky connection;
//     if it is cleared, the edit is simply gone — the UI already shows the
//     corrected label from the overlay's own state.
//
// NEVER dedupe on original_label. A user can correct the same frame
// multiple times (A:min, then A:min7, then A:maj7); each intermediate
// state is a real training signal about where the model's output was NOT
// right. The schema allows multiple edits on the same (job_id, start_sec,
// end_sec) by design (migration 025) — don't suppress them here.
//
// Per-user buffer keying (security audit §3 M3): the localStorage buffer
// is NOT a single shared blob. Each signed-in user has their own key
// (`stem-loops-chord-edit-buffer:<userId>`), and the pre-login / signed-out
// path uses a sentinel `:anon` bucket. Without this, a device where user A
// buffered edits offline, then logged out, then user B logged in, would
// flush A's edits under B's auth cookies — the server-side auth.uid() check
// would write A's edits as if B had authored them. The caller is expected
// to drive `setChordEditUser(userId)` from the auth layer (or whichever
// session-aware wrapper fronts this module) and to call
// `clearBufferedEdits()` on sign-out so no stale edit outlives the session.

export type ChordProvider = 'klangio' | 'internal' | 'autochord';

export interface ChordEdit {
  jobId: string;
  trackHash: string;
  startSec: number;
  endSec: number;
  originalLabel: string;
  correctedLabel: string;
  originalConfidence?: number;
  provider: ChordProvider;
  providerVersion: string;
  cqtPlanVersion?: string;
  alphabetSha: string;
}

/** Harte alphabet — must stay in lockstep with migration 025's CHECK. */
const HARTE_RE = /^(N|X|[A-G](#|b)?(:[a-z0-9]+)?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per-user localStorage prefix. Actual key is `<prefix>:<userId>` — see
 *  `bufferKey()`. Any code path that touches localStorage for chord edits
 *  must go through `bufferKey()` so the per-user scoping is enforced in
 *  exactly one place. */
const BUFFER_KEY_PREFIX = 'stem-loops-chord-edit-buffer';
const ANON_USER_ID = 'anon';
const MAX_BUFFER = 200;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

/** The user id used to scope the buffer key. `null` until the auth layer
 *  calls `setChordEditUser()` — falls back to the `:anon` bucket. */
let _currentUserId: string | null = null;

/**
 * Set (or clear) the signed-in user id that scopes the localStorage buffer.
 * Call from the auth layer whenever a session is established or restored,
 * and from the sign-out handler with `null`. See the file header for why
 * per-user scoping matters.
 *
 * Does NOT mutate any buffer. On sign-out the caller should also invoke
 * `clearBufferedEdits()` to drop stale entries that will never be flushable
 * under a different session.
 */
export function setChordEditUser(userId: string | null): void {
  _currentUserId = userId && userId.length > 0 ? userId : null;
}

function bufferKey(): string {
  return `${BUFFER_KEY_PREFIX}:${_currentUserId ?? ANON_USER_ID}`;
}

export class ChordEditValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ChordEditValidationError';
  }
}

export function validateChordEdit(edit: ChordEdit): void {
  if (!edit || typeof edit !== 'object') {
    throw new ChordEditValidationError('EDIT_SHAPE', 'edit must be an object');
  }
  if (typeof edit.jobId !== 'string' || !UUID_RE.test(edit.jobId)) {
    throw new ChordEditValidationError('EDIT_JOB_ID', 'jobId must be a UUID');
  }
  if (typeof edit.trackHash !== 'string' || edit.trackHash.length === 0) {
    throw new ChordEditValidationError('EDIT_TRACK_HASH', 'trackHash is required');
  }
  if (
    typeof edit.startSec !== 'number' ||
    typeof edit.endSec !== 'number' ||
    !Number.isFinite(edit.startSec) ||
    !Number.isFinite(edit.endSec)
  ) {
    throw new ChordEditValidationError('EDIT_TIME_FINITE', 'start_sec/end_sec must be finite numbers');
  }
  if (edit.endSec <= edit.startSec) {
    throw new ChordEditValidationError('EDIT_TIME_RANGE', 'end_sec must be > start_sec');
  }
  if (typeof edit.originalLabel !== 'string' || edit.originalLabel.length === 0) {
    throw new ChordEditValidationError('EDIT_ORIGINAL_LABEL', 'originalLabel is required');
  }
  if (typeof edit.correctedLabel !== 'string' || !HARTE_RE.test(edit.correctedLabel)) {
    throw new ChordEditValidationError('EDIT_HARTE', 'correctedLabel must be a valid Harte label');
  }
  if (edit.originalLabel === edit.correctedLabel) {
    throw new ChordEditValidationError('EDIT_LABELS_DIFFER', 'labels must differ');
  }
  if (!['klangio', 'internal', 'autochord'].includes(edit.provider)) {
    throw new ChordEditValidationError('EDIT_PROVIDER', 'provider must be klangio|internal|autochord');
  }
  if (typeof edit.providerVersion !== 'string' || edit.providerVersion.length === 0) {
    throw new ChordEditValidationError('EDIT_PROVIDER_VERSION', 'providerVersion is required');
  }
  if (typeof edit.alphabetSha !== 'string' || edit.alphabetSha.length === 0) {
    throw new ChordEditValidationError('EDIT_ALPHABET_SHA', 'alphabetSha is required');
  }
  if (
    edit.originalConfidence !== undefined &&
    (typeof edit.originalConfidence !== 'number' ||
      !Number.isFinite(edit.originalConfidence) ||
      edit.originalConfidence < 0 ||
      edit.originalConfidence > 1)
  ) {
    throw new ChordEditValidationError(
      'EDIT_CONFIDENCE',
      'originalConfidence must be in [0, 1]',
    );
  }
}

interface BufferedEdit extends ChordEdit {
  /** ms epoch the edit was buffered. Used for diagnostic logging only. */
  _at: number;
  /** attempts so far (not exposed in request body). */
  _attempts: number;
}

function safeReadBuffer(): BufferedEdit[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(bufferKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop entries that fail validation — a corrupt buffer should not block
    // the UI. The lost edit is less bad than a wedged queue.
    return parsed.filter((e): e is BufferedEdit => {
      try {
        validateChordEdit(e as ChordEdit);
        return (
          typeof (e as BufferedEdit)._at === 'number' &&
          typeof (e as BufferedEdit)._attempts === 'number'
        );
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function safeWriteBuffer(buf: BufferedEdit[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(bufferKey(), JSON.stringify(buf));
  } catch {
    // quota exceeded / private mode: ignore. The in-flight edit still has a
    // chance to reach the API; losing the queue is a graceful degradation.
  }
}

/**
 * Drop every chord-edit buffer in localStorage, across all per-user keys.
 *
 * Called from the sign-out handler so edits from a departing session cannot
 * be flushed under the next user's auth cookies (security audit §3 M3). The
 * sweep is intentionally broad: we don't know which user is leaving if the
 * auth layer didn't drive `setChordEditUser()` beforehand, and losing a
 * handful of un-delivered edits is strictly better than cross-user leakage.
 *
 * Also clears the legacy single-key buffer written by pre-M3 builds so a
 * version upgrade doesn't leave an orphan entry under the pre-M3 name.
 */
export function clearBufferedEdits(): void {
  if (typeof window === 'undefined') return;
  try {
    const ls = window.localStorage;
    const toRemove: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (!k) continue;
      if (k === BUFFER_KEY_PREFIX || k.startsWith(`${BUFFER_KEY_PREFIX}:`)) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) ls.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function peekBufferedEdits(): ChordEdit[] {
  return safeReadBuffer().map(stripInternal);
}

/**
 * Add an edit to the local buffer and trigger a background flush. The
 * returned promise resolves when THIS edit has either been delivered or
 * exhausted its retries — call sites normally ignore it (fire-and-forget).
 * Validation errors surface synchronously so the UI can roll back the
 * optimistic label change.
 */
export function bufferChordEdit(edit: ChordEdit): Promise<void> {
  validateChordEdit(edit);
  const buf = safeReadBuffer();
  const entry: BufferedEdit = { ...edit, _at: Date.now(), _attempts: 0 };
  buf.push(entry);
  // Oldest-first drop keeps the most recent corrections — a long-running
  // session on a flaky connection shouldn't lose today's edits to last week's.
  if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
  safeWriteBuffer(buf);
  return flushBufferedEdits().then(() => {});
}

/**
 * Send one edit synchronously (used by tests and by callers that must block
 * on delivery). Does NOT touch the local buffer. Returns the new edit_id.
 */
export async function submitChordEdit(edit: ChordEdit): Promise<{ editId: string }> {
  validateChordEdit(edit);
  const body = toWireFormat(edit);
  const res = await fetch('/api/chord-edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await safeReadErrorBody(res);
    throw new Error(`chord-edit submit failed: ${res.status} ${err}`);
  }
  const json = (await res.json()) as { edit_id: string };
  return { editId: json.edit_id };
}

let flushInFlight: Promise<number> | null = null;

/**
 * Flush all buffered edits with exponential backoff on network error.
 * Returns the number of edits successfully delivered during this call.
 * Concurrent calls coalesce onto the in-flight flush.
 */
export function flushBufferedEdits(): Promise<number> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    try {
      return await doFlush();
    } finally {
      flushInFlight = null;
    }
  })();
  return flushInFlight;
}

async function doFlush(): Promise<number> {
  let delivered = 0;
  // Snapshot the queue; writes during flush land on the current buffer and
  // will be picked up on the next flush.
  let buf = safeReadBuffer();
  while (buf.length > 0) {
    const [head, ...rest] = buf;
    try {
      await submitChordEdit(stripInternal(head));
      delivered += 1;
      buf = rest;
      safeWriteBuffer(buf);
    } catch (err) {
      head._attempts += 1;
      // Non-retriable: a 4xx response means the API refused this shape.
      // Drop the edit so one bad row cannot wedge the queue — the schema
      // CHECKs on the server are the authoritative validator, and the user
      // already saw the corrected label locally.
      if (isPermanentError(err) || head._attempts >= MAX_RETRIES) {
        buf = rest;
        safeWriteBuffer(buf);
        continue;
      }
      // Transient: back off and stop this flush. The next bufferChordEdit()
      // call (or a manual flushBufferedEdits()) will retry.
      safeWriteBuffer([head, ...rest]);
      const delay = BASE_BACKOFF_MS * 2 ** (head._attempts - 1);
      await sleep(delay);
      return delivered;
    }
  }
  return delivered;
}

function toWireFormat(edit: ChordEdit): Record<string, unknown> {
  const body: Record<string, unknown> = {
    job_id: edit.jobId,
    track_hash: edit.trackHash,
    start_sec: edit.startSec,
    end_sec: edit.endSec,
    original_label: edit.originalLabel,
    corrected_label: edit.correctedLabel,
    provider: edit.provider,
    provider_version: edit.providerVersion,
    alphabet_sha: edit.alphabetSha,
  };
  if (edit.originalConfidence !== undefined) body.original_confidence = edit.originalConfidence;
  if (edit.cqtPlanVersion !== undefined) body.cqt_plan_version = edit.cqtPlanVersion;
  return body;
}

function stripInternal(b: BufferedEdit): ChordEdit {
  // Rebuild the public shape by name. Destructuring the internal fields into
  // throwaway bindings trips @typescript-eslint/no-unused-vars (the project's
  // config only ignores unused *args* prefixed with `_`, not *vars*).
  const out: ChordEdit = {
    jobId: b.jobId,
    trackHash: b.trackHash,
    startSec: b.startSec,
    endSec: b.endSec,
    originalLabel: b.originalLabel,
    correctedLabel: b.correctedLabel,
    provider: b.provider,
    providerVersion: b.providerVersion,
    alphabetSha: b.alphabetSha,
  };
  if (b.originalConfidence !== undefined) out.originalConfidence = b.originalConfidence;
  if (b.cqtPlanVersion !== undefined) out.cqtPlanVersion = b.cqtPlanVersion;
  return out;
}

function isPermanentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Pattern: `chord-edit submit failed: <status> <body>`
  //
  // 4xx are permanent client errors EXCEPT:
  //   - 401 Unauthorized  — session expired; the user will re-auth and the
  //                         next flush should retry. Dropping here throws
  //                         away flywheel training signal silently (T3 in
  //                         y1-test-coverage-audit.md).
  //   - 408 Request Timeout — transient server/network state; retry.
  //   - 429 Too Many Requests — rate limited; retry on next flush.
  // 5xx are server errors; always retry.
  const match = err.message.match(/chord-edit submit failed: (\d{3}) /);
  if (!match) return false;
  const status = Number.parseInt(match[1], 10);
  if (!Number.isFinite(status)) return false;
  if (status < 400 || status >= 500) return false; // 5xx (or non-HTTP code) → retry
  return status !== 401 && status !== 408 && status !== 429;
}

async function safeReadErrorBody(res: Response): Promise<string> {
  try {
    const txt = await res.text();
    return txt.slice(0, 200);
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
