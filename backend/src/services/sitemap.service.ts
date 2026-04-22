import { logger } from '../utils/logger';

/** Fetch same-origin page URLs from sitemap.xml / nested sitemap indexes (best-effort). */
export async function fetchSitemapUrls(baseOrigin: string): Promise<string[]> {
  const origin = new URL(baseOrigin).origin;
  const pageUrls = new Set<string>();
  const queue: string[] = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  const fetchedXml = new Set<string>();
  const maxXmlFetches = 25;

  function addPageUrl(loc: string): void {
    try {
      const u = new URL(loc);
      if (u.origin !== origin) return;
      let path = u.pathname || '/';
      if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
      pageUrls.add(u.origin + path);
    } catch {
      /* skip */
    }
  }

  while (queue.length > 0 && fetchedXml.size < maxXmlFetches) {
    const sitemapUrl = queue.shift()!;
    if (fetchedXml.has(sitemapUrl)) continue;
    fetchedXml.add(sitemapUrl);

    try {
      const res = await fetch(sitemapUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAgentBot/1.0)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());

      for (const loc of locs) {
        if (/\.xml(\?|$)/i.test(loc)) {
          if (!fetchedXml.has(loc) && queue.length < 100) queue.push(loc);
        } else {
          addPageUrl(loc);
        }
      }
    } catch (e) {
      logger.debug('sitemap fetch failed', { sitemapUrl, error: String(e) });
    }
  }

  logger.info('Sitemap URLs discovered', { count: pageUrls.size, origin });
  return [...pageUrls];
}
