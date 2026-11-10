// V3-J2 — signed GET URLs for the retained full-length stems.
//
// Why this is a separate module and NOT part of lib/r2.ts: the node:test contract
// tests (test/play-chords-contract.test.mjs, test/csp-third-party-origins.test.mjs)
// load r2.ts by inlining it as a base64 `data:` URL, which is how they work around
// the `@/` path alias the bare runner cannot resolve. A `data:` module has no base
// URL, so ANY relative import added to r2.ts fails to resolve and takes those tests
// down with it — observed, 10 failures. Keeping the stem additions out of r2.ts
// leaves that file byte-identical to its reviewed state.
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2 } from '@/lib/r2';
import { stemR2Key, STEM_SIGNED_URL_TTL_SEC } from '@/lib/stem-keys';

export async function mintStemSignedUrl(
  jobId: string,
  stem: string,
  expiresIn: number = STEM_SIGNED_URL_TTL_SEC,
  filename?: string,
): Promise<string> {
  // `filename` forces a browser download rather than inline navigation. The <a
  // download> attribute is ignored cross-origin and R2 is a different domain, so
  // the disposition has to ride on the presigned URL — same reasoning as
  // mintSignedUrl in r2.ts. Sanitised to stay a single safe header value.
  const contentDisposition = filename
    ? `attachment; filename="${filename.replace(/[\r\n"\\]/g, '_').slice(0, 200)}"`
    : undefined;
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: stemR2Key(jobId, stem),
      ResponseContentDisposition: contentDisposition,
    }),
    { expiresIn },
  );
}
