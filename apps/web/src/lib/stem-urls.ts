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
import { stemPlayR2Key, stemDownloadR2Key } from '@/lib/stem-keys';

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
    { expiresIn },
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
    { expiresIn },
  );
}
