import { config } from '../config/config';
import { CrawlPageResult } from '../models/scan.model';
import { logger } from '../utils/logger';
import { fetchSitemapUrls } from './sitemap.service';

function normalizeDomain(input: string): string {
  let d = input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return d.toLowerCase();
}

function originFromDomain(domain: string): string {
  return `https://${normalizeDomain(domain)}`;
}

function canonicalPathUrl(baseOrigin: string, href: string): string {
  const u = new URL(href, baseOrigin);
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return u.origin + path;
}

function isLikelyHtmlPageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = (u.pathname || '/').toLowerCase();
    if (path === '/' || !path.includes('.')) return true;
    const blockedExt = [
      '.pdf',
      '.mp4',
      '.mov',
      '.avi',
      '.mkv',
      '.webm',
      '.mp3',
      '.wav',
      '.zip',
      '.rar',
      '.7z',
      '.dmg',
      '.exe',
      '.ppt',
      '.pptx',
      '.key',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.csv',
      '.json',
      '.xml',
      '.txt',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.svg',
      '.webp',
      '.ico',
      '.css',
      '.js',
      '.map',
    ];
    return !blockedExt.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

function stripTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractAttr(tag: string, attr: string): string {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return decodeHtml((m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim());
}

function extractTagInner(html: string, tagName: string): string {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = html.match(re);
  return stripTags(m?.[1] ?? '');
}

function extractMetaDescription(html: string): string {
  const candidates = [
    /<meta[^>]*name\s*=\s*["']description["'][^>]*>/i,
    /<meta[^>]*property\s*=\s*["']og:description["'][^>]*>/i,
  ];
  for (const re of candidates) {
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const content = extractAttr(tag, 'content');
    if (content) return content;
  }
  return '';
}

function extractLinks(html: string, baseOrigin: string): string[] {
  const hrefRe = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'>\s]+))[^>]*>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = decodeHtml((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;
    try {
      const abs = canonicalPathUrl(baseOrigin, raw);
      out.push(abs);
    } catch {
      /* ignore malformed URLs */
    }
  }
  return [...new Set(out)];
}

function extractInvalidNavLinks(html: string): { href: string; reason: string; context: string }[] {
  const rows: { href: string; reason: string; context: string }[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && rows.length < 100) {
    const attrs = m[1] ?? '';
    const inner = stripTags(m[2] ?? '').slice(0, 120);
    const href = extractAttr(attrs, 'href');
    let reason = '';
    if (!href) reason = 'missing_href';
    else if (href === '#' || href === '#!' || href === '#/' || /^#+$/.test(href)) reason = 'hash_only_not_navigable';
    else if (/^javascript:/i.test(href)) reason = 'javascript_href';
    if (!reason) continue;
    const key = `${reason}|${href}|${inner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ href: href || '(missing)', reason, context: inner || 'anchor' });
  }
  return rows;
}

function titleCaseWords(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function suggestImageAlt(src: string, pageTitle: string, primaryHeading: string): string {
  const baseText = primaryHeading || pageTitle || 'Page image';
  let fileHint = '';
  try {
    const u = new URL(src);
    const part = (u.pathname.split('/').pop() || '').replace(/\.[a-z0-9]{2,6}$/i, '');
    fileHint = part.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    fileHint = src.replace(/\?.*$/, '').split('/').pop()?.replace(/\.[a-z0-9]{2,6}$/i, '') || '';
    fileHint = fileHint.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (fileHint) return titleCaseWords(fileHint).slice(0, 120);
  return titleCaseWords(baseText).slice(0, 120);
}

function extractImageData(
  html: string,
  baseOrigin: string,
  pageTitle: string,
  primaryHeading: string
): { src: string; alt: string; suggestedAlt?: string }[] {
  const images: { src: string; alt: string; suggestedAlt?: string }[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0] ?? '';
    const rawSrc = extractAttr(tag, 'src');
    if (!rawSrc) continue;
    let absSrc = rawSrc;
    try {
      absSrc = new URL(rawSrc, baseOrigin).toString();
    } catch {
      // Keep raw src if URL normalization fails.
    }
    if (seen.has(absSrc)) continue;
    seen.add(absSrc);
    const alt = extractAttr(tag, 'alt');
    images.push({
      src: absSrc,
      alt,
      suggestedAlt: alt.trim() ? undefined : suggestImageAlt(absSrc, pageTitle, primaryHeading),
    });
  }
  return images;
}

async function checkLink(href: string, baseOrigin: string, timeoutMs: number): Promise<boolean> {
  try {
    const u = new URL(href, baseOrigin);
    if (u.origin !== baseOrigin) return true;
    const res = await fetch(u.toString(), {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAgentBot/1.0)' },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    if (!res) return false;
    return res.ok || res.status === 405;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(workers: number, items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const totalWorkers = Math.max(1, workers);
  await Promise.all(
    Array.from({ length: totalWorkers }).map(async () => {
      while (idx < items.length) {
        const current = items[idx++];
        await fn(current);
      }
    })
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Aborted'));
  throw reason;
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  if (!parent) return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(parent.reason || new Error('Aborted'));
  parent.addEventListener('abort', onAbort, { once: true });
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
    { once: true }
  );
  return controller.signal;
}

export async function crawlDomain(domainInput: string, abortSignal?: AbortSignal): Promise<CrawlPageResult[]> {
  const domain = normalizeDomain(domainInput);
  const baseOrigin = originFromDomain(domain);
  const configured = config.maxPagesPerScan;
  const pageLimit = configured <= 0 ? config.maxDiscoverablePages : configured;
  const workerCount = config.crawlWorkers;
  const maxDepth = config.crawlMaxDepth;
  const requestTimeoutMs = config.crawlTimeoutMs;
  const maxBrokenLinkChecks = configured <= 0 ? Math.max(500, config.brokenLinkCheckCap) : config.brokenLinkCheckCap;

  const startedAt = Date.now();
  const timeBudgetMs = config.scanTimeBudgetMs;
  const visited = new Set<string>();
  const queued = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: baseOrigin + '/', depth: 0 }];
  queued.add(baseOrigin + '/');

  let sitemapUrls: string[] = [];
  try {
    sitemapUrls = await fetchSitemapUrls(baseOrigin);
    for (const u of sitemapUrls) {
      if (!isLikelyHtmlPageUrl(u)) continue;
      if (queued.has(u)) continue;
      if (queue.length >= pageLimit) break;
      queue.push({ url: u, depth: 1 });
      queued.add(u);
    }
  } catch (e) {
    logger.warn('sitemap bootstrap failed', { error: String(e) });
  }

  const results: CrawlPageResult[] = [];
  const discoveredLinks = new Set<string>();

  async function visitUrl(target: { url: string; depth: number }): Promise<void> {
    throwIfAborted(abortSignal);
    if (Date.now() - startedAt > timeBudgetMs) {
      throw new Error(`Crawl time budget exceeded (${timeBudgetMs}ms)`);
    }
    if (results.length >= pageLimit) return;
    const { url, depth } = target;
    if (visited.has(url)) return;
    visited.add(url);

    const start = Date.now();
    let loadTimeMs = 0;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAgentBot/1.0)' },
        signal: timeoutSignal(requestTimeoutMs, abortSignal),
      }).catch(() => null);
      loadTimeMs = Date.now() - start;
      if (!resp || !resp.ok) {
        results.push({
          url,
          title: '',
          metaDescription: '',
          canonical: '',
          h1Count: 0,
          h2Count: 0,
          wordCount: 0,
          headings: [],
          links: [],
          imagesWithoutAlt: 0,
          brokenLinks: [url],
          invalidNavLinks: [],
          images: [],
          loadTimeMs,
          contentSnippet: '',
        });
        return;
      }

      const html = await resp.text();
      const title = extractTagInner(html, 'title');
      const metaDescription = extractMetaDescription(html);
      const canonicalTag = html.match(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0] || '';
      const canonical = extractAttr(canonicalTag, 'href');
      const h1Matches = html.match(/<h1\b[^>]*>/gi) ?? [];
      const h2Matches = html.match(/<h2\b[^>]*>/gi) ?? [];
      const headings = [...html.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)]
        .map((m) => stripTags(m[1] || ''))
        .filter(Boolean)
        .slice(0, 15);
      const links = extractLinks(html, baseOrigin);
      const text = stripTags(html);
      const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
      const contentSnippet = text.slice(0, 750);
      const images = extractImageData(html, baseOrigin, title, headings[0] || '');
      const imagesWithoutAlt = images.reduce((n, img) => n + (img.alt.trim() ? 0 : 1), 0);
      const invalidNavLinks = extractInvalidNavLinks(html);

      for (const link of links) {
        if (!isLikelyHtmlPageUrl(link)) continue;
        discoveredLinks.add(link);
        if (depth >= maxDepth || results.length >= pageLimit) continue;
        if (queue.length >= pageLimit) continue;
        if (queued.has(link) || visited.has(link)) continue;
        queued.add(link);
        queue.push({ url: link, depth: depth + 1 });
      }

      results.push({
        url,
        title,
        metaDescription,
        canonical,
        h1Count: h1Matches.length,
        h2Count: h2Matches.length,
        wordCount,
        headings,
        links: links.slice(0, 150),
        imagesWithoutAlt,
        brokenLinks: [],
        invalidNavLinks,
        images: images.slice(0, 120),
        loadTimeMs,
        contentSnippet,
      });
    } catch (e) {
      loadTimeMs = Date.now() - start;
      logger.warn('crawl page error', { url, error: String(e) });
      results.push({
        url,
        title: '',
        metaDescription: '',
        canonical: '',
        h1Count: 0,
        h2Count: 0,
        wordCount: 0,
        headings: [],
        links: [],
        imagesWithoutAlt: 0,
        brokenLinks: [url],
        invalidNavLinks: [],
        images: [],
        loadTimeMs,
        contentSnippet: '',
      });
    }
  }

  while (queue.length > 0 && results.length < pageLimit) {
    throwIfAborted(abortSignal);
    if (Date.now() - startedAt > timeBudgetMs) {
      logger.warn('Crawl time budget reached', { domain, timeBudgetMs, pages: results.length });
      break;
    }
    const batch = queue.splice(0, workerCount);
    await runWithConcurrency(workerCount, batch, visitUrl);
  }

  // Validate internal links in parallel once per unique URL.
  const brokenByUrl = new Set<string>();
  const linkTargets = [...discoveredLinks].slice(0, maxBrokenLinkChecks);
  await runWithConcurrency(workerCount, linkTargets, async (href) => {
    throwIfAborted(abortSignal);
    const ok = await checkLink(href, baseOrigin, Math.max(3000, requestTimeoutMs - 2000));
    if (!ok) brokenByUrl.add(href);
  });

  for (const row of results) {
    row.brokenLinks = row.links.filter((href) => brokenByUrl.has(href)).slice(0, 40);
  }

  logger.info('Crawl finished', {
    domain,
    pages: results.length,
    workers: workerCount,
    sitemapSeeded: sitemapUrls.length,
    maxDepth,
    linkChecks: Math.min(linkTargets.length, maxBrokenLinkChecks),
    timeBudgetMs,
    elapsedMs: Date.now() - startedAt,
  });

  return results;
}
