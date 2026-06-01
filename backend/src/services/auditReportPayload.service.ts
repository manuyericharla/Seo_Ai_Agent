import { getActiveSetting } from './companyConfig.service';
import type { SerpRankRow } from './pdfReport.service';
import type { StoredScanReport } from './reportFile.service';
import { buildIntelligenceReport } from './intelligenceReport.service';
import { fetchSerpLiveRank } from './serpapi.service';

async function buildSerpRankRowsForReports(
  domain: string,
  reports: Array<{
    url: string;
    keywordInsights?: { targetKeyword?: string; opportunityScore?: number };
  }>
): Promise<SerpRankRow[]> {
  const liveEnabled = String(getActiveSetting('ENABLE_LIVE_SERP_RANK') || process.env.ENABLE_LIVE_SERP_RANK || 'false')
    .toLowerCase()
    .trim();
  if (liveEnabled !== 'true') return [];

  const candidates = reports
    .map((r) => ({
      pageUrl: r.url,
      keyword: String(r.keywordInsights?.targetKeyword || '').trim(),
      opportunityScore: Number(r.keywordInsights?.opportunityScore ?? 0),
    }))
    .filter((r) => r.keyword.length >= 3)
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 5);

  const rows: SerpRankRow[] = [];
  for (const c of candidates) {
    try {
      const live = await fetchSerpLiveRank({
        keyword: c.keyword,
        targetDomain: domain,
        location: 'India',
        device: 'desktop',
        num: 30,
      });
      rows.push({
        pageUrl: c.pageUrl,
        keyword: c.keyword,
        found: live.found,
        position: live.position,
        matchedUrl: live.matchedUrl,
        location: live.location,
        device: live.device,
      });
    } catch {
      // Skip live SERP failures per keyword to avoid failing full report.
    }
  }
  return rows;
}

/** Full audit payload (same shape as GET /api/reports/:scanId/json). */
export async function buildEnrichedAuditPayload(stored: StoredScanReport): Promise<Record<string, unknown>> {
  const intelligenceReport = buildIntelligenceReport(stored);
  const reports = Object.values(stored.pageReports || {});
  const avg = (arr: number[]): number => {
    if (!arr.length) return 0;
    return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
  };
  const onPageTypes = new Set([
    'missing_title',
    'missing_meta_description',
    'missing_h1',
    'multiple_h1',
    'duplicate_title',
    'low_word_count',
    'images_without_alt',
    'missing_canonical',
  ]);
  const offPageTypes = new Set(['broken_links', 'invalid_or_nonfunctional_link']);

  const onPageIssueCount = reports.reduce(
    (n, r) => n + r.issues.filter((i) => onPageTypes.has(i.type)).length,
    0
  );
  const offPageIssueCount = reports.reduce(
    (n, r) => n + r.issues.filter((i) => offPageTypes.has(i.type)).length,
    0
  );

  const onPageScores = reports.map((r) => r.scoreBreakdown?.onPage ?? r.seoScore).filter((n) => Number.isFinite(n));
  const technicalScores = reports
    .map((r) => r.scoreBreakdown?.technical ?? 0)
    .filter((n) => Number.isFinite(n));
  const backlinkScores = reports
    .map((r) => r.backlinkInsights?.backlinkQualityScore ?? r.scoreBreakdown?.backlinks ?? 0)
    .filter((n) => Number.isFinite(n));
  const internalReferrals = reports.reduce((n, r) => n + (r.backlinkInsights?.internalReferringPages ?? 0), 0);
  const uniqueExternalDomains = reports.reduce(
    (n, r) => n + (r.backlinkInsights?.uniqueExternalDomainsLinked ?? 0),
    0
  );

  const serpRankRows = await buildSerpRankRowsForReports(stored.domain, reports);

  return {
    ...stored,
    ...intelligenceReport,
    onPageAnalysis: {
      avgOnPageScore: avg(onPageScores),
      avgTechnicalScore: avg(technicalScores),
      issueCount: onPageIssueCount,
      topIssueTypes: Object.entries(
        reports
          .flatMap((r) => r.issues.map((i) => i.type))
          .filter((t) => onPageTypes.has(t))
          .reduce<Record<string, number>>((acc, t) => {
            acc[t] = (acc[t] || 0) + 1;
            return acc;
          }, {})
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => ({ type, count })),
    },
    offPageAnalysis: {
      avgOffPageScore: avg(backlinkScores),
      issueCount: offPageIssueCount,
      totalInternalReferrals: internalReferrals,
      totalUniqueExternalDomainsLinked: uniqueExternalDomains,
      note: 'Current off-page analysis is free-mode, derived from internal link authority and external domain diversity signals.',
    },
    liveRankAnalysis: {
      provider: 'serpapi',
      rows: serpRankRows,
      note: 'Live Google positions for top keyword opportunities.',
    },
    actionPlan: stored.actionPlan || [],
    actionPlanItems: stored.actionPlanItems || [],
  };
}
