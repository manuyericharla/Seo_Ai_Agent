import { getSetting } from './db.service';

export interface SerpLiveRankResult {
  keyword: string;
  targetDomain: string;
  location: string;
  device: 'desktop' | 'mobile';
  found: boolean;
  position: number | null;
  matchedUrl: string | null;
  topResults: Array<{ position: number; title: string; link: string; snippet: string }>;
}

function getSerpApiKey(): string {
  return getSetting('SERPAPI_KEY') || process.env.SERPAPI_KEY || '';
}

function normDomain(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return s.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

export async function fetchSerpLiveRank(params: {
  keyword: string;
  targetDomain: string;
  location?: string;
  device?: 'desktop' | 'mobile';
  num?: number;
}): Promise<SerpLiveRankResult> {
  const apiKey = getSerpApiKey();
  if (!apiKey) throw new Error('Missing SERPAPI_KEY');
  const keyword = params.keyword.trim();
  const targetDomain = normDomain(params.targetDomain);
  if (!keyword) throw new Error('keyword is required');
  if (!targetDomain) throw new Error('targetDomain is required');
  const location = (params.location || 'India').trim();
  const device = params.device === 'mobile' ? 'mobile' : 'desktop';
  const num = Math.max(10, Math.min(100, Number(params.num) || 30));

  const qs = new URLSearchParams({
    engine: 'google',
    q: keyword,
    location,
    google_domain: 'google.com',
    gl: 'in',
    hl: 'en',
    num: String(num),
    api_key: apiKey,
  });
  if (device === 'mobile') qs.set('device', 'mobile');

  const resp = await fetch(`https://serpapi.com/search.json?${qs.toString()}`, {
    method: 'GET',
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`SerpAPI error (${resp.status})`);
  const json = (await resp.json()) as any;
  const organic = Array.isArray(json?.organic_results) ? json.organic_results : [];
  const topResults = organic.slice(0, num).map((r: any) => ({
    position: Number(r.position || 0),
    title: String(r.title || ''),
    link: String(r.link || ''),
    snippet: String(r.snippet || ''),
  }));
  const match = topResults.find((r) => normDomain(r.link) === targetDomain);
  return {
    keyword,
    targetDomain,
    location,
    device,
    found: Boolean(match),
    position: match?.position ?? null,
    matchedUrl: match?.link ?? null,
    topResults,
  };
}

export async function testSerpApiConnection(keyword = 'seo audit tools'): Promise<{
  ok: boolean;
  checkedKeyword: string;
  organicCount: number;
}> {
  const r = await fetchSerpLiveRank({
    keyword,
    targetDomain: 'google.com',
    location: 'India',
    device: 'desktop',
    num: 10,
  });
  return {
    ok: true,
    checkedKeyword: keyword,
    organicCount: r.topResults.length,
  };
}

