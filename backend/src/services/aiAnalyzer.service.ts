import OpenAI from 'openai';
import { CrawlPageResult, SeoPageReport, AiIssueItem } from '../models/scan.model';
import { getOpenAiKey } from './secrets.service';
import { logger } from '../utils/logger';
import { config } from '../config/config';
import type { PageSpeedMetrics } from './pagespeed.service';

type AggregateAudit = {
  total_pages: number;
  pages_missing_meta: number;
  pages_missing_h1: number;
  images_without_alt: number;
  broken_links: number;
  duplicate_titles: number;
};

type AggregateAiResponse = {
  globalRecommendations?: string[];
  issueFixes?: Record<string, string>;
  metaDescriptionTemplate?: string;
  titleTemplate?: string;
  internalLinkingTips?: string[];
  contentImprovementTips?: string[];
};

type PageAiResponse = {
  pasteReadyFixes?: { issueType?: string; issueSummary?: string; improvedContent?: string }[];
  improvedContent?: {
    h1?: string;
    title?: string;
    metaDescription?: string;
    bodyCopy?: string;
  };
};

type BacklinkSignalsByUrl = Map<
  string,
  {
    internalReferringPages: number;
    uniqueExternalDomainsLinked: number;
    externalLinksCount: number;
    internalAuthorityScore: number;
    backlinkQualityScore: number;
  }
>;

function buildAggregatePrompt(summary: AggregateAudit): string {
  return `You are an expert technical SEO consultant.

We already ran rule-based SEO checks locally for all pages.
Use the aggregated results below and return concise, actionable recommendations.

Return JSON only.

Audit summary:
${JSON.stringify(summary, null, 2)}

Output schema:
{
  "globalRecommendations": ["..."],
  "issueFixes": {
    "missing_title": "...",
    "missing_meta_description": "...",
    "missing_h1": "...",
    "multiple_h1": "...",
    "broken_links": "...",
    "images_without_alt": "...",
    "duplicate_title": "...",
    "slow_page": "...",
    "missing_canonical": "..."
  },
  "metaDescriptionTemplate": "",
  "titleTemplate": "",
  "internalLinkingTips": ["..."],
  "contentImprovementTips": ["..."]
}`;
}

function normalizeReport(raw: Partial<SeoPageReport>, pageUrl: string): SeoPageReport {
  const issues: AiIssueItem[] = Array.isArray(raw.issues)
    ? raw.issues
        .filter((i): i is AiIssueItem => i && typeof i === 'object')
        .map((i) => ({
          type: String(i.type || 'issue'),
          severity: (['high', 'medium', 'low'].includes(String(i.severity)) ? i.severity : 'medium') as
            | 'high'
            | 'medium'
            | 'low',
          description: String(i.description || '').trim() || 'See page metrics.',
          fix: String(i.fix || '').trim() || 'Review this URL in Search Console.',
        }))
    : [];

  return {
    url: pageUrl,
    seoScore: Math.min(100, Math.max(0, Number(raw.seoScore) || 0)),
    issues,
    suggestedTitle: String(raw.suggestedTitle ?? '').trim(),
    suggestedMetaDescription: String(raw.suggestedMetaDescription ?? '').trim(),
    contentImprovements: Array.isArray(raw.contentImprovements)
      ? raw.contentImprovements.map((x) => String(x).trim()).filter(Boolean)
      : [],
    internalLinkSuggestions: Array.isArray(raw.internalLinkSuggestions)
      ? raw.internalLinkSuggestions.map((x) => String(x).trim()).filter(Boolean)
      : [],
    pasteReadyFixes: Array.isArray(raw.pasteReadyFixes)
      ? raw.pasteReadyFixes
          .map((x) => ({
            issueType: String(x?.issueType ?? '').trim(),
            issueSummary: String(x?.issueSummary ?? '').trim(),
            improvedContent: String(x?.improvedContent ?? '').trim(),
          }))
          .filter((x) => x.issueType && x.improvedContent)
      : [],
    improvedContent: raw.improvedContent
      ? {
          h1: String(raw.improvedContent.h1 ?? '').trim() || undefined,
          title: String(raw.improvedContent.title ?? '').trim() || undefined,
          metaDescription: String(raw.improvedContent.metaDescription ?? '').trim() || undefined,
          bodyCopy: String(raw.improvedContent.bodyCopy ?? '').trim() || undefined,
        }
      : undefined,
  };
}

