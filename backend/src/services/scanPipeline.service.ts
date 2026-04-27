import { crawlDomain } from './crawler.service';
import { analyzePagesWithAiWithSignals } from './aiAnalyzer.service';
import { createGithubIssue, formatIssueBody } from './github.service';
import { sendReportEmail } from './email.service';
import { getDb, getSetting, logActivity } from './db.service';
import { getEmailConfig } from './secrets.service';
import { saveScanReportFile } from './reportFile.service';
import { fetchPageSpeedForUrls } from './pagespeed.service';
import { buildDiffPreview } from './githubPr.service';
import { logger } from '../utils/logger';
import { SeoPageReport } from '../models/scan.model';

export interface PipelineOptions {
  schedulerRun?: boolean;
  sendEmail?: boolean;
  createGithubIssues?: boolean;
  reportEmailTo?: string;
}

interface PipelineRuntimeOptions {
  scanId?: number;
  abortSignal?: AbortSignal;
}

function normalizeDomain(d: string): string {
  return d.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

function flattenReportsForEmail(reports: Record<string, SeoPageReport>): string[] {
  const lines: string[] = [];
  for (const r of Object.values(reports).slice(0, 8)) {
    const head = `${r.url} — score ${r.seoScore}`;
    const top = r.issues[0];
    const detail = top ? `${top.description} → ${top.fix}` : r.suggestedMetaDescription?.slice(0, 120) || '';
    lines.push(detail ? `${head}: ${detail}` : head);
  }
  return lines.filter(Boolean);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Aborted'));
  throw reason;
}

function buildIssueDiffPreview(issueType: string, snippet: string): string {
  if (!snippet.trim()) return '--- before\n+++ after\n';
  const before =
    issueType === 'missing_meta_description'
      ? '<head>\n  <title>About</title>\n</head>'
      : issueType === 'missing_h1'
        ? '<body>\n  <main>...</main>\n</body>'
        : '';
  const after =
    issueType === 'missing_meta_description'
      ? `<head>\n  <title>About</title>\n  ${snippet.trim()}\n</head>`
      : issueType === 'missing_h1'
        ? `<body>\n  ${snippet.trim()}\n  <main>...</main>\n</body>`
        : snippet.trim();
  return buildDiffPreview(before, after);
}

function formatIssueCodeSnippet(issueType: string, source: string): string {
  const raw = source.trim();
  const type = issueType.trim().toLowerCase();
  if (!raw) return '';
  if (/[<>{}\n]/.test(raw)) return raw;
  if (type === 'missing_meta_description') {
    return `<meta name="description" content="${raw.replace(/"/g, '&quot;')}">`;
  }
  if (type === 'missing_title' || type === 'duplicate_title') {
    return `<title>${raw}</title>`;
  }
  if (type === 'missing_h1' || type === 'multiple_h1') {
    return `<h1>${raw}</h1>`;
  }
  if (type === 'missing_canonical') {
    return `<link rel="canonical" href="${raw}">`;
  }
  if (type === 'low_word_count') {
    return `<p>${raw}</p>`;
  }
  if (type === 'images_without_alt') {
    return `<img src="/path-to-image.jpg" alt="${raw}">`;
  }
  if (type === 'broken_links' || type === 'invalid_or_nonfunctional_link') {
    return `<a href="/valid-destination">Relevant anchor text</a>`;
  }
  if (type === 'slow_page') {
    return `<!-- Performance fix example -->\n<link rel="preload" href="/critical.css" as="style">`;
  }
  return `<!-- SEO fix snippet -->\n${raw}`;
}

export function createScanRecord(domainInput: string, schedulerRun = false): { scanId: number; domain: string } {
  const domain = normalizeDomain(domainInput);
  const db = getDb();

  let domainRow = db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain) as { id: number } | undefined;
  if (!domainRow) {
    const r = db.prepare('INSERT INTO domains (domain) VALUES (?)').run(domain);
    domainRow = { id: Number(r.lastInsertRowid) };
  }
  const domainId = domainRow.id;

  const started = new Date().toISOString();
  const ins = db
    .prepare(
      `INSERT INTO scans (domain_id, started_at, status, scheduler_run) VALUES (?, ?, 'running', ?)`
    )
    .run(domainId, started, schedulerRun ? 1 : 0);
  return { scanId: Number(ins.lastInsertRowid), domain };
}

