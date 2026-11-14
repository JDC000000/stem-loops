// SEO-07 body builder (kept out of route.ts: a route file may export only route fields).
import { publishedPages } from './pages.ts';
import { ENTITY_LIMITS, ENTITY_ONE_LINER, SITE_URL } from './site.ts';


export function llmsText(): string {
  const lines = [
    '# stem-loops', '', `> ${ENTITY_ONE_LINER}`, '',
    `${ENTITY_LIMITS} The six stems are drums, bass, guitar, keys, vocals and other; each has a fader, mute and solo. ` +
      'The chord track is an estimate made from the audio, not a transcription. Tempo and pitch change are not available yet. ' +
      'There are no lyrics. Bar-length loops from each stem can be downloaded as 24-bit WAV files.',
    '', 'stem-loops is not a sample pack and not the RNA stem-loop structure.', '', '## Pages',
    ...publishedPages().filter((p) => p.llms).map((p) => `- [${p.title}](${SITE_URL}${p.path === '/' ? '/' : p.path}): ${p.description}`),
    '',
  ];
  return lines.join('\n');
}
