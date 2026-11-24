'use client';

// The landing's one input: a link field, "Choose a file", and drop-anywhere-on-the-hero.
// Submit runs the real flow (same as the old home page): file → POST /api/uploads (presign)
// → PUT straight to R2 (putToR2, with its retries) → POST /api/jobs; link → POST /api/jobs.
// Validation, rate limits, admission and error codes all stay server-side in those routes.
//
// A4 (2026-11-21, Jon's J1: "on my mobile, take a YouTube link and put it in, and very quickly be
// able to listen and learn"):
//   * the form sits ABOVE the demo on the home page, so its button is on the first screen of a phone;
//   * a 44 px "Paste" button reads the clipboard on that tap only (never without a user gesture);
//     a YouTube link is filled in and the focus moves to the button;
//   * no stem picker on phones: a phone always asks for all six (the picker's toggle did nothing
//     there, and play-along needs every stem); desktop keeps the chips;
//   * a signed-out visitor who submits a LINK signs in FIRST, and the link is started as soon as
//     they are back (lib/pending-link.ts). A FILE still starts signed out: a picked file cannot be
//     carried through a sign-in redirect, and the job page asks for sign-in as before.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPT_ATTR, validateUpload } from '@/lib/upload';
import { durationVerdict, probeDurationSec, trimNotice } from '@/lib/upload-duration';
import { putToR2 } from '@/lib/upload-client';
import { canonicalizeYoutubeUrl, youtubeUrlProblem } from '@/lib/youtube-url';
import { addToHistory } from '@/lib/history';
import { navigationGrace, trackEvent } from '@/lib/analytics';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import {
  claimPendingLink, clearInFlight, hasResumeMarker, newNonce, pendingSignInHref, resumeNonce, savePendingLink, takePendingLink,
  NONCE_PARAM, RESUME_PARAM,
} from '@/lib/pending-link';
import { hasSessionCookie } from '@/components/chrome/SignedInNav';
import { MAX_TRACK_SEC, PLAYABLE_STEMS } from '@/lib/play/types';
import { Ic } from './Icons';

/** The mixer order (lib/play/types.ts). A phone always asks for all six. */
const STEM_ORDER: readonly string[] = PLAYABLE_STEMS;
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);
/** Below the landing's 760px breakpoint there is no stem picker: every stem is sent. */
const PHONE_QUERY = '(max-width: 759px)';

type LockManagerLike = { request: (name: string, cb: () => Promise<unknown>) => Promise<unknown> };

/**
 * What the form reaches outside React for. Defaults are the browser's own; a test passes its own
 * (test/a4-home-link.test.mjs mounts this form in a DOM with a recording fetch and navigation).
 * The clipboard is NOT here on purpose: it is read from `navigator.clipboard` inside the Paste
 * tap only, and the tests spy on that real object.
 */
export type ToolFormDeps = {
  fetch: typeof fetch;
  assign: (url: string) => void;
  storage: () => Storage | null;
  locks: () => LockManagerLike | null;
};

const browserDeps: ToolFormDeps = {
  fetch: (...a) => fetch(...a),
  assign: (url) => window.location.assign(url),
  storage: () => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  },
  locks: () => {
    try {
      const l = (navigator as Navigator & { locks?: LockManagerLike }).locks;
      return l && typeof l.request === 'function' ? l : null;
    } catch {
      return null;
    }
  },
};

/**
 * Is this browser signed in? false = no session cookie, or the server says 401: sign in first.
 * true = the server says yes. null = unknown (network error or a 5xx): the caller FAILS CLOSED
 * and offers a retry; it never starts an anonymous link job on an unknown answer.
 */
