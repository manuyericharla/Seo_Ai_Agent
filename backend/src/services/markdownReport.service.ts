import type { IntelligenceReport } from './intelligenceReport.service';
import type { SerpRankRow, ScanPdfIssueRow, ScanPdfMeta } from './pdfReport.service';

function safeFilenamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'report';
}

export function suggestedJsonFilename(domain: string, scanId: number): string {
  return `seo-report-${safeFilenamePart(domain)}-${scanId}.json`;
}

export function suggestedMdFilename(domain: string, scanId: number): string {
  return `seo-report-${safeFilenamePart(domain)}-${scanId}.md`;
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function mdSection(title: string, body: string): string {
  return `## ${title}\n\n${body}\n\n`;
}

export function renderMarkdownReport(
  report: IntelligenceReport,
  meta: { domain: string; scanId: number; generatedAt?: string },
  serpRows: SerpRankRow[] = []
): string {
  const lines: string[] = [];
  const s = report.summary;

  lines.push(`# SEO audit report — ${meta.domain}`);
  lines.push('');
  lines.push(`- **Scan ID:** ${meta.scanId}`);
  if (meta.generatedAt) lines.push(`- **Generated:** ${meta.generatedAt}`);
  lines.push(`- **Pages analyzed:** ${s.pagesAnalyzed}`);
  lines.push(`- **Total issues:** ${s.totalIssues}`);
  lines.push(
    `- **SEO score:** ${s.currentScore} (estimated after fixes: ${s.estimatedScore}, +${s.improvement})`
  );
  lines.push(`- **Confidence:** ${s.confidenceScore}%`);
  lines.push('');

  lines.push(
    mdSection(
      'Score breakdown',
      [
        `| Area | Score |`,
        `| --- | ---: |`,
        `| Technical | ${s.breakdown.technicalScore} |`,
        `| Content | ${s.breakdown.contentScore} |`,
        `| Keywords | ${s.breakdown.keywordScore} |`,
        `| Links | ${s.breakdown.linkScore} |`,
      ].join('\n')
    )
  );

  if (report.quickWins.length) {
    const qw = report.quickWins
      .slice(0, 15)
      .map(
        (q, i) =>
          `${i + 1}. **${q.impact}** — ${q.page}\n   - Action: ${q.action}\n   - Change: ${q.exactChange}\n   - ${q.reason}`
      )
      .join('\n\n');
    lines.push(mdSection('Quick wins', qw));
  }

  if (report.topOpportunities.length) {
    const opp = report.topOpportunities
      .slice(0, 15)
      .map(
        (o, i) =>
          `${i + 1}. **${o.keyword}** → ${o.targetPage} (opportunity ${o.opportunityScore}, priority ${o.priorityScore})\n   - ${o.reason}`
      )
      .join('\n\n');
    lines.push(mdSection('Top keyword opportunities', opp));
  }

  const primaryKw = report.keywordStrategy.primaryKeywords.slice(0, 20);
  if (primaryKw.length) {
    const table = [
      '| Keyword | Intent | Target page | Priority | Opportunity |',
      '| --- | --- | --- | ---: | ---: |',
      ...primaryKw.map(
        (k) =>
          `| ${mdEscape(k.keyword)} | ${mdEscape(k.intent)} | ${mdEscape(k.targetPage)} | ${k.priorityScore} | ${k.opportunityScore} |`
      ),
    ].join('\n');
    lines.push(mdSection('Primary keywords', table));
  }

  if (serpRows.length) {
    const serp = [
      '| Page | Keyword | Position | Found | Matched URL |',
      '| --- | --- | ---: | --- | --- |',
      ...serpRows.map(
        (r) =>
          `| ${mdEscape(r.pageUrl)} | ${mdEscape(r.keyword)} | ${r.position ?? '—'} | ${r.found ? 'yes' : 'no'} | ${mdEscape(r.matchedUrl || '—')} |`
      ),
    ].join('\n');
    lines.push(mdSection('Live Google rank (SerpAPI)', serp));
  }

  if (report.technicalIssues.length) {
    const tech = report.technicalIssues
      .slice(0, 25)
      .map(
        (t, i) =>
          `${i + 1}. **${t.severity}** \`${t.type}\` — ${t.page}\n   - Impact: ${t.impact}\n   - Fix: ${t.fixSuggestion}`
      )
      .join('\n\n');
    lines.push(mdSection('Technical issues', tech));
  }

  const pages = report.pages.slice(0, 50);
  if (pages.length) {
    const pageBlocks = pages
      .map((p, i) => {
        const issueLines =
          p.issues.length > 0
            ? p.issues
                .slice(0, 8)
                .map((iss) => `  - **${iss.severity}** ${iss.type}: ${iss.description} → ${iss.fix}`)
                .join('\n')
            : '  - No issues flagged.';
        const heading = p.headingAnalysis.currentH1
          ? `H1: "${p.headingAnalysis.currentH1}"${p.headingAnalysis.isOptimized ? ' (OK)' : ` → suggested: "${p.headingAnalysis.suggestedH1}"`}`
          : 'H1: missing';
        return `### ${i + 1}. ${p.pageUrl}

- **SEO score:** ${p.seoScore}
- **Primary keyword:** ${p.primaryKeyword} (${p.searchIntent})
- **Opportunity / priority:** ${p.opportunityScore} / ${p.priorityScore}
- **Word count:** ${p.contentAnalysis.wordCount} (recommended ${p.contentAnalysis.recommendedWordCount})
- ${heading}
${p.topicReviewerWarning ? `- ⚠️ ${p.topicReviewerWarning}` : ''}

**Issues:**
${issueLines}`;
      })
      .join('\n\n');
    lines.push(mdSection('Per-page analysis', pageBlocks));
  }

  if (report.decisions.length) {
    const decisions = report.decisions
      .slice(0, 20)
      .map(
        (d, i) =>
          `${i + 1}. **${d.priority}** ${d.actionType} — ${d.page} (keyword: ${d.primaryKeyword})\n   - ${d.reason}\n   - Expected: ${d.expectedImpact}`
      )
      .join('\n\n');
    lines.push(mdSection('Recommended decisions', decisions));
  }

  lines.push('---');
  lines.push(`*Generated ${new Date().toISOString()} — AI SEO Agent*`);

  return lines.join('\n');
}

export function buildLegacyScanReportMarkdown(meta: ScanPdfMeta, issues: ScanPdfIssueRow[]): string {
  const lines: string[] = [];
  lines.push(`# SEO scan report — ${meta.domain}`);
  lines.push('');
  lines.push(`- **Scan ID:** ${meta.id}`);
  lines.push(`- **Started:** ${meta.started_at}`);
  if (meta.completed_at) lines.push(`- **Completed:** ${meta.completed_at}`);
  lines.push(`- **Status:** ${meta.status}`);
  lines.push(`- **Pages crawled:** ${meta.pages_count}`);
  lines.push(
    `- **Average SEO score:** ${meta.seo_score_avg != null ? meta.seo_score_avg.toFixed(1) : '—'}`
  );
  lines.push(`- **GitHub issues created:** ${meta.github_issues_created}`);
  lines.push('');
  lines.push(
    '> Legacy issue list (no per-page JSON file for this scan). Run a new scan for the full audit report.'
  );
  lines.push('');
  lines.push('## Findings & recommended actions');
  lines.push('');

  if (issues.length === 0) {
    lines.push('No rows in the issues table for this scan.');
  } else {
    issues.forEach((row, idx) => {
      const solution =
        row.ai_suggestion?.trim() ||
        'No AI recommendation stored. Set OpenAI credentials and re-run scan.';
      lines.push(`### ${idx + 1}. ${row.issue_type.replace(/_/g, ' ')}`);
      lines.push('');
      lines.push(`- **Page:** ${row.page_url}`);
      lines.push(`- **Status:** ${row.status}`);
      lines.push('');
      lines.push(`**Problem:** ${row.message}`);
      lines.push('');
      lines.push(`**Recommended solution:** ${solution}`);
      if (row.github_issue_url) lines.push('');
      if (row.github_issue_url) lines.push(`**GitHub:** ${row.github_issue_url}`);
      lines.push('');
    });
  }

  lines.push('---');
  lines.push(`*Generated ${new Date().toISOString()} — AI SEO Agent*`);
  return lines.join('\n');
}
