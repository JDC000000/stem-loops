// SEO-05. Never add aggregateRating or review: there are none, and the landing bans social proof.
import { ENTITY_ONE_LINER, MAX_TRACK_MIN, OG_IMAGE, SAME_AS, SITE_URL } from './site.ts';
import { pageFor } from './pages.ts';

const ORG = `${SITE_URL}/#org`;
const APP = `${SITE_URL}/#app`;
const JON = `${SITE_URL}/about#jon`;

export function homeGraph() {
  const about = pageFor('/about');
  const withPerson = Boolean(about && about.published); // M9: no Person URL until /about is live
  const org: Record<string, unknown> = {
    '@type': 'Organization', '@id': ORG, name: 'stem-loops', url: `${SITE_URL}/`,
    logo: { '@type': 'ImageObject', url: `${SITE_URL}/apple-touch-icon.png` },
    ...(withPerson ? { founder: { '@id': JON } } : {}),
    ...(SAME_AS.length ? { sameAs: SAME_AS } : {}),
  };
  const app: Record<string, unknown> = {
    '@type': 'WebApplication', '@id': APP, name: 'stem-loops', url: `${SITE_URL}/`,
    description: ENTITY_ONE_LINER,
    applicationCategory: 'MultimediaApplication', applicationSubCategory: 'Music practice',
    operatingSystem: 'Windows, macOS, ChromeOS, Linux (desktop)',
    browserRequirements: 'Requires Google Chrome on a desktop or laptop computer.',
    inLanguage: 'en', isAccessibleForFree: true,
    featureList: [
      'Six stems: drums, bass, guitar, keys, vocals and other',
      'A fader, mute and solo on every stem',
      'A chord track estimated from the audio',
      'Looping of a detected section',
      'Bar-length loops from each stem as 24-bit WAV files',
      `Uses the first ${MAX_TRACK_MIN} minutes of any song`,
      'Files deleted after 24 hours',
    ],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'CAD', category: 'free' },
    image: `${SITE_URL}${OG_IMAGE}`,
    publisher: { '@id': ORG },
    ...(withPerson ? { creator: { '@id': JON } } : {}),
  };
  const graph: Record<string, unknown>[] = [
    org,
    { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: `${SITE_URL}/`, name: 'stem-loops', inLanguage: 'en', publisher: { '@id': ORG } },
    app,
  ];
  if (withPerson) graph.push({ '@type': 'Person', '@id': JON, name: 'Jon Cartwright', url: `${SITE_URL}/about` });
  return { '@context': 'https://schema.org', '@graph': graph };
}
