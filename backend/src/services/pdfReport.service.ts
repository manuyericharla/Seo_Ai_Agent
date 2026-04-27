import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import type { SeoPageReport } from '../models/scan.model';

export interface SerpRankRow {
  pageUrl: string;
  keyword: string;
  found: boolean;
  position: number | null;
  matchedUrl: string | null;
  location: string;
  device: 'desktop' | 'mobile';
}

export interface ScanPdfMeta {
  id: number;
  domain: string;
  started_at: string;
  completed_at: string | null;
  pages_count: number;
  seo_score_avg: number | null;
  status: string;
  github_issues_created: number;
}

/** @deprecated legacy row-based PDF */
export interface ScanPdfIssueRow {
  page_url: string;
  issue_type: string;
  message: string;
  ai_suggestion: string | null;
  status: string;
  github_issue_url: string | null;
}

function safeFilenamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'report';
}

export function suggestedFilename(domain: string, scanId: number): string {
  return `seo-report-${safeFilenamePart(domain)}-${scanId}.pdf`;
}

function issueDisplayName(type: string): string {
  const map: Record<string, string> = {
    missing_h1: 'Missing H1',
    duplicate_title: 'Duplicate Title',
    missing_title: 'Missing Title',
    low_word_count: 'Low Word Count',
    missing_meta_description: 'Missing Meta Description',
    missing_canonical: 'Missing Canonical',
  };
  return map[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function issueImpact(type: string): string {
  const map: Record<string, string> = {
    missing_h1: 'Search engines cannot clearly identify the primary topic.',
    duplicate_title: 'Reduces ranking uniqueness and can suppress CTR.',
    missing_title: 'Weak SERP relevance signal and poor click-through.',
    low_word_count: 'Thin content lowers topical authority and long-tail reach.',
    missing_meta_description: 'Lower SERP snippet quality and weaker CTR.',
    missing_canonical: 'Can create duplicate URL ambiguity over time.',
  };
  return map[type] || 'May reduce search visibility and content clarity.';
}

function severityRank(sev: string): number {
  if (sev === 'high') return 0;
  if (sev === 'medium') return 1;
  return 2;
}

function severityColor(sev: string): string {
  if (sev === 'high') return '#dc2626';
  if (sev === 'medium') return '#ea580c';
  return '#16a34a';
}

function severityBadgeLabel(sev: string): string {
  if (sev === 'high') return 'HIGH';
  if (sev === 'medium') return 'MEDIUM';
  return 'LOW';
}

function severityWithIndicator(sev: string): string {
  if (sev === 'high') return '[HIGH]';
  if (sev === 'medium') return '[MEDIUM]';
  return '[LOW]';
}

function softWrapForPdf(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .trim()
    // Only split extremely long uninterrupted tokens; keep normal words/URLs intact.
    .replace(/([A-Za-z0-9]{45})(?=[A-Za-z0-9])/g, '$1 ');
}

function displayUrl(url: string): string {
  if (url.length <= 110) return url;
  return `${url.slice(0, 72)} ... ${url.slice(-30)}`;
}

function healthStatus(avgScore: number): 'Excellent' | 'Good' | 'Needs Improvement' | 'Critical' {
  if (avgScore >= 85) return 'Excellent';
  if (avgScore >= 70) return 'Good';
  if (avgScore >= 50) return 'Needs Improvement';
  return 'Critical';
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function keywordQuickAction(rep: SeoPageReport): string {
  const issueTypes = new Set(rep.issues.map((i) => i.type));
  if (issueTypes.has('missing_title')) return 'Add unique title with primary keyword near start.';
  if (issueTypes.has('missing_meta_description')) return 'Write CTR-focused meta description (120-160 chars).';
  if (issueTypes.has('duplicate_title')) return 'Replace duplicate title with page-specific intent.';
  if (issueTypes.has('low_word_count')) return 'Expand body with intent-matched topical depth.';
  if (issueTypes.has('slow_page')) return 'Improve speed to protect rank and engagement.';
  return 'Strengthen keyword coverage across title, H1, and intro.';
}

/** Professional per-page audit (preferred). */
export function buildScanReportPdfFromPageReports(
  meta: ScanPdfMeta,
  pageReports: Record<string, SeoPageReport>,
  serpRows: SerpRankRow[] = []
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: `SEO Report — ${meta.domain}` } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    doc.pipe(stream);

    const contentWidth = doc.page.width - 72;
    const pages = Object.values(pageReports);

    const avgScore = meta.seo_score_avg != null
      ? meta.seo_score_avg
      : pages.length
        ? pages.reduce((s, p) => s + p.seoScore, 0) / pages.length
        : 0;
    const roundedAvg = Math.round(avgScore);
    const status = healthStatus(roundedAvg);

    const issueFrequency = new Map<string, number>();
    const severityTotals = { high: 0, medium: 0, low: 0 };
    const weightedTotals: number[] = [];
    for (const rep of pages) {
      if (rep.scoreBreakdown?.weightedTotal != null) weightedTotals.push(rep.scoreBreakdown.weightedTotal);
      for (const iss of rep.issues) {
        issueFrequency.set(iss.type, (issueFrequency.get(iss.type) || 0) + 1);
        if (iss.severity === 'high') severityTotals.high += 1;
        else if (iss.severity === 'medium') severityTotals.medium += 1;
        else severityTotals.low += 1;
      }
    }
    const topIssues = [...issueFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const issueSeverity = (type: string): 'high' | 'medium' | 'low' =>
      type === 'missing_h1' || type === 'missing_title' || type === 'missing_meta_description' || type === 'broken_links'
        ? 'high'
        : type === 'duplicate_title' || type === 'slow_page' || type === 'images_without_alt' || type === 'invalid_or_nonfunctional_link'
          ? 'medium'
          : 'low';

    const hasIssue = (type: string): boolean => pages.some((p) => p.issues.some((i) => i.type === type));
    const siteLift = (hasIssue('missing_h1') ? 8 : 0)
      + ((hasIssue('duplicate_title') || hasIssue('missing_title')) ? 6 : 0)
      + (hasIssue('low_word_count') ? 10 : 0)
      + 4;
    const estimatedSiteScore = clampScore(roundedAvg + siteLift);

    const leftX = 36;

    const sectionTitle = (title: string): void => {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.moveDown(0.25);
      doc.fontSize(14).fillColor('#0f172a').text(title, leftX, doc.y, { width: contentWidth, align: 'left' });
      doc.moveDown(0.35);
    };

    const line = (text: string, color = '#334155', size = 10): void => {
      doc.fontSize(size).fillColor(color).text(text, leftX, doc.y, { width: contentWidth, align: 'left' });
    };

    const ensureSpace = (required = 80): void => {
      if (doc.y + required > doc.page.height - 48) doc.addPage();
    };

    type TableColumn = { key: string; title: string; width: number; align?: 'left' | 'center' | 'right' };
    const drawTable = (
      columns: TableColumn[],
      rows: Array<Record<string, string | number>>,
      opts?: { fontSize?: number; rowPadding?: number }
    ): void => {
      const x = leftX;
      const fontSize = opts?.fontSize ?? 8;
      const rowPadding = opts?.rowPadding ?? 3;
      const totalW = columns.reduce((s, c) => s + c.width, 0);

      const drawHeader = (): void => {
        ensureSpace(40);
        const y = doc.y;
        const maxHeaderTextH = Math.max(
          ...columns.map((c) => doc.heightOfString(c.title, { width: c.width - 6, align: c.align || 'left' }))
        );
        const headerH = Math.max(22, maxHeaderTextH + 8);
        doc.rect(x, y, totalW, headerH).fillColor('#dbeafe').fill();
        let cx = x;
        for (const c of columns) {
          doc
            .fontSize(8)
            .fillColor('#0f172a')
            .text(c.title, cx + 3, y + 4, { width: c.width - 6, align: c.align || 'left' });
          cx += c.width;
        }
        cx = x;
        for (let i = 0; i < columns.length - 1; i++) {
          cx += columns[i].width;
          doc.moveTo(cx, y).lineTo(cx, y + headerH).strokeColor('#cbd5e1').stroke();
        }
        doc.y = y + headerH;
      };

      drawHeader();

      for (const row of rows) {
        const y = doc.y;
        const heights = columns.map((c) =>
          doc.heightOfString(String(row[c.key] ?? ''), { width: c.width - 6, align: c.align || 'left' })
        );
        const rowH = Math.max(16, Math.max(...heights) + rowPadding * 2);
        if (y + rowH > doc.page.height - 44) {
          doc.addPage();
          drawHeader();
        }
        const ry = doc.y;
        doc.rect(x, ry, totalW, rowH).strokeColor('#e2e8f0').stroke();
        let cx = x;
        for (const c of columns) {
          const txt = String(row[c.key] ?? '');
          doc.fontSize(fontSize).fillColor('#334155').text(txt, cx + 3, ry + rowPadding, {
            width: c.width - 6,
            align: c.align || 'left',
          });
          cx += c.width;
        }
        cx = x;
        for (let i = 0; i < columns.length - 1; i++) {
          cx += columns[i].width;
          doc.moveTo(cx, ry).lineTo(cx, ry + rowH).strokeColor('#e2e8f0').stroke();
        }
        doc.y = ry + rowH;
      }
      doc.moveDown(0.5);
    };

    doc.fontSize(20).fillColor('#0f172a').text('SEO audit report', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#334155').text(`Domain: ${meta.domain}`, { align: 'center' });
    doc.moveDown(0.8);

    sectionTitle('1. Executive Summary');
    drawTable(
      [
        { key: 'metric', title: 'Metric', width: 240 },
        { key: 'value', title: 'Value', width: 460 },
      ],
      [
        { metric: 'Domain', value: meta.domain },
        { metric: 'Total Pages Scanned', value: meta.pages_count },
        { metric: 'Average SEO Score', value: roundedAvg },
        { metric: 'Overall SEO Health', value: status },
      ],
      { fontSize: 9 }
    );
    doc.moveDown(0.25);
    line('Main problems detected:');
    if (topIssues.length === 0) line('- No major issues detected in this scan.');
    if (topIssues.length > 0) {
      drawTable(
        [
          { key: 'issue', title: 'Issue', width: 170 },
          { key: 'affected', title: 'Pages Affected', width: 120, align: 'center' },
          { key: 'severity', title: 'Severity', width: 120, align: 'center' },
          { key: 'impact', title: 'Impact', width: 290 },
        ],
        topIssues.map(([type, count]) => {
          const sev = issueSeverity(type);
          return {
            issue: issueDisplayName(type),
            affected: count,
            severity: severityWithIndicator(sev),
            impact: issueImpact(type),
          };
        }),
        { fontSize: 8 }
      );
    }
    line(`Estimated score after fix: ${estimatedSiteScore}`);

    sectionTitle('2. Issue Severity Legend');
    drawTable(
      [
        { key: 'severity', title: 'Severity', width: 180 },
        { key: 'meaning', title: 'Meaning', width: 520 },
      ],
      [
        { severity: 'HIGH', meaning: 'Critical ranking issue' },
        { severity: 'MEDIUM', meaning: 'Important improvement' },
        { severity: 'LOW', meaning: 'Minor optimization' },
      ]
    );

    sectionTitle('3. Website Issue Distribution');
    drawTable(
      [
        { key: 'issue', title: 'Issue', width: 360 },
        { key: 'affected', title: 'Pages Affected', width: 170, align: 'center' },
        { key: 'severity', title: 'Severity', width: 170, align: 'center' },
      ],
      [...issueFrequency.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([type, count]) => ({
          issue: issueDisplayName(type),
          affected: count,
          severity: severityWithIndicator(issueSeverity(type)),
        }))
    );
    ensureSpace(250);
    line('Issue Severity Distribution');
    const totalIssues = Math.max(1, severityTotals.high + severityTotals.medium + severityTotals.low);
    const pieCx = leftX + 130;
    const pieCy = doc.y + 92;
    const pieR = 72;
    const slices = [
      { key: 'high', label: 'HIGH -> High Severity', count: severityTotals.high, color: '#ef4444' },
      { key: 'medium', label: 'MEDIUM -> Medium Severity', count: severityTotals.medium, color: '#f59e0b' },
      { key: 'low', label: 'LOW -> Low Severity', count: severityTotals.low, color: '#eab308' },
    ];
    let start = -Math.PI / 2;
    for (const s of slices) {
      if (s.count <= 0) continue;
      const angle = (s.count / totalIssues) * Math.PI * 2;
      const steps = Math.max(8, Math.ceil((angle / (Math.PI * 2)) * 64));
      doc.moveTo(pieCx, pieCy);
      for (let i = 0; i <= steps; i++) {
        const t = start + (angle * i) / steps;
        doc.lineTo(pieCx + pieR * Math.cos(t), pieCy + pieR * Math.sin(t));
      }
      doc.lineTo(pieCx, pieCy).fillColor(s.color).fill();
      start += angle;
    }
    doc.circle(pieCx, pieCy, pieR).lineWidth(1).strokeColor('#cbd5e1').stroke();

    const legendX = leftX + 250;
    let legendY = doc.y + 28;
    for (const s of slices) {
      const pct = Math.round((s.count / totalIssues) * 100);
      doc.rect(legendX, legendY, 10, 10).fillColor(s.color).fill();
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#334155')
        .text(`${s.label}: ${s.count} pages (${pct}%)`, legendX + 16, legendY - 1, { width: contentWidth - (legendX - leftX) - 16 });
      legendY += 20;
    }
    doc.y = Math.max(pieCy + pieR + 12, legendY + 8);

    sectionTitle('4. Page Level SEO Analysis');
    const pageRows = pages.map((rep, idx) => {
      const high = rep.issues.filter((i) => i.severity === 'high').length;
      const med = rep.issues.filter((i) => i.severity === 'medium').length;
      const low = rep.issues.filter((i) => i.severity === 'low').length;
      const pageLift = (rep.issues.some((i) => i.type === 'missing_h1') ? 5 : 0)
        + (rep.issues.some((i) => i.type === 'duplicate_title' || i.type === 'missing_title') ? 3 : 0)
        + (rep.issues.some((i) => i.type === 'low_word_count') ? 7 : 0);
      const improvedTitle = rep.improvedContent?.title || rep.suggestedTitle || 'n/a';
      const improvedH1 = rep.improvedContent?.h1 || 'n/a';
      const suggestion = (rep.improvedContent?.bodyCopy || rep.contentImprovements?.[0] || 'Add page-specific content for user intent.').slice(0, 95);
      const keyword = rep.keywordInsights?.targetKeyword || 'n/a';
      const lcp = rep.performanceMetrics?.lcpMs != null ? `${Math.round(rep.performanceMetrics.lcpMs)} ms` : 'n/a';
      const summary = `Focus ${keyword}; H:${high}/M:${med}/L:${low}; improve on-page depth and intent clarity.`;
      return {
        idx: idx + 1,
        url: displayUrl(rep.url),
        score: rep.seoScore,
        keyword,
        rank: `${rep.keywordInsights?.rankingProbability ?? 0}%`,
        lcp,
        high,
        medium: med,
        low,
        title: improvedTitle.slice(0, 54),
        h1: improvedH1.slice(0, 42),
        content: suggestion,
        estimated: clampScore(rep.seoScore + pageLift),
        summary: summary.slice(0, 85),
      };
    });
    drawTable(
      [
        { key: 'idx', title: '#', width: 22, align: 'center' },
        { key: 'url', title: 'Page URL', width: 100 },
        { key: 'score', title: 'SEO Score', width: 42, align: 'center' },
        { key: 'keyword', title: 'Target Keyword', width: 66 },
        { key: 'rank', title: 'Rank %', width: 44, align: 'center' },
        { key: 'lcp', title: 'LCP', width: 44, align: 'center' },
        { key: 'high', title: 'High', width: 28, align: 'center' },
        { key: 'medium', title: 'Med', width: 34, align: 'center' },
        { key: 'low', title: 'Low', width: 26, align: 'center' },
        { key: 'title', title: 'AI Title', width: 74 },
        { key: 'h1', title: 'AI H1', width: 58 },
        { key: 'content', title: 'AI Content', width: 82 },
        { key: 'estimated', title: 'Est', width: 42, align: 'center' },
        { key: 'summary', title: 'Page Summary', width: 88 },
      ],
      pageRows,
      { fontSize: 7, rowPadding: 2 }
    );

    const avgOnPageScore = pages.length
      ? Math.round(pages.reduce((s, p) => s + (p.scoreBreakdown?.onPage ?? p.seoScore), 0) / pages.length)
      : 0;
    const avgTechnicalScore = pages.length
      ? Math.round(pages.reduce((s, p) => s + (p.scoreBreakdown?.technical ?? 0), 0) / pages.length)
      : 0;
    const onPageIssueCount = pages.reduce(
      (n, p) =>
        n +
        p.issues.filter((i) =>
          [
            'missing_title',
            'missing_meta_description',
            'missing_h1',
            'multiple_h1',
            'duplicate_title',
            'low_word_count',
            'images_without_alt',
            'missing_canonical',
          ].includes(i.type)
        ).length,
      0
    );
    const avgOffPageScore = pages.length
      ? Math.round(
          pages.reduce((s, p) => s + (p.backlinkInsights?.backlinkQualityScore ?? p.scoreBreakdown?.backlinks ?? 0), 0) /
            pages.length
        )
      : 0;
    const totalInternalReferrals = pages.reduce((n, p) => n + (p.backlinkInsights?.internalReferringPages ?? 0), 0);
    const totalExternalDomains = pages.reduce((n, p) => n + (p.backlinkInsights?.uniqueExternalDomainsLinked ?? 0), 0);

    sectionTitle('5. On-page SEO Analysis');
    drawTable(
      [
        { key: 'metric', title: 'Metric', width: 260 },
        { key: 'value', title: 'Value', width: 440 },
      ],
      [
        { metric: 'Average On-page Score', value: avgOnPageScore },
        { metric: 'Average Technical Score', value: avgTechnicalScore },
        { metric: 'On-page Issue Count', value: onPageIssueCount },
        {
          metric: 'Priority',
          value: 'Fix title/meta/H1/content depth/canonical/image ALT issues first for faster ranking impact.',
        },
      ],
      { fontSize: 9 }
    );

    sectionTitle('6. Off-page SEO Analysis (Free-mode)');
    drawTable(
      [
        { key: 'metric', title: 'Metric', width: 260 },
        { key: 'value', title: 'Value', width: 440 },
      ],
      [
        { metric: 'Average Off-page Score', value: avgOffPageScore },
        { metric: 'Internal Referring Links', value: totalInternalReferrals },
        { metric: 'Unique External Domains Linked', value: totalExternalDomains },
        {
          metric: 'Note',
          value: 'This is free-mode off-page insight from crawl graph signals; not full web backlink intelligence.',
        },
      ],
      { fontSize: 9 }
    );

    sectionTitle('7. Top Keyword Opportunities (Free Algorithm)');
    const opportunityRows = pages
      .map((rep) => ({
        url: displayUrl(rep.url),
        keyword: rep.keywordInsights?.targetKeyword || 'n/a',
        opportunity: rep.keywordInsights?.opportunityScore ?? 0,
        trendBoost: rep.keywordInsights?.trendBoost ?? 0,
        placement: rep.keywordInsights?.keywordPlacementScore ?? 0,
        rankProb: rep.keywordInsights?.rankingProbability ?? 0,
        action: keywordQuickAction(rep),
      }))
      .sort((a, b) => b.opportunity - a.opportunity)
      .slice(0, 10);
    drawTable(
      [
        { key: 'url', title: 'Page URL', width: 160 },
        { key: 'keyword', title: 'Target Keyword', width: 130 },
        { key: 'opportunity', title: 'Opportunity', width: 80, align: 'center' },
        { key: 'trendBoost', title: 'Trend Boost', width: 80, align: 'center' },
        { key: 'placement', title: 'Placement', width: 80, align: 'center' },
        { key: 'rankProb', title: 'Rank %', width: 65, align: 'center' },
        { key: 'action', title: 'Quick Action', width: 165 },
      ],
      opportunityRows,
      { fontSize: 8, rowPadding: 3 }
    );

    sectionTitle('8. Live Google Rank Positions (SerpAPI)');
    if (serpRows.length === 0) {
      drawTable(
        [
          { key: 'metric', title: 'Metric', width: 260 },
          { key: 'value', title: 'Value', width: 440 },
        ],
        [
          { metric: 'Status', value: 'Live SERP rank data unavailable for this report.' },
          { metric: 'Reason', value: 'SERPAPI_KEY missing, API limit reached, or no keywords were eligible.' },
        ],
        { fontSize: 9 }
      );
    } else {
      drawTable(
        [
          { key: 'page', title: 'Page URL', width: 230 },
          { key: 'keyword', title: 'Keyword', width: 180 },
          { key: 'position', title: 'Google Position', width: 100, align: 'center' },
          { key: 'found', title: 'Found', width: 70, align: 'center' },
          { key: 'location', title: 'Location/Device', width: 120 },
        ],
        serpRows.slice(0, 12).map((r) => ({
          page: displayUrl(r.pageUrl),
          keyword: r.keyword.slice(0, 90),
          position: r.position ?? '>100',
          found: r.found ? 'Yes' : 'No',
          location: `${r.location}/${r.device}`,
        })),
        { fontSize: 8, rowPadding: 3 }
      );
    }

    sectionTitle('9. AI Content Improvements');
    drawTable(
      [
        { key: 'page', title: 'Page', width: 210 },
        { key: 'title', title: 'Improved Title', width: 180 },
        { key: 'meta', title: 'Improved Meta Description', width: 180 },
        { key: 'h1', title: 'Improved H1', width: 120 },
        { key: 'content', title: 'Suggested Content', width: 20 + (contentWidth - 710) },
      ],
      pages.map((rep) => ({
        page: displayUrl(rep.url),
        title: (rep.improvedContent?.title || rep.suggestedTitle || 'n/a').slice(0, 90),
        meta: (rep.improvedContent?.metaDescription || rep.suggestedMetaDescription || 'n/a').slice(0, 120),
        h1: (rep.improvedContent?.h1 || 'n/a').slice(0, 70),
        content: (rep.improvedContent?.bodyCopy || rep.contentImprovements?.[0] || 'n/a').slice(0, 110),
      })),
      { fontSize: 7, rowPadding: 2 }
    );

    sectionTitle('10. Technical SEO Recommendations');
    drawTable(
      [
        { key: 'area', title: 'Area', width: 240 },
        { key: 'rec', title: 'Recommendation', width: 460 },
      ],
      [
        { area: 'Schema markup', rec: 'Add Organization/WebSite/WebPage schema with validation checks.' },
        { area: 'Internal linking', rec: 'Add contextual links between related pages with descriptive anchor text.' },
        { area: 'Image alt attributes', rec: 'Add descriptive ALT text to informative images and key visuals.' },
        { area: 'Core Web Vitals', rec: 'Reduce JS execution, optimize images/fonts, and improve LCP/INP/CLS.' },
        { area: 'Mobile UX', rec: 'Improve tap targets, responsive layout, and readability on mobile devices.' },
      ]
    );

    sectionTitle('11. Priority Action Plan');
    drawTable(
      [
        { key: 'priority', title: 'Priority', width: 120, align: 'center' },
        { key: 'action', title: 'Action', width: 580 },
      ],
      [
        { priority: 1, action: 'Fix missing H1 tags' },
        { priority: 2, action: 'Fix duplicate/missing titles with unique page-specific titles' },
        { priority: 3, action: 'Increase content depth and topical relevance by page intent' },
        { priority: 4, action: 'Improve internal linking map between related pages' },
        { priority: 5, action: 'Add and validate schema markup' },
      ]
    );

    sectionTitle('12. Overall SEO Opportunity Summary');
    const currentContent = pages.length ? Math.round(pages.reduce((s, p) => s + (p.scoreBreakdown?.content ?? 50), 0) / pages.length) : 0;
    const currentTechnical = pages.length ? Math.round(pages.reduce((s, p) => s + (p.scoreBreakdown?.technical ?? 50), 0) / pages.length) : 0;
    const currentRanking = pages.length ? Math.round(pages.reduce((s, p) => s + (p.keywordInsights?.rankingProbability ?? 35), 0) / pages.length) : 0;
    drawTable(
      [
        { key: 'metric', title: 'Metric', width: 220 },
        { key: 'current', title: 'Current', width: 220, align: 'center' },
        { key: 'after', title: 'After Fix', width: 260, align: 'center' },
      ],
      [
        { metric: 'SEO Score', current: roundedAvg, after: estimatedSiteScore },
        { metric: 'Content Quality', current: `${currentContent}/100`, after: `${Math.min(100, currentContent + 20)}/100` },
        { metric: 'Ranking Potential', current: `${currentRanking}%`, after: `${Math.min(95, currentRanking + 22)}%` },
        { metric: 'Technical SEO', current: `${currentTechnical}/100`, after: `${Math.min(100, currentTechnical + 18)}/100` },
      ]
    );

    doc.fontSize(8).fillColor('#94a3b8').text(`Generated ${new Date().toISOString()} — AI SEO Agent`, {
      align: 'center',
    });

    doc.end();
  });
}

/** Legacy PDF when no JSON report file exists. */
export function buildScanReportPdf(meta: ScanPdfMeta, issues: ScanPdfIssueRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `SEO Report — ${meta.domain}` } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    doc.pipe(stream);

    const contentWidth = doc.page.width - 96;

    doc.fontSize(20).fillColor('#0f172a').text('SEO scan report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#334155').text(`Domain: ${meta.domain}`, { align: 'center' });
    doc.moveDown(1.2);

    doc.fontSize(12).fillColor('#0f172a').text('Summary', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#334155');
    doc.text(`Scan ID: ${meta.id}`);
    doc.text(`Started: ${meta.started_at}`);
    if (meta.completed_at) doc.text(`Completed: ${meta.completed_at}`);
    doc.text(`Status: ${meta.status}`);
    doc.text(`Pages crawled: ${meta.pages_count}`);
    doc.text(
      `Average SEO score (AI): ${meta.seo_score_avg != null ? meta.seo_score_avg.toFixed(1) : '—'}`
    );
    doc.text(`GitHub issues created (automation): ${meta.github_issues_created}`);
    doc.text(`Open findings: ${issues.length}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#0f172a').text('Findings & recommended actions', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#64748b').text(
      'Legacy issue list (no per-page JSON file for this scan). Run a new scan for the full audit PDF.',
      { width: contentWidth }
    );
    doc.moveDown(0.8);

    if (issues.length === 0) {
      doc.fontSize(10).fillColor('#334155').text('No rows in the issues table for this scan.', {
        width: contentWidth,
      });
    } else {
      issues.forEach((row, idx) => {
        const solution =
          row.ai_suggestion?.trim() ||
          'No AI recommendation stored. Re-run scan with OPENAI_API_KEY.';

        if (doc.y > doc.page.height - 180) doc.addPage();

        doc.fontSize(11).fillColor('#0f172a').text(`${idx + 1}. ${row.issue_type.replace(/_/g, ' ')}`, {
          width: contentWidth,
        });
        doc.moveDown(0.25);
        doc.fontSize(9).fillColor('#64748b').text(`Page: ${row.page_url}`, { width: contentWidth });
        doc.moveDown(0.35);
        doc.fontSize(10).fillColor('#1e293b').text('Problem:', { continued: false });
        doc.moveDown(0.15);
        doc.fontSize(10).fillColor('#334155').text(row.message, { width: contentWidth });
        doc.moveDown(0.35);
        doc.fontSize(10).fillColor('#0f766e').text('Recommended solution (AI):', { continued: false });
        doc.moveDown(0.15);
        doc.fontSize(10).fillColor('#134e4a').text(solution, { width: contentWidth });
        if (row.github_issue_url) {
          doc.moveDown(0.25);
          doc.fontSize(9).fillColor('#2563eb').text(`GitHub: ${row.github_issue_url}`, { width: contentWidth });
        }
        doc.moveDown(0.15);
        doc.fontSize(8).fillColor('#94a3b8').text(`Status: ${row.status}`);
        doc.moveDown(1);
      });
    }

    doc.moveDown(0.5);
    doc.fontSize(8).fillColor('#94a3b8').text(`Generated ${new Date().toISOString()} — AI SEO Agent`, {
      align: 'center',
    });

    doc.end();
  });
}