export async function analyzePageWithAi(page: CrawlPageResult): Promise<SeoPageReport> {
  const map = await analyzePagesWithAi([page]);
  return (
    map.get(page.url) ||
    normalizeReport(
      {
        seoScore: 0,
        issues: [],
        suggestedTitle: page.title,
        suggestedMetaDescription: page.metaDescription,
        contentImprovements: [],
        internalLinkSuggestions: [],
      },
      page.url
    )
  );
}

function pageTopic(page: CrawlPageResult): string {
  const u = new URL(page.url);
  const slug = u.pathname
    .split('/')
    .filter(Boolean)
    .slice(-1)[0]
    ?.replace(/[-_]+/g, ' ')
    .replace(/\bpage\b/gi, '')
    .trim();
  const heading = page.headings[0]?.trim();
  const title = page.title.trim();
  const source = heading || slug || title || 'Page';
  return source
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 80);
}

function titleSuggestion(page: CrawlPageResult, forceUnique = false): string {
  const cleaned = page.title.trim();
  if (!forceUnique && cleaned.length >= 30 && cleaned.length <= 60) return cleaned;
  const base = pageTopic(page).slice(0, 42) || 'Page';
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  return `${base} | ${host}`.slice(0, 60);
}

function metaSuggestion(page: CrawlPageResult, template?: string): string {
  const current = page.metaDescription.trim();
  if (current.length >= 110 && current.length <= 160) return current;
  const topic = pageTopic(page) || 'this page';
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  const fallback = `Learn about ${topic} on ${host}. Explore key details, practical tips, and related resources.`;
  return (template ? template.replace(/\{topic\}/g, topic).replace(/\{site\}/g, host) : fallback).slice(0, 158);
}

function h1Suggestion(page: CrawlPageResult): string {
  const heading = page.headings[0]?.trim();
  if (heading) return heading.slice(0, 80);
  return pageTopic(page).slice(0, 80);
}

function bodyCopySuggestion(page: CrawlPageResult): string {
  const topic = pageTopic(page) || 'this page';
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  const intentHint = page.url.includes('/blog')
    ? 'practical insights and expert guidance'
    : page.url.includes('/contact')
      ? 'ways to connect with our team and get support'
      : page.url.includes('/about')
        ? 'who we are, what we do, and the value we deliver'
        : 'key capabilities, benefits, and implementation details';
  return (
    `${topic} on ${host} provides ${intentHint}. ` +
    `This page should clearly explain core features, expected outcomes, and real-world use cases for decision-makers. ` +
    `Add a concise value proposition, trust signals, and a clear next step so users can evaluate fit and take action confidently.`
  ).slice(0, 700);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function uniqueCount(arr: string[]): number {
  return new Set(arr).size;
}

function hasAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

function computeTrendBoost(page: CrawlPageResult): number {
  const nowYear = new Date().getFullYear();
  const url = page.url.toLowerCase();
  const title = page.title.toLowerCase();
  const freshnessTerms = ['new', 'latest', 'best', 'top', 'guide', 'update', 'trends', '2025', '2026'];
  const yearSignal = [String(nowYear), String(nowYear - 1)].some((y) => url.includes(y) || title.includes(y));
  const termSignal = hasAny(`${url} ${title}`, freshnessTerms);
  const recencyBonus = yearSignal ? 12 : 0;
  const termBonus = termSignal ? 8 : 0;
  return Math.min(25, recencyBonus + termBonus);
}

function computeFreeKeywordInsights(
  page: CrawlPageResult,
  seoScore: number,
  issueTypes: string[]
): SeoPageReport['keywordInsights'] {
  const topic = pageTopic(page).toLowerCase();
  const topicTokens = tokenize(topic);
  const titleTokens = tokenize(page.title);
  const headingTokens = tokenize((page.headings || []).join(' '));
  const bodyTokens = tokenize(page.contentSnippet || '');

  const keyword = topic || 'general topic';
  const relevanceOverlap = uniqueCount(topicTokens.filter((t) => titleTokens.includes(t) || headingTokens.includes(t)));
  const relevanceBase = topicTokens.length ? Math.round((relevanceOverlap / topicTokens.length) * 100) : 50;
  const titleMatchBoost = page.title.toLowerCase().includes(keyword) ? 15 : 0;
  const headingMatchBoost = (page.headings[0] || '').toLowerCase().includes(keyword) ? 12 : 0;
  const bodySupportBoost = bodyTokens.some((t) => topicTokens.includes(t)) ? 8 : 0;
  const keywordPlacementScore = Math.max(10, Math.min(100, relevanceBase + titleMatchBoost + headingMatchBoost + bodySupportBoost));

  // Free "opportunity" model: prioritize pages likely to gain from better snippets/content.
  const ctrGap =
    (issueTypes.includes('missing_title') ? 18 : 0) +
    (issueTypes.includes('missing_meta_description') ? 20 : 0) +
    (issueTypes.includes('duplicate_title') ? 12 : 0);
  const positionGap = seoScore >= 50 && seoScore <= 80 ? 18 : seoScore < 50 ? 10 : 6;
  const trendBoost = computeTrendBoost(page);
  const intentMatchBoost = hasAny(page.url, ['/blog', '/guide', '/services', '/product']) ? 8 : 4;
  const technicalDrag =
    (issueTypes.includes('slow_page') ? 8 : 0) +
    (issueTypes.includes('broken_links') ? 10 : 0) +
    (issueTypes.includes('invalid_or_nonfunctional_link') ? 6 : 0);

  const opportunityScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(keywordPlacementScore * 0.4 + ctrGap * 0.2 + positionGap * 0.15 + trendBoost * 0.15 + intentMatchBoost * 0.1 - technicalDrag)
    )
  );
  const rankingProbability = Math.max(5, Math.min(95, Math.round(opportunityScore * 0.9 + (seoScore * 0.25))));

  return {
    targetKeyword: keyword,
    keywordPlacementScore,
    rankingProbability,
    opportunityScore,
    trendBoost,
  };
}

