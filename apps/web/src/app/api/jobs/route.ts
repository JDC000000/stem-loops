import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { checkAdmission, RATE_LIMIT, RATE_WINDOW_MS } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';
import { canonicalizeYoutubeUrl } from '@/lib/youtube-url';

const VALID_BARS = new Set([1, 2, 4, 8]);
const DEFAULT_STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const VALID_STEMS = new Set(DEFAULT_STEMS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_MSG =
  "You're going a bit fast, or we're at capacity right now. Give it a minute and try again.";

// POST /api/jobs — create a job. Two input kinds:
//   • upload  (V2 PRIMARY): body { jobId, uploadKey, filename?, stems?, loop_length_bars? }
//     — file already PUT to R2 by the browser (see POST /api/uploads).
//   • youtube (DEFERRED/parked): body { url, ... }.
// The Python worker claims via FOR UPDATE SKIP LOCKED (Gate 0 S2 / option a).
export async function POST(request: NextRequest) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      // Malformed JSON is a client error, not ours (QA P2 — was surfacing as a 500).
      return NextResponse.json(
        { error_code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' },
        { status: 400 }
      );
    }

    // `request.json()` also succeeds for valid-JSON non-objects (`null`, `7`, `"x"`),
    // and destructuring those throws a TypeError that surfaced as a bogus 500 + Sentry
    // alert. Same guard uploads/route.ts already uses (QA/hardening H10).
    const b = body ?? {};

    // ── Upload job ──────────────────────────────────────────────────────────
    if (b.uploadKey) {
      const { jobId, uploadKey, filename, stems, loop_length_bars } = b;
      if (typeof jobId !== 'string' || !UUID_RE.test(jobId) || typeof uploadKey !== 'string') {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'Missing or invalid upload reference.' },
          { status: 400 }
        );
      }
      const ubars = loop_length_bars ?? 4;
      if (!VALID_BARS.has(ubars)) {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'loop_length_bars must be 1, 2, 4, or 8' },
          { status: 400 }
        );
      }
      // Reject an explicitly-provided but empty/invalid stems list instead of silently
      // defaulting (QA P2 — a direct-API caller should get a clear 400, not a surprise set).
      if (
        stems !== undefined &&
        (!Array.isArray(stems) ||
          stems.length === 0 ||
          !stems.every((s: unknown) => VALID_STEMS.has(s as string)))
      ) {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'stems must be a non-empty list of supported stems.' },
          { status: 400 }
        );
      }
      const uStems = Array.isArray(stems) && stems.length ? stems : DEFAULT_STEMS;

      // R9 / PRD §6.1: admission BEFORE the (Replicate-spending) job exists. Uploads
      // bypass YouTube's gate, so this is the primary abuse/spend surface.
      const clientIpHash = clientIpHashOf(request);
      const adm = await checkAdmission(clientIpHash);
      if (!adm.allowed) {
        return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
      }

      // Atomic per-IP rate enforcement (QA P0/P1): the count and the insert are ONE
      // statement, so a concurrent burst can't each pass checkAdmission's pre-check and then
      // insert unconditionally (the old TOCTOU). If already at the cap → 0 rows → 429.
      const ins = await db.query(
        `INSERT INTO jobs (id, input_kind, upload_r2_key, original_filename, requested_stems,
                           loop_length_bars, status, client_ip_hash, client_fingerprint)
         SELECT $1, 'upload', $2, $3, $4, $5, 'queued', $6, ''
         WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $6
                AND created_at >= NOW() - ($7::int * INTERVAL '1 millisecond')) < $8
         RETURNING id`,
        [jobId, uploadKey, typeof filename === 'string' ? filename.slice(0, 255) : null,
         uStems, ubars, clientIpHash, RATE_WINDOW_MS, RATE_LIMIT]
      );
      if (!ins.rowCount) {
        return NextResponse.json({ error_code: 'RATE_LIMITED', message: RATE_LIMIT_MSG }, { status: 429 });
      }
      // No external queue: the Python worker claims the job straight off the jobs table
      // (status='queued', FOR UPDATE SKIP LOCKED). pg-boss was vestigial and removed.
      return NextResponse.json({ id: jobId, status: 'queued' }, { status: 201 });
    }

    // ── YouTube job (DEFERRED — kept, unwired at the worker until S1 clears) ──
    // SECURITY / A1 scope (review #7): the worker would actually run Cobalt/yt-dlp for a
    // youtube job (STUB_MODE isn't set in prod env), so gate the parked path at the door
    // — it can't be reached from the UI, but this blocks a direct API call too.
    if (process.env.ALLOW_YOUTUBE_INPUT !== 'true') {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'YouTube input is not available yet.' },
        { status: 403 }
      );
    }

    const { url, stems, loop_length_bars } = b;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error_code: 'DOWNLOAD_INVALID_URL', message: 'url is required' }, { status: 400 });
    }
    // QA fix (P2/UX #3 + P3 #5): canonicalize + require an actual video id, and accept
    // Shorts/Music/live/embed links, not just /watch and bare youtu.be/. The worker's
    // SSRF allowlist (downloader/__init__.py) already accepts any youtube.com/youtu.be
    // path, so this only widens web-layer *validation* — no new server-side attack
    // surface. Persisting the canonicalized form (not the raw pasted url) also strips
    // tracking params before the row ever exists.
    const canonicalUrl = canonicalizeYoutubeUrl(url);
    if (!canonicalUrl) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'That doesn’t look like a YouTube video link. Paste a full youtube.com or youtu.be URL.' },
        { status: 400 }
      );
    }
    const bars = loop_length_bars ?? 4;
    if (!VALID_BARS.has(bars)) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'loop_length_bars must be 1, 2, 4, or 8' },
        { status: 400 }
      );
    }
    // QA fix (P2 #2): the youtube branch never validated `stems` against VALID_STEMS —
    // {"stems":["piano","banana"]} was persisted and handed to the worker. Mirror the
    // upload branch's check exactly.
    if (
      stems !== undefined &&
      (!Array.isArray(stems) ||
        stems.length === 0 ||
        !stems.every((s: unknown) => VALID_STEMS.has(s as string)))
    ) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'stems must be a non-empty list of supported stems.' },
        { status: 400 }
      );
    }

    const clientIpHash = clientIpHashOf(request);
    const adm = await checkAdmission(clientIpHash);
    if (!adm.allowed) {
      return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
    }

    const id = randomUUID();
    const requestedStems = Array.isArray(stems) && stems.length ? stems : DEFAULT_STEMS;

    const ins = await db.query(
      `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint)
       SELECT $1, $2, $3, $4, 'queued', $5, ''
       WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $5
              AND created_at >= NOW() - ($6::int * INTERVAL '1 millisecond')) < $7
       RETURNING id`,
      [id, canonicalUrl, requestedStems, bars, clientIpHash, RATE_WINDOW_MS, RATE_LIMIT]
    );
    if (!ins.rowCount) {
      return NextResponse.json({ error_code: 'RATE_LIMITED', message: RATE_LIMIT_MSG }, { status: 429 });
    }

    return NextResponse.json({ id, status: 'queued' }, { status: 201 });
  } catch (err) {
    // This try/catch swallows the error into a clean 500 JSON response (PRD §6.1 — no
    // stack trace in the response body), which means it never reaches Next.js's own
    // onRequestError hook. Report it to Sentry explicitly, or it just vanishes.
    Sentry.captureException(err);
    console.error('POST /api/jobs error:', err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