export async function runScanPipeline(domainInput: string, options?: PipelineOptions): Promise<{
  scanId: number;
  domain: string;
  pages: unknown[];
  pageReports: Record<string, SeoPageReport>;
  seoScoreAvg: number | null;
  emailSent: boolean;
  emailError: string | null;
  githubIssuesCreated: number;
}>;
export async function runScanPipeline(
  domainInput: string,
  options: PipelineOptions,
  runtime: PipelineRuntimeOptions
): Promise<{
  scanId: number;
  domain: string;
  pages: unknown[];
  pageReports: Record<string, SeoPageReport>;
  seoScoreAvg: number | null;
  emailSent: boolean;
  emailError: string | null;
  githubIssuesCreated: number;
}>;
export async function runScanPipeline(
  domainInput: string,
  options: PipelineOptions = {},
  runtime: PipelineRuntimeOptions = {}
): Promise<{
  scanId: number;
  domain: string;
  pages: unknown[];
  pageReports: Record<string, SeoPageReport>;
  seoScoreAvg: number | null;
  emailSent: boolean;
  emailError: string | null;
  githubIssuesCreated: number;
}> {
  let scanId = runtime.scanId;
  let domain = normalizeDomain(domainInput);
  if (!scanId) {
    const created = createScanRecord(domainInput, !!options.schedulerRun);
    scanId = created.scanId;
    domain = created.domain;
  }
  const effectiveScanId = scanId;
  const db = getDb();
  const abortSignal = runtime.abortSignal;

  try {
    throwIfAborted(abortSignal);
    const pages = await crawlDomain(domain, abortSignal);
    throwIfAborted(abortSignal);
    const perfMap = await fetchPageSpeedForUrls(pages.map((p) => p.url));
    const aiMap = await analyzePagesWithAiWithSignals(pages, perfMap);
    throwIfAborted(abortSignal);
    const pageReports: Record<string, SeoPageReport> = {};
    for (const [u, r] of aiMap) pageReports[u] = r;

    const scores = [...aiMap.values()].map((a) => a.seoScore).filter((s) => s > 0);
    const seoScoreAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

    db.prepare(
      `UPDATE scans SET completed_at = datetime('now'), pages_count = ?, seo_score_avg = ?, status = 'completed' WHERE id = ?`
    ).run(pages.length, seoScoreAvg, effectiveScanId);

    saveScanReportFile(effectiveScanId, domain, pageReports, pages);
    db.prepare('DELETE FROM issues WHERE scan_id = ?').run(effectiveScanId);
    const insertIssue = db.prepare(
      `INSERT INTO issues (scan_id, page_url, issue_type, message, ai_suggestion, status, seo_score, code_snippet, code_diff)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`
    );
    for (const rep of Object.values(pageReports)) {
      const byType = new Map<string, string>();
      for (const fix of rep.pasteReadyFixes || []) {
        if (fix.issueType && fix.improvedContent) byType.set(fix.issueType, fix.improvedContent);
      }
      for (const issue of rep.issues) {
        const snippet = formatIssueCodeSnippet(issue.type, byType.get(issue.type) || issue.fix || '');
        insertIssue.run(
          effectiveScanId,
          rep.url,
          issue.type,
          issue.description,
          issue.fix,
          rep.seoScore,
          snippet,
          buildIssueDiffPreview(issue.type, snippet)
        );
      }
    }

    let githubIssuesCreated = 0;
    if (options.createGithubIssues) {
      const flat: { pageUrl: string; title: string; body: string }[] = [];
      for (const [url, rep] of aiMap) {
        for (const iss of rep.issues.slice(0, 3)) {
          flat.push({
            pageUrl: url,
            title: `SEO: ${iss.type} — ${iss.description.slice(0, 60)}`,
            body: formatIssueBody({
              pageUrl: url,
              issue: `${iss.description} (${iss.severity})`,
              aiFix: iss.fix,
            }),
          });
        }
      }
      for (const item of flat.slice(0, 20)) {
        throwIfAborted(abortSignal);
        const gh = await createGithubIssue({ title: item.title.slice(0, 120), body: item.body });
        if (gh.htmlUrl) githubIssuesCreated++;
      }
    }

    db.prepare('UPDATE scans SET github_issues_created = ? WHERE id = ?').run(githubIssuesCreated, effectiveScanId);

    let emailSent = false;
    let emailError: string | null = null;
    const reportTo =
      options.reportEmailTo ||
      process.env.REPORT_EMAIL_TO ||
      getSetting('REPORT_EMAIL_TO') ||
      getEmailConfig().user;

    if (options.sendEmail && reportTo) {
      throwIfAborted(abortSignal);
      const issueCount = Object.values(pageReports).reduce((n, r) => n + r.issues.length, 0);
      const r = await sendReportEmail({
        scanId: effectiveScanId,
        domain,
        pagesCount: pages.length,
        issuesCount: issueCount,
        aiSummaryLines: flattenReportsForEmail(pageReports),
        to: reportTo,
      });
      emailSent = r.ok;
      emailError = r.error ?? null;
      if (r.ok) {
        db.prepare(
          `UPDATE scans SET email_sent = 1, email_sent_at = datetime('now'), email_error = NULL WHERE id = ?`
        ).run(effectiveScanId);
        logActivity('info', 'Email sent successfully', effectiveScanId, { domain });
        logger.info('Email sent successfully', { scanId: effectiveScanId, domain });
      } else {
        db.prepare(`UPDATE scans SET email_error = ? WHERE id = ?`).run(emailError, effectiveScanId);
        logActivity('warn', 'Email send failed', effectiveScanId, { error: emailError });
      }
    }

    logActivity('info', `Scan completed: ${domain}`, effectiveScanId, {
      pages: pages.length,
      githubIssuesCreated,
    });

    return {
      scanId: effectiveScanId,
      domain,
      pages,
      pageReports,
      seoScoreAvg,
      emailSent,
      emailError,
      githubIssuesCreated,
    };
  } catch (e) {
    const isAborted = abortSignal?.aborted || /abort/i.test(String(e));
    const err = isAborted ? 'Stopped by user' : String(e);
    db.prepare(`UPDATE scans SET status = ?, completed_at = datetime('now'), email_error = ? WHERE id = ?`).run(
      isAborted ? 'stopped' : 'failed',
      err,
      effectiveScanId
    );
    logActivity(
      isAborted ? 'warn' : 'error',
      `Scan ${isAborted ? 'stopped' : 'failed'}: ${domain}`,
      effectiveScanId,
      {
      error: err,
      }
    );
    throw e;
  }
}
