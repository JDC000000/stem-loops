import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { RETENTION_SEC } from '@/lib/retention';

// R2 is S3-compatible. Locally this points at MinIO (MINIO_ENDPOINT).
export const r2 = new S3Client({
  region: 'auto',
  endpoint:
    process.env.MINIO_ENDPOINT ??
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: Boolean(process.env.MINIO_ENDPOINT), // MinIO needs path-style addressing
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});

// Download URLs are re-minted on every GET /api/jobs/:id read (PRD §8 anti-goal #4). Default
// TTL is the 24h retention window; callers pass retention.presignTtlSec(job.expires_at) so a
// URL never outlives the job's objects (the worker deletes them after expires_at).

export async function mintSignedUrl(
  r2Key: string,
  filename?: string,
  expiresIn = RETENTION_SEC,
): Promise<string> {
  // Force a browser DOWNLOAD (attachment), not inline navigation/preview. The <a download>
  // attribute is IGNORED for cross-origin URLs — R2 is a different domain from the app — so
  // without this the "Download WAV" link just navigates to the file (QA P1). R2/S3 honors
  // ResponseContentDisposition on the presigned GET regardless of origin. Filename is
  // sanitized to keep it a single safe header value (no CR/LF/quote injection).
  const contentDisposition = filename
    ? `attachment; filename="${filename.replace(/[\r\n"\\]/g, '_').slice(0, 200)}"`
    : undefined;
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      ResponseContentDisposition: contentDisposition,
    }),
    { expiresIn },
  );
}

// Presigned PUT so the browser uploads the source file DIRECT to R2 — bypassing
// Vercel's 4.5 MB serverless request-body limit (real songs exceed it).
// Retention/abuse guard (R9): short expiry + the URL is bound to the exact
// content-type AND content-length, so it can't be reused as open storage or to
// smuggle a larger/different object than was validated at admission.
export async function presignPut(
  r2Key: string,
  contentType: string,
  contentLength: number,
  expiresIn = 900, // 15 min — long enough for a 200 MB upload on a slow line, short enough to not linger
): Promise<string> {
  return getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn },
  );
}
