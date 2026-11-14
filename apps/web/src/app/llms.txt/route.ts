// SEO-07. Google ignores llms.txt; it is cheap and derived from the registry.
import { llmsText } from '../../lib/seo/llms.ts';

export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsText(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