async function signedInNow(deps: ToolFormDeps): Promise<boolean | null> {
  let cookie = '';
  try {
    cookie = document.cookie;
  } catch {
    return null;
  }
  if (!hasSessionCookie(cookie)) return false;
  try {
    const res = await deps.fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 401) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

const ERR = {
  empty_input: ['Add a song first.', 'Paste a YouTube link or choose a file.'],
  empty_file: ['Add a song first.', 'Choose an audio or video file.'],
  url: ['That isn’t a YouTube video link.', 'Paste the full address from youtube.com or youtu.be, or upload a file.'],
  playlist: ['That’s a playlist link.', 'Open one video from it and paste that link.'],
  channel: ['That’s a channel, not a video.', 'Open one video and paste its link.'],
  other: ['Only YouTube links work here.', 'For anything else, upload the audio file.'],
  yt_off: ['YouTube links are paused right now.', 'Upload the audio file instead.'],
  clip_empty: ['Your clipboard is empty.', 'Copy the link in YouTube (Share, then Copy link) and tap Paste again.'],
  clip_other: ['That isn’t a YouTube video link.', 'Copy the video’s link in YouTube (Share, then Copy link) and tap Paste again.'],
  clip_denied: ['We couldn’t read your clipboard.', 'Press and hold the box, then choose Paste.'],
  // Fail closed (PR #332, round 2): never start a signed-out link job on an unknown answer.
  auth_unknown: ['We couldn’t check whether you’re signed in.', 'Check your connection, then tap Try again.'],
  storage_blocked: ['Your browser is blocking site storage, so we can’t keep your link while you sign in.', 'Sign in first (top right), then paste the link again.'],
  type: ['We can’t use that file type.', 'Choose mp3, wav, m4a, aac, flac, ogg, opus, aiff, mp4, m4v, mov or webm.'],
  empty: ['That file is empty.', 'Choose a different one.'],
  large: ['That file is over the 200 MB limit.', 'Export a shorter or compressed version (mp3 or m4a) and try again.'],
} as const;
type ErrCode = keyof typeof ERR;

const STAGES = ['sending', 'downloading', 'separating', 'extracting', 'uploading'] as const;
type Stage = (typeof STAGES)[number];
const STAGE_TEXT: Record<Stage, string> = { sending: 'Sending', downloading: 'Fetching', separating: 'Separating', extracting: 'Finding bars', uploading: 'Saving' };

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

async function postJson<T>(url: string, body: unknown, f: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('We couldn’t reach stem-loops. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.message ?? 'Something went wrong on our end. Please try again.');
  return json as T;
}

export function ToolForm({ deps = browserDeps }: { deps?: ToolFormDeps } = {}) {
  // No loop length here (2026-11-15): Download loops is its own product (/loops), and the Play
  // along form neither sells nor configures it. The job gets the API's default loop length
  // (4 bars, app/api/jobs/route.ts), which is what the /loops intro states.
  const [stems, setStems] = useState<ReadonlySet<string>>(() => new Set(STEM_ORDER));
  const setStemChecked = useCallback((name: string, checked: boolean) => {
    setStems((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);
  const formRef = useRef<HTMLFormElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const fileBtnRef = useRef<HTMLButtonElement>(null);
  const firstStemRef = useRef<HTMLInputElement>(null);
  const jobLinkRef = useRef<HTMLAnchorElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'source' | 'replace' | 'stem' | 'job' | 'cta' | null>(null);

  const [text, setText] = useState('');
  const [file, setFileState] = useState<File | null>(null);
  const [err, setErr] = useState<{ code: ErrCode; suffix?: string } | null>(null);
  const [stemsErr, setStemsErr] = useState(false);
  // The Paste button shows only where the async clipboard read exists (checked after mount).
  const [canPaste, setCanPaste] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [live, setLive] = useState('');
  const [narrow, setNarrow] = useState(false);
  // True while the admission duration probe is in flight for the current pick.
  const [checking, setChecking] = useState(false);
  // The pre-submit trim note for the current pick (lib/upload-duration.ts `trimNotice`), or
  // null. A heads-up only: the worker does the trimming, and submit is never blocked.
  const [notice, setNotice] = useState<string | null>(null);
  // Monotonic pick counter: only the newest pick may write state when its probe resolves.
  const pickSeq = useRef(0);
  const busy = phase.kind === 'busy';

  // focus after the DOM reflects the new state (e.g. the picked-file row now exists)
  useEffect(() => {
    const f = focusNext.current;
    focusNext.current = null;
    if (f === 'source') (sourceRef.current ?? fileBtnRef.current)?.focus();
    else if (f === 'replace') replaceRef.current?.focus();
    else if (f === 'stem') firstStemRef.current?.focus();
    else if (f === 'job') jobLinkRef.current?.focus();
    else if (f === 'cta') ctaRef.current?.focus();
  });

  const resetJob = useCallback(() => setPhase((p) => (p.kind === 'busy' ? p : { kind: 'idle' })), []);

  const setFile = useCallback(
    async (f: File | null) => {
      if (busy) return;
      setErr(null);
      resetJob();
      if (fileRef.current) fileRef.current.value = '';
      if (!f) {
        setFileState(null);
        setNotice(null);
        return;
      }
      const v = validateUpload(f.name, f.size);
      if (!v.ok) {
        // keep the previous valid file (if any) and say why this one did not pass the
        // client-side name-and-size check.
        const code: ErrCode = v.error_code === 'UPLOAD_TOO_LARGE' ? 'large' : f.size <= 0 ? 'empty' : 'type';
        setErr({ code, suffix: file ? ` Still using ${file.name}.` : undefined });
        focusNext.current = file ? 'replace' : 'source';
        return;
      }
      // Show the pick straight away so the row and the submit handler agree about which
      // file is selected, THEN measure its length. `checking` holds submit shut for the
      // few ms that takes, so a quick click cannot start a job on an unmeasured file.
      const seq = ++pickSeq.current;
      setFileState(f);
      setNotice(null);
      setText('');
      setLive(`File chosen: ${f.name}, ${fmtSize(f.size)}`);
      focusNext.current = 'replace';
      setChecking(true);
      let verdict;
      try {
        verdict = durationVerdict(await probeDurationSec(f));
      } finally {
        if (seq === pickSeq.current) setChecking(false);
      }
      // A newer pick landed while this one was being measured: that pick owns the state.
      if (seq !== pickSeq.current) return;
      // A long track is KEPT (2026-11-14): the worker trims it to its first
      // MAX_UPLOAD_DURATION_SEC seconds. This only says so before submit — see the header of
      // lib/upload-duration.ts. An unmeasurable file shows nothing; the worker trims anyway.
      const note = trimNotice(verdict);
      if (note) {
        setNotice(note);
        setLive(note);
      }
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
      if (dt.files && dt.files[0]) void setFile(dt.files[0]);
      else {
        const t = dt.getData('text/uri-list') || dt.getData('text/plain');
        if (t && !busy && !YOUTUBE_INPUT_ENABLED) {
          setErr({ code: 'yt_off' });
        } else if (t && !busy) {
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

  useEffect(() => {
    try {
      setCanPaste(typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function');
    } catch {
      setCanPaste(false);
    }
  }, []);

  const orderedStems = STEM_ORDER.filter((s) => stems.has(s));
  const n = orderedStems.length;
  const stemTxt = `${n}${n === 1 ? ' stem' : ' stems'}`;
  const showStemsErr = stemsErr && n === 0;

  /** Start a job. Resolves true when it started (the browser is on its way to the job page). */
  async function runJob(canonicalUrl: string | null, sendStems: readonly string[]): Promise<boolean> {
    const isFile = !!file;
    const base = { isFile, done: null, pct: 0 } as const;
    try {
      let jobId: string;
      // #372: a signed-in re-paste of a link whose song is already live answers 200
      // { id, existing: true } (nothing charged). It opens that job like a new one, but it is not
      // a new song, so `song_added` is not counted for it.
      let existing = false;
      if (file) {
        const sending = (pct: number) =>
          setPhase({ kind: 'busy', ...base, now: 'sending', pct, label: `Sending file… ${pct}%`, msg: `Sending ${file.name}. Keep this tab open.` });
        sending(0);
        const pres = await postJson<{ jobId: string; key: string; uploadUrl: string; contentType: string }>('/api/uploads', {
          filename: file.name,
          size: file.size,
        }, deps.fetch);
        try {
          await putToR2(pres.uploadUrl, file, pres.contentType, sending);
        } catch (e) {
          setPhase({ kind: 'failed', head: 'The upload didn’t finish.', body: e instanceof Error ? e.message : 'Please try again.' });
          return false;
        }
        setPhase({ kind: 'busy', ...base, now: null, done: 'sending', pct: 100, label: 'Starting…', msg: 'File sent. Starting your job…' });
        const job = await postJson<{ id: string }>('/api/jobs', {
          jobId: pres.jobId,
          uploadKey: pres.key,
          filename: file.name,
          stems: sendStems,
        }, deps.fetch);
        jobId = job.id;
      } else {
        setPhase({ kind: 'busy', ...base, now: null, pct: 100, label: 'Starting…', msg: 'Starting your job…' });
        const job = await postJson<{ id: string; existing?: boolean }>('/api/jobs', { url: canonicalUrl, stems: sendStems }, deps.fetch);
        jobId = job.id;
        existing = job.existing === true;
      }
      addToHistory(jobId);
      if (!existing) trackEvent('song_added', { source: isFile ? 'file' : 'link' });
      setPhase({ kind: 'done', jobId });
      focusNext.current = 'job';
      // Give song_added a bounded moment (≤150 ms) to go out before the page unloads.
      await navigationGrace();
      // Full navigation (not router.push): the job page has its own styles, and the
      // landing's stylesheet must not follow it there.
      deps.assign(`/jobs/${jobId}`);
      return true;
    } catch (e) {
      setPhase({
        kind: 'failed',
        head: 'We couldn’t start that job.',
        body: e instanceof Error ? e.message : 'Something went wrong. Please try again.',
      });
      return false;
    }
  }

  const isPhone = () => {
    try {
      return window.matchMedia(PHONE_QUERY).matches;
    } catch {
      return false;
    }
  };

  /** Show a fail-closed error: the CTA reads "Try again" and the link stays in the box. */
  const failClosed = (code: 'auth_unknown' | 'storage_blocked') => {
    setPhase({ kind: 'failed', head: ERR[code][0], body: ERR[code][1] });
    focusNext.current = 'cta';
  };

  /**
   * A link: signed in, it starts here; signed out, the visitor signs in FIRST
   * (lib/pending-link.ts) and it starts when they are back. Unknown (network error, 5xx) or a
   * storage that will not keep the link: FAIL CLOSED with a retry; never an anonymous link job.
   */
  async function submitLink(canonical: string, sendStems: readonly string[]) {
    setPhase({ kind: 'busy', isFile: false, done: null, now: null, pct: 0, label: 'Starting…', msg: 'Starting your job…' });
    const signedIn = await signedInNow(deps);
    if (signedIn === true) {
      await runJob(canonical, sendStems);
      return;
    }
    if (signedIn === null) return failClosed('auth_unknown');
    const nonce = newNonce();
    if (!savePendingLink(deps.storage(), canonical, nonce)) return failClosed('storage_blocked');
    setPhase({ kind: 'busy', isFile: false, done: null, now: null, pct: 0, label: 'Opening sign-in…', msg: 'Sign in and your song starts straight away.' });
    deps.assign(pendingSignInHref(nonce));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (checking) {
      // The duration probe for the current pick has not come back yet. Say so rather than
      // starting a job we are about to have an answer about.
      setLive('Still checking that track, one moment.');
      return;
    }
    const t = text.trim();
    if (!file && !t) {
      setErr({ code: YOUTUBE_INPUT_ENABLED ? 'empty_input' : 'empty_file' });
      focusNext.current = 'source';
      setPhase({ kind: 'idle' });
      return;
    }
    // Phones have no stem picker: all six, always. Desktop sends what its chips say.
    const sendStems = isPhone() ? [...STEM_ORDER] : orderedStems;
    if (!sendStems.length) {
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
    if (canonical) void submitLink(canonical, sendStems);
    else void runJob(null, sendStems);
  }

  // Every home load settles the saved link (lib/pending-link.ts), once, on mount:
  //   * WITH the marker and its nonce (back from /login): strip the marker from the address bar
  //     FIRST (a reload or a shared URL can never start a second job), check the session, and
  //     only when the server says signed in, CLAIM the link (Web Lock, nonce match, 60 s
  //     in-flight guard) and start it as the signed-in user. Signed out: the link goes back in
  //     the box. Unknown: fail closed with a retry.
  //   * WITHOUT the marker (a normal visit, Back from /login): take the entry out and only put
  //     the link back in the box, so it can never start later for whoever signs in next.
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !YOUTUBE_INPUT_ENABLED) return;
    settled.current = true;
    let search = '';
    try {
      search = window.location.search;
    } catch {
      return;
    }
    const store = deps.storage();
    if (!hasResumeMarker(search)) {
      const back = takePendingLink(store, null);
      if (back) {
        setText(back);
        setLive('Your link is back in the box.');
      }
      return;
    }
    const nonce = resumeNonce(search);
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete(RESUME_PARAM);
      u.searchParams.delete(NONCE_PARAM);
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    } catch {
      /* the marker stays in the bar; the saved link is already one-shot */
    }
    void (async () => {
      const signedIn = nonce ? await signedInNow(deps) : false;
      if (signedIn !== true) {
        // Not signed in after all, a marker without a valid nonce, or no answer: never start.
        const back = takePendingLink(store, null);
        if (back) setText(back);
        if (signedIn === null && back) failClosed('auth_unknown');
        else if (back) setLive('Your link is in the box. Sign in, then tap Separate and play.');
        return;
      }
      const link = await claimPendingLink({ store, nonce: nonce!, locks: deps.locks() });
      if (!link) return; // nothing saved for this nonce, or another tab already started it
      setText(link);
      setLive('Signed in. Starting your song.');
      const ok = await runJob(link, isPhone() ? [...STEM_ORDER] : STEM_ORDER.filter((x) => stems.has(x)));
      if (!ok) clearInFlight(store, link); // a failed start may be retried by hand at once
    })();
    // Runs once on mount; `stems` is the default set at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPaste() {
    if (busy) return;
    let t = '';
    try {
      // Read on this tap only: the browser may show its own Paste prompt.
      t = (await navigator.clipboard.readText()).trim();
    } catch {
      setErr({ code: 'clip_denied' });
      focusNext.current = 'source';
      return;
    }
    if (!t) {
      setErr({ code: 'clip_empty' });
      return;
    }
    if (!canonicalizeYoutubeUrl(t)) {
      setErr({ code: 'clip_other' });
      return;
    }
    setFileState(null);
    setNotice(null);
    setText(t);
    setErr(null);
    resetJob();
    setLive('Link pasted. Tap Separate and play.');
    focusNext.current = 'cta';
  }

  function cutAnother() {
    setPhase({ kind: 'idle' });
    setFileState(null);
    setText('');
    focusNext.current = 'source';
  }

  const ctaLabel = phase.kind === 'busy'
    ? phase.label
    : checking
      ? 'Checking the track\u2026'
      : phase.kind === 'failed'
        ? 'Try again'
        : 'Separate and play';
  const errText = err ? ERR[err.code] : null;
  const formCls = ['tool', err ? 'is-invalid' : '', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ');

  return (
    <form id="tool" ref={formRef} className={formCls} noValidate autoComplete="off" aria-label="stem-loops tool" tabIndex={-1} onSubmit={onSubmit}>
      <div className="field">
        {/* With the YouTube input gated off at build time the one input is a file picker, and
            the copy says so plainly (the API refuses link jobs in that case anyway). */}
        <div className="label-row">
          {YOUTUBE_INPUT_ENABLED ? (
            <label htmlFor="source" className="label">Link or file</label>
          ) : (
            <span className="label" id="source-label">Audio or video file</span>
          )}
          <span className="drop-hint" aria-hidden="true">or drop a file here</span>
        </div>
        <div className="source" id="source-wrap" hidden={!!file}>
          {YOUTUBE_INPUT_ENABLED && (
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
          )}
          {YOUTUBE_INPUT_ENABLED && (
            // Reads the clipboard ON THIS TAP ONLY. Hidden until the browser is known to support
            // the read (after mount), so a browser without it never shows a dead button.
            <button
              type="button"
              id="paste-btn"
              className="btn btn-secondary btn-field btn-paste"
              hidden={!canPaste}
              disabled={busy}
              aria-describedby="source-help"
              onClick={() => void onPaste()}
            >
              Paste
            </button>
          )}
          {!YOUTUBE_INPUT_ENABLED && (
          <button
            type="button"
            id="file-btn"
            ref={fileBtnRef}
            className="btn btn-secondary btn-field btn-field-full"
            aria-describedby="source-label source-help source-error"
            onClick={() => fileRef.current?.click()}
          >
            <Ic name="file" />
            <span>Choose a file</span>
          </button>
          )}
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
              if (f) void setFile(f);
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
              void setFile(null);
              setLive('File removed');
              focusNext.current = 'source';
            }}
          >
            <Ic name="x" />
          </button>
        </div>
        <p className="hint" id="picked-notice" data-testid="trim-notice" hidden={!(file && notice)}>
          {file && notice ? notice : ''}
        </p>
        <p className="sr-only" id="picked-live" aria-live="polite">{live}</p>
        <p className="hint" id="source-help">
          {YOUTUBE_INPUT_ENABLED
            ? 'A public YouTube link, or an audio or video file up to 200\u00a0MB.'
            : 'YouTube links are paused right now. Upload an audio or video file up to 200\u00a0MB.'}
        </p>
        <p className="error" id="source-error" role="alert" hidden={!errText}>
          <Ic name="alert" />
          <span>
            <strong>{errText?.[0]}</strong> <span>{errText ? errText[1] + (err?.suffix ?? '') : ''}</span>
          </span>
        </p>
      </div>

      {YOUTUBE_INPUT_ENABLED && !file && (
        // The link is the main way in (phones above all); a file is the alternative, one row down.
        <button
          type="button"
          id="file-btn"
          ref={fileBtnRef}
          className="btn btn-ghost btn-file-alt"
          onClick={() => fileRef.current?.click()}
        >
          <Ic name="file" />
          <span>Or choose a file</span>
        </button>
      )}

      {/* Wide screens only: below 760px the picker is not shown and every stem is sent (landing.css). */}
      <div className="options" id="options">
        <fieldset className="group" id="stems-group">
          <legend className="label">Stems</legend>
          <div className="chips chips-3">
            {STEM_ORDER.map((s, i) => (
              <label className="chip" data-stem={s} key={s}>
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
              <strong>Pick at least one stem.</strong> Choose any stem above.
            </span>
          </p>
        </fieldset>

      </div>

      <p className="readout mono sr-only" id="readout" aria-live="polite">
        {n ? stemTxt : 'No stems selected'}
      </p>

      <button
        type="submit"
        id="cta"
        ref={ctaRef}
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
                {STAGE_TEXT[s]}
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
              <p>Opening the job page. The player opens there when the last stage finishes.</p>
              <div className="job-actions">
                <a className="btn btn-secondary" href={`/jobs/${phase.jobId}`} ref={jobLinkRef}>
                  Open your job
                </a>
                <button type="button" className="btn btn-ghost" onClick={cutAnother}>
                  Start a new song
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="hint cta-note">
        {/* C-14: no processing-time figure (see FAQ.time in faq.tsx for why). The length cap is
            MAX_TRACK_SEC (lib/play/types.ts). A4: true on a phone and a computer alike; a signed-out
            LINK signs in first (lib/pending-link.ts), and the demo songs need no account. */}
        Uses the first {MAX_TRACK_MIN}&nbsp;minutes of any song; a longer one is trimmed on our end. Free account to play your own songs. Use audio you have the rights to.
      </p>
    </form>
  );
}
