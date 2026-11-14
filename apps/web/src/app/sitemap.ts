// SEO-01. Built from the page registry; nothing else is listed.
import type { MetadataRoute } from 'next';
import { publishedPages } from '../lib/seo/pages.ts';
import { SITE_URL } from '../lib/seo/site.ts';

export default function sitemap(): MetadataRoute.Sitemap {
  return publishedPages().map((p) => ({ url: `${SITE_URL}${p.path === '/' ? '/' : p.path}`, lastModified: p.lastModified }));
}