function computeBacklinkSignals(pages: CrawlPageResult[]): BacklinkSignalsByUrl {
  const byUrl: BacklinkSignalsByUrl = new Map();
  const knownUrls = new Set(pages.map((p) => p.url));
  const incomingInternal = new Map<string, Set<string>>();

  for (const p of pages) {
    for (const href of p.links || []) {
      if (!knownUrls.has(href) || href === p.url) continue;
      const bucket = incomingInternal.get(href) ?? new Set<string>();
      bucket.add(p.url);
      incomingInternal.set(href, bucket);
    }
  }

  for (const p of pages) {
    const fromHost = new URL(p.url).hostname.replace(/^www\./, '');
    const externalDomains = new Set<string>();
    let externalLinksCount = 0;
    for (const href of p.links || []) {
      try {
        const to = new URL(href);
        const toHost = to.hostname.replace(/^www\./, '');
        if (toHost !== fromHost) {
          externalDomains.add(toHost);
          externalLinksCount++;
        }
      } catch {
        // Ignore malformed URLs.
      }
    }

    const internalReferringPages = incomingInternal.get(p.url)?.size ?? 0;
    const internalAuthorityScore = Math.max(0, Math.min(100, 25 + internalReferringPages * 9));
    const externalDiversityBonus = Math.min(20, externalDomains.size * 2);
    const externalVolumePenalty = externalLinksCount > 50 ? 10 : externalLinksCount > 25 ? 5 : 0;
    const backlinkQualityScore = Math.max(
      0,
      Math.min(100, Math.round(internalAuthorityScore * 0.75 + externalDiversityBonus - externalVolumePenalty))
    );

    byUrl.set(p.url, {
      internalReferringPages,
      uniqueExternalDomainsLinked: externalDomains.size,
      externalLinksCount,
      internalAuthorityScore,
      backlinkQualityScore,
    });
  }

  return byUrl;
}

