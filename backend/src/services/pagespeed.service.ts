import { config } from '../config/config';
import { getSetting } from './db.service';
import { logger } from '../utils/logger';

export interface PageSpeedMetrics {
  lcpMs?: number;
  fcpMs?: number;
  cls?: number;
  inpMs?: number;
  ttfbMs?: number;
  lighthousePerformanceScore?: number;
  lighthouseSeoScore?: number;
  lighthouseAccessibilityScore?: number;
  lighthouseBestPracticesScore?: number;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function readNumeric(obj: unknown, path: string[]): number | undefined {
  let cursor: any = obj;
  for (const key of path) {
    cursor = cursor?.[key];
    if (cursor == null) return undefined;
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

export async function fetchPageSpeedMetrics(url: string): Promise<PageSpeedMetrics | null> {
  try {
    const configuredApiKey = getSetting('GOOGLE_API_KEY') || getSetting('GoogleAPIKey') || config.googleApiKey;
    const apiBase = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
      url
    )}&strategy=${encodeURIComponent(config.pageSpeedStrategy)}&category=PERFORMANCE&category=SEO&category=ACCESSIBILITY&category=BEST_PRACTICES`;
    const api = configuredApiKey ? `${apiBase}&key=${encodeURIComponent(configuredApiKey)}` : apiBase;
    const resp = await fetch(api, { method: 'GET', signal: timeoutSignal(config.pageSpeedTimeoutMs) });
    if (!resp.ok) return null;
    const json = await resp.json();
    const audits = (json as any)?.lighthouseResult?.audits;
    const categories = (json as any)?.lighthouseResult?.categories || {};
    const loadingExp = (json as any)?.loadingExperience?.metrics || {};
    const originExp = (json as any)?.originLoadingExperience?.metrics || {};

    const lcpMs =
      readNumeric(loadingExp, ['LARGEST_CONTENTFUL_PAINT_MS', 'percentile']) ||
      readNumeric(originExp, ['LARGEST_CONTENTFUL_PAINT_MS', 'percentile']) ||
      readNumeric(audits, ['largest-contentful-paint', 'numericValue']);

    const cls =
      readNumeric(loadingExp, ['CUMULATIVE_LAYOUT_SHIFT_SCORE', 'percentile']) ||
      readNumeric(originExp, ['CUMULATIVE_LAYOUT_SHIFT_SCORE', 'percentile']) ||
      readNumeric(audits, ['cumulative-layout-shift', 'numericValue']);

    const inpMs =
      readNumeric(loadingExp, ['INTERACTION_TO_NEXT_PAINT', 'percentile']) ||
      readNumeric(originExp, ['INTERACTION_TO_NEXT_PAINT', 'percentile']) ||
      readNumeric(audits, ['interaction-to-next-paint', 'numericValue']);

    const fcpMs = readNumeric(audits, ['first-contentful-paint', 'numericValue']);
    const ttfbMs = readNumeric(audits, ['server-response-time', 'numericValue']);
    const lighthousePerformanceScore = readNumeric(categories, ['performance', 'score']);
    const lighthouseSeoScore = readNumeric(categories, ['seo', 'score']);
    const lighthouseAccessibilityScore = readNumeric(categories, ['accessibility', 'score']);
    const lighthouseBestPracticesScore = readNumeric(categories, ['best-practices', 'score']);

    return {
      lcpMs,
      fcpMs,
      cls,
      inpMs,
      ttfbMs,
      lighthousePerformanceScore:
        lighthousePerformanceScore == null ? undefined : Math.round(lighthousePerformanceScore * 100),
      lighthouseSeoScore: lighthouseSeoScore == null ? undefined : Math.round(lighthouseSeoScore * 100),
      lighthouseAccessibilityScore:
        lighthouseAccessibilityScore == null ? undefined : Math.round(lighthouseAccessibilityScore * 100),
      lighthouseBestPracticesScore:
        lighthouseBestPracticesScore == null ? undefined : Math.round(lighthouseBestPracticesScore * 100),
    };
  } catch (e) {
    logger.warn('pagespeed fetch failed', { url, error: String(e) });
    return null;
  }
}

export async function fetchPageSpeedForUrls(urls: string[]): Promise<Map<string, PageSpeedMetrics>> {
  const out = new Map<string, PageSpeedMetrics>();
  if (!config.enablePageSpeed || config.pageSpeedPagesLimit <= 0) return out;
  const subset = urls.slice(0, config.pageSpeedPagesLimit);
  for (const url of subset) {
    const m = await fetchPageSpeedMetrics(url);
    if (m) out.set(url, m);
  }
  return out;
}
