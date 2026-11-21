// SEO-07. Google ignores llms.txt; it is cheap and derived from the registry.
import { llmsText } from '../../lib/seo/llms.ts';

// Static (review of #332): the body's DB-17 chord claim is read at build, and the Redeploy that a
// Vercel env change needs rebuilds it (lib/chords-claim.ts).
export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsText(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
