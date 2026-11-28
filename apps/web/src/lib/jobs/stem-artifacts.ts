// QW-2: does a DONE job still have play-along audio in R2? Used by the signed-in paste dedupe
// (lib/library-server.ts pasteHooks) so a re-paste never lands the user back on a job that
// cannot play: a job whose encoder failed (status 'done', downloads only: the stems route's
// `encode_failed`) or whose objects are gone. Such a job is skipped and the paste makes a new job.
//
// ONE list of the whole job folder `<job>/` (#494 item 2). Keys sort byte-wise, and every `_`
// key (`_input.wav`, `_stems/dl/*`, `_stems/play/*`: at most 13) sorts before the lower-case
// loop folders (`<stem>/<bars>bar_…wav`), so the first page of 100 holds every stem key.
// Answers:
//   true   a playable stem (`<job>/_stems/play/<stem>.opus`) is listed: reuse the job.
//   true   #494 item 2, LEGACY: objects under `<job>/` but no `_stems/` key at all, i.e. a job
//          from before V3-J2 kept stems (the stems route's 'unavailable'; the job page still
//          has its loops). Reused as before QW-2: it is what that paste bought, and re-making
//          it would charge again (a pre-042 job has no debit row for FREE RE-PASTE to claim).
//   false  `_stems/` keys but none playable (encode failed), or nothing under `<job>/` at all
//          (the objects are gone): the job cannot play; the paste does NOT reuse it.
//   null   could not tell (rate limit refused, IP hash unavailable, R2 list failed, or a
//          truncated page with no playable key). The caller treats null as "reuse" — the
//          pre-QW-2 behaviour — so an R2 or DB fault can never turn one paste into a second
//          charged job (MONEY: no double charge on an infra fault).
//
// COST BOUND: a ListObjectsV2 is a billable Class A operation. Every probe is first admitted by
// checkPasteProbeRate (lib/admission.ts), the probe's OWN per-IP budget (#494 item 4: it no
// longer spends checkStemListRate, the player's GET /api/jobs/:id/stems budget). Only a paste
// whose live hit is DONE probes; an in-flight hit never does.
//
// Logs: the job id and a short error label only (never the SDK error object: $metadata, bucket).
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2 } from '@/lib/r2';
import { checkPasteProbeRate } from '@/lib/admission';
import { STEM_PREFIX, stemNameFromPlayKey } from '@/lib/stem-keys';

const label = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);

export async function hasPlayableStems(jobId: string, clientIpHash: () => string): Promise<boolean | null> {
  try {
    const rate = await checkPasteProbeRate(clientIpHash());
    if (!rate.allowed) return null;
    const folder = `${jobId}/`;
    const listed = await r2.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME!,
        Prefix: folder,
        MaxKeys: 100, // every `_` key sorts first (see above); cannot under-report a stem key
      }),
    );
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string' && k.startsWith(folder));
    if (keys.some((k) => k.startsWith(`${folder}${STEM_PREFIX}`) && stemNameFromPlayKey(k) !== null)) return true;
    if (listed.IsTruncated) return null;
    if (keys.some((k) => k.startsWith(`${folder}${STEM_PREFIX}`))) return false; // encode failed
    return keys.length > 0; // legacy (loops, no stems) → true; nothing left → false
  } catch (err) {
    console.error('paste dedupe: stem probe failed; reusing the job', { jobId, cause: label(err) });
    return null;
  }
}
