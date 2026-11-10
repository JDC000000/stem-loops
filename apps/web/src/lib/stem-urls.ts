// V3-J2 — signed GET URLs for the retained stems.
//
// Separate from lib/r2.ts on purpose: the node:test contract tests
// (play-chords-contract, csp-third-party-origins) load r2.ts by inlining it as a
// base64 `data:` URL to work around the `@/` alias the bare runner cannot resolve.
// A `data:` module has no base URL, so ANY relative import added to r2.ts fails to
// resolve — observed, 10 failing tests. Keeping stem code out leaves r2.ts
// byte-identical to its reviewed state.
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2 } from '@/lib/r2';
import {
  STEM_SIGNED_URL_TTL_SEC,
  stemPlayR2Key,
  stemDownloadR2Key,
} from '@/lib/stem-keys';

/**
 * Clamp the signed-URL lifetime INSIDE the signer, not only at the call site.
 *
 * `expiresIn` used to be a required parameter with no internal ceiling, so the only
 * thing standing between a caller and a 24-hour stem URL was the stems route
 * remembering to call min(900, ...) — and the one test that touched the TTL pinned
 * the UNCLAMPED pass-through, so a new caller passing 86400 (the planned WAV
 * download route is the obvious one) would have been green everywhere. A signer that
 * mints bearer credentials owes its own ceiling; the call-site clamp stays as well.
 *
 * Floored at 1s because the presigner rejects a zero or negative lifetime, and the
 * route can legitimately compute 1s for a job on the edge of expiry.
 */
function clampTtl(expiresIn: number): number {
  // NaN/Infinity would survive Math.min and reach the presigner, so they take the
  // ceiling rather than propagating.
  if (!Number.isFinite(expiresIn)) return STEM_SIGNED_URL_TTL_SEC;
  return Math.max(1, Math.min(Math.floor(expiresIn), STEM_SIGNED_URL_TTL_SEC));
}

function disposition(filename?: string): string | undefined {
  // Forces a browser download rather than inline navigation. The <a download>
  // attribute is ignored cross-origin and R2 is a different domain, so the
  // disposition has to ride on the presigned URL — same reasoning as r2.ts's
  // mintSignedUrl. Sanitised to stay a single safe header value.
  return filename
    ? `attachment; filename="${filename.replace(/[\r\n"\\]/g, '_').slice(0, 200)}"`
    : undefined;
}

/** Signed GET for the Opus playback artifact (streamed by the mixer). */
export async function mintStemPlayUrl(
  jobId: string,
  stem: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: stemPlayR2Key(jobId, stem),
    }),
    { expiresIn: clampTtl(expiresIn) },
  );
}

/** Signed GET for the WAV download artifact (handed to a DAW). */
export async function mintStemDownloadUrl(
  jobId: string,
  stem: string,
  expiresIn: number,
  filename?: string,
): Promise<string> {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: stemDownloadR2Key(jobId, stem),
      ResponseContentDisposition: disposition(filename),
    }),
    // Same ceiling as playback. A WAV download is a bearer capability to the FULL
    // stem, so it has no claim to a longer life than the Opus one; if a download
    // route ever needs a different ceiling it must be a named constant, not an
    // unbounded argument.
    { expiresIn: clampTtl(expiresIn) },
  );
}
