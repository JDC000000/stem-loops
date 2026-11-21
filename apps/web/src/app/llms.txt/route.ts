// SEO-07. Google ignores llms.txt; it is cheap and derived from the registry.
import { llmsText } from '../../lib/seo/llms.ts';

// Read per request: the body carries the DB-17 chord claim, which is a runtime switch
// (lib/chords-claim.ts).
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(llmsText(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
