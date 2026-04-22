import { config } from '../config/config';
import { logger } from '../utils/logger';

export interface PageSpeedMetrics {
  lcpMs?: number;
  cls?: number;
  inpMs?: number;
  ttfbMs?: number;
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
    const apiBase = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
      url
    )}&strategy=${encodeURIComponent(config.pageSpeedStrategy)}&category=PERFORMANCE`;
    const api = config.googleApiKey ? `${apiBase}&key=${encodeURIComponent(config.googleApiKey)}` : apiBase;
    const resp = await fetch(api, { method: 'GET', signal: timeoutSignal(config.pageSpeedTimeoutMs) });
    if (!resp.ok) return null;
    const json = await resp.json();
    const audits = (json as any)?.lighthouseResult?.audits;
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

    const ttfbMs = readNumeric(audits, ['server-response-time', 'numericValue']);

    return { lcpMs, cls, inpMs, ttfbMs };
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
