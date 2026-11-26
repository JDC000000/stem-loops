// QW-2: does a DONE job still have play-along audio in R2? Used by the signed-in paste dedupe
// (lib/library-server.ts pasteHooks) so a re-paste never lands the user back on a job that
// cannot play: a job whose encoder failed (status 'done', downloads only: the stems route's
// `encode_failed`) or whose objects are gone. Such a job is skipped and the paste makes a new job.
//
// Answers:
//   true   at least one playable stem (`<job>/_stems/play/<stem>.opus`) is listed: reuse the job.
//   false  none listed: the job cannot play; the paste does NOT reuse it.
//   null   could not tell (rate limit refused, IP hash unavailable, R2 list failed). The caller
//          treats null as "reuse" — the pre-QW-2 behaviour — so an R2 or DB fault can never turn
//          one paste into a second charged job (MONEY: no double charge on an infra fault).
//
// COST BOUND: a ListObjectsV2 is a billable Class A operation. Every probe is first admitted by
// checkStemListRate (lib/admission.ts), the per-IP 60/min budget GET /api/jobs/:id/stems already
// spends on the same list, so a scripted re-paste loop costs no more R2 than refetching stems.
// Only a paste whose live hit is DONE probes; an in-flight hit never does.
//
// Logs: the job id and a short error label only (never the SDK error object: $metadata, bucket).
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2 } from '@/lib/r2';
import { checkStemListRate } from '@/lib/admission';
import { STEM_PLAY_PREFIX, stemNameFromPlayKey } from '@/lib/stem-keys';

const label = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);

export async function hasPlayableStems(jobId: string, clientIpHash: () => string): Promise<boolean | null> {
  try {
    const rate = await checkStemListRate(clientIpHash());
    if (!rate.allowed) return null;
    const listed = await r2.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME!,
        Prefix: `${jobId}/${STEM_PLAY_PREFIX}`,
        MaxKeys: 100, // at most six live here; cannot under-report
      }),
    );
    return (listed.Contents ?? []).some((o) => typeof o.Key === 'string' && stemNameFromPlayKey(o.Key) !== null);
  } catch (err) {
    console.error('paste dedupe: stem probe failed; reusing the job', { jobId, cause: label(err) });
    return null;
  }
}