function localContentImprovements(page: CrawlPageResult, issueTypes: string[]): string[] {
  const tips: string[] = [];
  const topic = pageTopic(page);
  if (issueTypes.includes('missing_h1') || issueTypes.includes('multiple_h1')) {
    tips.push(`Add exactly one clear H1 focused on "${topic}".`);
  }
  if (issueTypes.includes('missing_title') || issueTypes.includes('duplicate_title')) {
    tips.push('Create a unique title (45-60 chars) with page topic + brand.');
  }
  if (issueTypes.includes('missing_meta_description')) {
    tips.push('Write a unique meta description (120-160 chars) with value + CTA.');
  }
  if (issueTypes.includes('low_word_count')) {
    tips.push('Expand to 500+ words with sections: overview, benefits, use cases, FAQs.');
  }
  if (issueTypes.includes('images_without_alt')) {
    tips.push('Add descriptive alt text for key images using contextual keywords.');
  }
  if (issueTypes.includes('slow_page')) {
    tips.push('Improve speed by optimizing images, reducing JS, and fixing LCP/INP bottlenecks.');
  }
  if (tips.length === 0) {
    tips.push(`Enhance topical depth for "${topic}" with examples, proof points, and internal links.`);
  }
  return tips.slice(0, 4);
}

function buildLocalPasteReadyFixes(
  page: CrawlPageResult,
  issueTypes: string[],
  duplicateTitle: boolean
): {
  improvedContent: { h1?: string; title?: string; metaDescription?: string; bodyCopy?: string };
  pasteReadyFixes: { issueType: string; issueSummary: string; improvedContent: string }[];
} {
  const improved = {
    h1: h1Suggestion(page),
    title: titleSuggestion(page, duplicateTitle),
    metaDescription: metaSuggestion(page),
    bodyCopy: bodyCopySuggestion(page),
  };
  const byType = new Map<string, string>();
  if (issueTypes.includes('missing_h1') || issueTypes.includes('multiple_h1')) {
    byType.set('missing_h1', `<h1>${improved.h1}</h1>`);
    byType.set('multiple_h1', `<h1>${improved.h1}</h1>`);
  }
  if (issueTypes.includes('duplicate_title') || issueTypes.includes('missing_title') || duplicateTitle) {
    byType.set('duplicate_title', improved.title);
    byType.set('missing_title', improved.title);
  }
  if (issueTypes.includes('missing_meta_description')) {
    byType.set('missing_meta_description', improved.metaDescription);
  }
  if (issueTypes.includes('low_word_count')) {
    byType.set('low_word_count', improved.bodyCopy);
  }

  const pasteReadyFixes = issueTypes
    .filter((t) => byType.has(t))
    .map((t) => ({
      issueType: t,
      issueSummary: t.replace(/_/g, ' '),
      improvedContent: byType.get(t) as string,
    }));

  return { improvedContent: improved, pasteReadyFixes };
}

function buildPagePrompt(
  page: CrawlPageResult,
  issueTypes: string[],
  duplicateTitle: boolean
): string {
  return `You are an SEO copywriter generating paste-ready fixes.

Return JSON only.

Input page:
${JSON.stringify(
  {
    url: page.url,
    title: page.title,
    metaDescription: page.metaDescription,
    headings: page.headings.slice(0, 5),
    h1Count: page.h1Count,
    wordCount: page.wordCount,
    contentSnippet: (page.contentSnippet || '').slice(0, 650),
    issueTypes,
    duplicateTitle,
  },
  null,
  2
)}

Requirements:
- Mention only issues in issueTypes.
- improvedContent.title: unique, 45-60 chars when possible.
- improvedContent.metaDescription: 120-160 chars when possible.
- improvedContent.h1: concise, natural.
- improvedContent.bodyCopy: 90-150 words and directly relevant to this page.
- pasteReadyFixes[].improvedContent must be final text developers can paste.
- If issueType is missing_h1 or multiple_h1, provide HTML like <h1>...</h1>.
- For duplicate_title or missing_title, provide only title text.
- For missing_meta_description, provide only meta description text.
- For low_word_count, provide one ready-to-paste paragraph.

Output schema:
{
  "improvedContent": {
    "h1": "...",
    "title": "...",
    "metaDescription": "...",
    "bodyCopy": "..."
  },
  "pasteReadyFixes": [
    {
      "issueType": "missing_h1",
      "issueSummary": "No H1 heading on page",
      "improvedContent": "<h1>...</h1>"
    }
  ]
}`;
}

async function generatePageAiContent(
  client: OpenAI,
  page: CrawlPageResult,
  issueTypes: string[],
  duplicateTitle: boolean
): Promise<PageAiResponse | null> {
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are an SEO assistant. Return only valid JSON. Output must be directly paste-ready for web developers.',
        },
        { role: 'user', content: buildPagePrompt(page, issueTypes, duplicateTitle) },
      ],
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    });
    const text = completion.choices[0]?.message?.content?.trim() || '{}';
    return JSON.parse(text) as PageAiResponse;
  } catch (e) {
    logger.warn('OpenAI per-page content generation failed; using local fallback.', {
      pageUrl: page.url,
      error: String(e),
    });
    return null;
  }
}

