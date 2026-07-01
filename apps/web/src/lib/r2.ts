import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

// 7-day TTL, re-minted on every GET /api/jobs/:id read (PRD §8 anti-goal #4).
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

export async function mintSignedUrl(r2Key: string, expiresIn = SEVEN_DAYS_SEC): Promise<string> {
  return getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
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
  expiresIn = 600, // 10 min — long enough for a 50 MB upload on a slow line, short enough to not linger
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
