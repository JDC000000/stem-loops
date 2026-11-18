// SEO-07 body builder (kept out of route.ts: a route file may export only route fields).
import { publishedPages } from './pages.ts';
import { ENTITY_LIMITS, ENTITY_ONE_LINER, SITE_URL } from './site.ts';
import { demoPages } from './demo-pages.ts';
import { CHORDS_LINE_SHOWN } from '../chords-claim.ts';


export function llmsText(): string {
  const lines = [
    '# stem-loops', '', `> ${ENTITY_ONE_LINER}`, '',
    `${ENTITY_LIMITS} The six stems are drums, bass, guitar, keys, vocals and other; each has a fader, mute and solo. ` +
      // DB-17 (lib/chords-claim.ts): no chord claim when the switch is off.
      (CHORDS_LINE_SHOWN ? 'The chord track is an estimate made from the audio, not a transcription. ' : '') +
      'Tempo and pitch change are not available yet. ' +
      'There are no lyrics. Bar-length loops from each stem can be downloaded as 24-bit WAV files.',
    '', 'stem-loops is not a sample pack and not the RNA stem-loop structure.', '', '## Pages',
    ...publishedPages().filter((p) => p.llms).map((p) => `- [${p.title}](${SITE_URL}${p.path === '/' ? '/' : p.path}): ${p.description}`),
    '', '## Demo songs', '',
    // QA-55: the demo songs play in the real player for anyone, signed out included (#302).
    'Anyone can try these in the player without signing in. Opening the player with your own songs needs an account.',
    ...demoPages().map((d) => `- [${d.title}](${SITE_URL}${d.path}): ${d.description}`),
    '',
  ];
  return lines.join('\n');
}