function scoreBand(value: number, good: number, ok: number, maxPenalty: number): number {
  if (value <= good) return 0;
  if (value >= ok) return maxPenalty;
  const ratio = (value - good) / (ok - good);
  return Math.round(maxPenalty * ratio);
}

function computeSeoScore(page: CrawlPageResult, duplicateTitle: boolean): number {
  let score = 100;
  const titleLen = page.title.trim().length;
  const metaLen = page.metaDescription.trim().length;
  const words = page.wordCount;
  const linkCount = page.links.length;

  if (!titleLen) score -= 20;
  else score -= scoreBand(Math.abs(55 - titleLen), 0, 35, 8);

  if (!metaLen) score -= 16;
  else score -= scoreBand(Math.abs(145 - metaLen), 0, 70, 7);

  if (page.h1Count === 0) score -= 14;
  else if (page.h1Count > 1) score -= 10;

  // Content depth penalty varies by page rather than one flat deduction.
  if (words < 150) score -= 10;
  else if (words < 300) score -= 7;
  else if (words < 500) score -= 4;

  // Reward pages with richer internal link graph; penalize too-thin linking.
  if (linkCount < 3) score -= 4;
  else if (linkCount < 8) score -= 2;
  else if (linkCount > 40) score += 1;

  if (page.imagesWithoutAlt > 0) score -= Math.min(16, page.imagesWithoutAlt * 2);
  if (page.brokenLinks.length > 0) score -= Math.min(18, page.brokenLinks.length * 4);
  if (duplicateTitle) score -= 10;
  if (page.loadTimeMs > config.slowPageMs) score -= scoreBand(page.loadTimeMs, config.slowPageMs, 8000, 10);
  if (!page.canonical.trim()) score -= 4;

  // Slight per-page variance factor from URL depth to avoid identical buckets.
  const depth = new URL(page.url).pathname.split('/').filter(Boolean).length;
  if (depth >= 3) score -= 1;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function pushIssue(
  issues: AiIssueItem[],
  type: string,
  severity: 'high' | 'medium' | 'low',
  description: string,
  aiFixes: Record<string, string>
): void {
  issues.push({
    type,
    severity,
    description,
    fix: aiFixes[type] || 'Fix this issue based on SEO best practices for this page.',
  });
}

export async function analyzePagesWithAi(pages: CrawlPageResult[]): Promise<Map<string, SeoPageReport>> {
  return analyzePagesWithAiWithSignals(pages, new Map<string, PageSpeedMetrics>());
}

export async function analyzePagesWithAiWithSignals(
  pages: CrawlPageResult[],
  perfByUrl: Map<string, PageSpeedMetrics>
): Promise<Map<string, SeoPageReport>> {
  const key = getOpenAiKey();
  const map = new Map<string, SeoPageReport>();
  const openAiClient = key ? new OpenAI({ apiKey: key }) : null;

  const titleBuckets = new Map<string, string[]>();
  for (const p of pages) {
    const t = p.title.trim().toLowerCase();
    if (!t) continue;
    const bucket = titleBuckets.get(t) ?? [];
    bucket.push(p.url);
    titleBuckets.set(t, bucket);
  }
  const duplicateTitlePages = new Set<string>();
  for (const urls of titleBuckets.values()) {
    if (urls.length < 2) continue;
    for (const u of urls) duplicateTitlePages.add(u);
  }

  const aggregate: AggregateAudit = {
    total_pages: pages.length,
    pages_missing_meta: pages.filter((p) => !p.metaDescription.trim()).length,
    pages_missing_h1: pages.filter((p) => p.h1Count === 0).length,
    images_without_alt: pages.reduce((n, p) => n + p.imagesWithoutAlt, 0),
    broken_links: pages.reduce((n, p) => n + p.brokenLinks.length, 0),
    duplicate_titles: duplicateTitlePages.size,
  };

  let aggregateAi: AggregateAiResponse = {};
  if (openAiClient) {
    try {
      const completion = await openAiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are an SEO advisor. Return only valid JSON matching the requested schema and keep recommendations practical.',
          },
          { role: 'user', content: buildAggregatePrompt(aggregate) },
        ],
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      });
      const text = completion.choices[0]?.message?.content?.trim() || '{}';
      aggregateAi = JSON.parse(text) as AggregateAiResponse;
    } catch (e) {
      logger.warn('OpenAI aggregate analysis failed; using local recommendations.', { error: String(e) });
    }
  }

  const aiFixes = aggregateAi.issueFixes ?? {};
  const MAX_PAGE_AI_REWRITES = 15;
  let pageRewriteCalls = 0;
  const backlinkSignalsByUrl = computeBacklinkSignals(pages);

  const calcWeighted = (
    page: CrawlPageResult,
    issueTypes: string[],
    duplicateTitle: boolean,
    perf?: PageSpeedMetrics
  ): SeoPageReport['scoreBreakdown'] => {
    const wc = page.wordCount;
    const titleLen = page.title.trim().length;
    const metaLen = page.metaDescription.trim().length;
    const links = page.links.length;
    const load = perf?.lcpMs ?? page.loadTimeMs;

    const content = Math.max(
      0,
      100 - (wc < 150 ? 42 : wc < 300 ? 30 : wc < 500 ? 18 : 6) - (issueTypes.includes('missing_h1') ? 18 : 0)
    );
    const technical = Math.max(
      0,
      100
        - (issueTypes.includes('broken_links') ? 25 : 0)
        - (issueTypes.includes('invalid_or_nonfunctional_link') ? 15 : 0)
        - (issueTypes.includes('missing_canonical') ? 10 : 0)
        - (links < 3 ? 8 : links < 8 ? 4 : 0)
    );
    const onPage = Math.max(
      0,
      100
        - (issueTypes.includes('missing_title') ? 30 : 0)
        - (duplicateTitle ? 25 : 0)
        - (issueTypes.includes('multiple_h1') ? 15 : 0)
        - (titleLen > 0 && (titleLen < 30 || titleLen > 65) ? 8 : 0)
        - (metaLen > 0 && (metaLen < 110 || metaLen > 165) ? 6 : 0)
    );
    const uxPenaltyFromSpeed =
      (load && load > 4000 ? 20 : load && load > 2500 ? 10 : 0) +
      (perf?.cls && perf.cls > 0.25 ? 20 : perf?.cls && perf.cls > 0.1 ? 10 : 0) +
      (perf?.inpMs && perf.inpMs > 500 ? 20 : perf?.inpMs && perf.inpMs > 200 ? 10 : 0) +
      (issueTypes.includes('slow_page') ? 15 : 0);
    const ux = Math.max(0, 100 - uxPenaltyFromSpeed);
    const backlinks = backlinkSignalsByUrl.get(page.url)?.backlinkQualityScore ?? 45;
    const weightedTotal = Math.round(content * 0.25 + technical * 0.2 + backlinks * 0.2 + onPage * 0.2 + ux * 0.15);
    return { content, technical, backlinks, onPage, ux, weightedTotal };
  };

  for (const p of pages) {
    const isDuplicateTitle = duplicateTitlePages.has(p.url);
    const issues: AiIssueItem[] = [];
    if (!p.title.trim()) pushIssue(issues, 'missing_title', 'high', 'Missing page title.', aiFixes);
    if (!p.metaDescription.trim()) {
      pushIssue(issues, 'missing_meta_description', 'high', 'Missing meta description.', aiFixes);
    }
    if (p.h1Count === 0) pushIssue(issues, 'missing_h1', 'high', 'No H1 heading on the page.', aiFixes);
    if (p.h1Count > 1) pushIssue(issues, 'multiple_h1', 'medium', `Multiple H1 headings detected (${p.h1Count}).`, aiFixes);
    if (p.imagesWithoutAlt > 0) {
      pushIssue(issues, 'images_without_alt', 'medium', `${p.imagesWithoutAlt} image(s) missing ALT text.`, aiFixes);
    }
    if (p.brokenLinks.length > 0) {
      pushIssue(
        issues,
        'broken_links',
        'high',
        `${p.brokenLinks.length} broken or unreachable internal link(s) detected.`,
        aiFixes
      );
    }
    if (isDuplicateTitle) {
      pushIssue(issues, 'duplicate_title', 'medium', 'Title is duplicated across multiple pages.', aiFixes);
    }
    if (p.loadTimeMs > config.slowPageMs) {
      pushIssue(issues, 'slow_page', 'medium', `Page load time is high (~${p.loadTimeMs}ms).`, aiFixes);
    }
    if (!p.canonical.trim()) {
      pushIssue(issues, 'missing_canonical', 'low', 'Canonical tag is missing.', aiFixes);
    }
    if (p.wordCount < 250) {
      pushIssue(issues, 'low_word_count', 'low', `Content appears thin (${p.wordCount} words).`, aiFixes);
    }
    for (const inv of p.invalidNavLinks || []) {
      pushIssue(
        issues,
        'invalid_or_nonfunctional_link',
        'medium',
        `Non-functional link (${inv.reason}): ${inv.href}`,
        aiFixes
      );
    }

    const issueTypes = [...new Set(issues.map((x) => x.type))];
    const perf = perfByUrl.get(p.url);
    const backlinkInsights = backlinkSignalsByUrl.get(p.url);
    const localEnhanced = buildLocalPasteReadyFixes(p, issueTypes, isDuplicateTitle);

    let pageAi = null as PageAiResponse | null;
    const shouldCallPageAi = Boolean(openAiClient) && issueTypes.length > 0 && pageRewriteCalls < MAX_PAGE_AI_REWRITES;
    if (shouldCallPageAi) {
      pageRewriteCalls++;
      pageAi = await generatePageAiContent(openAiClient as OpenAI, p, issueTypes, isDuplicateTitle);
    }

    const pageFixMap = new Map<string, string>();
    for (const row of pageAi?.pasteReadyFixes ?? []) {
      const t = String(row.issueType ?? '').trim();
      const fix = String(row.improvedContent ?? '').trim();
      if (t && fix) pageFixMap.set(t, fix);
    }
    for (const row of localEnhanced.pasteReadyFixes) {
      if (!pageFixMap.has(row.issueType)) pageFixMap.set(row.issueType, row.improvedContent);
    }
    for (const issue of issues) {
      const issueSpecific = pageFixMap.get(issue.type);
      if (issueSpecific) issue.fix = issueSpecific;
    }

    const seoScore = computeSeoScore(p, isDuplicateTitle);
    const r: SeoPageReport = {
      url: p.url,
      seoScore,
      scoreBreakdown: calcWeighted(p, issueTypes, isDuplicateTitle, perf),
      keywordInsights: computeFreeKeywordInsights(p, seoScore, issueTypes),
      backlinkInsights,
      performanceMetrics: perf
        ? { source: 'pagespeed', lcpMs: perf.lcpMs, cls: perf.cls, inpMs: perf.inpMs, ttfbMs: perf.ttfbMs }
        : { source: 'crawl_estimate', lcpMs: p.loadTimeMs },
      issues,
      suggestedTitle: titleSuggestion(p, isDuplicateTitle),
      suggestedMetaDescription: metaSuggestion(p, aggregateAi.metaDescriptionTemplate),
      contentImprovements:
        aggregateAi.contentImprovementTips?.length
          ? aggregateAi.contentImprovementTips.slice(0, 2).concat(localContentImprovements(p, issueTypes)).slice(0, 4)
          : localContentImprovements(p, issueTypes),
      internalLinkSuggestions: aggregateAi.internalLinkingTips?.slice(0, 2) ?? [
        'Add contextual internal links from related pages using descriptive anchor text.',
      ],
      pasteReadyFixes: issueTypes
        .filter((t) => pageFixMap.has(t))
        .map((t) => ({
          issueType: t,
          issueSummary: t.replace(/_/g, ' '),
          improvedContent: pageFixMap.get(t) as string,
        })),
      improvedContent: {
        h1: String(pageAi?.improvedContent?.h1 ?? localEnhanced.improvedContent.h1 ?? '').trim() || undefined,
        title: String(pageAi?.improvedContent?.title ?? localEnhanced.improvedContent.title ?? '').trim() || undefined,
        metaDescription: String(
          pageAi?.improvedContent?.metaDescription ?? localEnhanced.improvedContent.metaDescription ?? ''
        ).trim() || undefined,
        bodyCopy: String(pageAi?.improvedContent?.bodyCopy ?? localEnhanced.improvedContent.bodyCopy ?? '').trim() || undefined,
      },
    };
    map.set(p.url, r);
  }

  return map;
}
