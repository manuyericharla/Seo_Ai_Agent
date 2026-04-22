import { Request, Response } from 'express';
import { getDb, getSetting, logActivity, setSetting } from '../services/db.service';
import { createScanRecord, runScanPipeline } from '../services/scanPipeline.service';
import { createGithubIssue, formatIssueBody } from '../services/github.service';
import {
  buildCompositeSeoSnippet,
  createGithubPullRequestForSeoFix,
  normalizeSnippetForIssue,
} from '../services/githubPr.service';
import { sendReportEmail } from '../services/email.service';
import { createClaudePullRequest } from '../services/claudePr.service';
import { logger } from '../utils/logger';
import {
  buildScanReportPdf,
  buildScanReportPdfFromPageReports,
  suggestedFilename,
  ScanPdfIssueRow,
  ScanPdfMeta,
} from '../services/pdfReport.service';
import { loadScanReportFile } from '../services/reportFile.service';
import { registerActiveScan, stopActiveScan, unregisterActiveScan } from '../services/scanTaskRegistry.service';

export async function postScan(req: Request, res: Response): Promise<void> {
  try {
    const { domain, emailTo, createGithubIssues } = req.body as {
      domain?: string;
      emailTo?: string;
      createGithubIssues?: boolean;
    };
    if (!domain || typeof domain !== 'string') {
      res.status(400).json({ error: 'domain is required' });
      return;
    }

    const created = createScanRecord(domain, false);
    const controller = registerActiveScan(created.scanId, created.domain);

    void runScanPipeline(
      created.domain,
      {
        sendEmail: Boolean(emailTo),
        reportEmailTo: emailTo,
        createGithubIssues: Boolean(createGithubIssues),
      },
      { scanId: created.scanId, abortSignal: controller.signal }
    )
      .catch((e) => logger.error('background scan failed', { scanId: created.scanId, error: String(e) }))
      .finally(() => unregisterActiveScan(created.scanId));

    res.status(202).json({
      scanId: created.scanId,
      domain: created.domain,
      status: 'running',
      message: 'Scan started successfully',
    });
  } catch (e) {
    logger.error('postScan', { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
}

export function postStopScan(req: Request, res: Response): void {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const db = getDb();
    const row = db
      .prepare(`SELECT s.id, s.status, d.domain FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ?`)
      .get(scanId) as { id: number; status: string; domain: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }

    const wasActive = stopActiveScan(scanId);
    if (row.status === 'running') {
      db.prepare(`UPDATE scans SET status = 'stopped', completed_at = datetime('now'), email_error = ? WHERE id = ?`).run(
        'Stopped manually by user',
        scanId
      );
      logActivity('warn', `Scan stopped: ${row.domain}`, scanId, { manual: true });
    }
    if (wasActive) unregisterActiveScan(scanId);

    res.json({
      ok: true,
      scanId,
      status: 'stopped',
      message: row.status === 'running' ? 'Scan stopped' : `Scan is already ${row.status}`,
    });
  } catch (e) {
    logger.error('postStopScan', { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
}

export function getPageReportsJson(req: Request, res: Response): void {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const stored = loadScanReportFile(scanId);
    if (!stored) {
      res.status(404).json({ error: 'No page-level report file for this scan (run a new scan).' });
      return;
    }
    res.json(stored);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getKeywordOpportunities(req: Request, res: Response): void {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(50, Math.floor(rawLimit)) : 10;

    const stored = loadScanReportFile(scanId);
    if (!stored) {
      res.status(404).json({ error: 'No page-level report file for this scan (run a new scan).' });
      return;
    }

    const opportunities = Object.values(stored.pageReports)
      .map((rep) => ({
        url: rep.url,
        targetKeyword: rep.keywordInsights?.targetKeyword || '',
        opportunityScore: rep.keywordInsights?.opportunityScore ?? 0,
        trendBoost: rep.keywordInsights?.trendBoost ?? 0,
        keywordPlacementScore: rep.keywordInsights?.keywordPlacementScore ?? 0,
        rankingProbability: rep.keywordInsights?.rankingProbability ?? 0,
        topIssues: rep.issues.slice(0, 3).map((i) => i.type),
      }))
      .sort((a, b) => {
        if (b.opportunityScore !== a.opportunityScore) return b.opportunityScore - a.opportunityScore;
        if (b.trendBoost !== a.trendBoost) return b.trendBoost - a.trendBoost;
        return b.rankingProbability - a.rankingProbability;
      })
      .slice(0, limit);

    res.json({
      scanId,
      domain: stored.domain,
      generatedAt: stored.generatedAt,
      totalPages: Object.keys(stored.pageReports).length,
      items: opportunities,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getLatestKeywordOpportunities(req: Request, res: Response): void {
  try {
    const db = getDb();
    const latest = db
      .prepare(
        `SELECT id
         FROM scans
         WHERE status = 'completed'
         ORDER BY completed_at DESC, id DESC
         LIMIT 1`
      )
      .get() as { id: number } | undefined;

    if (!latest) {
      res.status(404).json({ error: 'No completed scans found yet.' });
      return;
    }

    req.params.scanId = String(latest.id);
    getKeywordOpportunities(req, res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getBacklinkAnalytics(req: Request, res: Response): void {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }

    const stored = loadScanReportFile(scanId);
    if (!stored) {
      res.status(404).json({ error: 'No page-level report file for this scan (run a new scan).' });
      return;
    }

    const pages = Object.values(stored.pageReports).map((rep) => ({
      url: rep.url,
      internalReferringPages: rep.backlinkInsights?.internalReferringPages ?? 0,
      uniqueExternalDomainsLinked: rep.backlinkInsights?.uniqueExternalDomainsLinked ?? 0,
      externalLinksCount: rep.backlinkInsights?.externalLinksCount ?? 0,
      internalAuthorityScore: rep.backlinkInsights?.internalAuthorityScore ?? 0,
      backlinkQualityScore: rep.backlinkInsights?.backlinkQualityScore ?? 0,
    }));

    const totalInternalReferrals = pages.reduce((n, p) => n + p.internalReferringPages, 0);
    const avgBacklinkQualityScore = pages.length
      ? Math.round((pages.reduce((n, p) => n + p.backlinkQualityScore, 0) / pages.length) * 10) / 10
      : 0;

    const topPages = [...pages]
      .sort((a, b) => b.backlinkQualityScore - a.backlinkQualityScore)
      .slice(0, 10);

    res.json({
      scanId,
      domain: stored.domain,
      generatedAt: stored.generatedAt,
      summary: {
        pagesAnalyzed: pages.length,
        totalInternalReferrals,
        avgBacklinkQualityScore,
      },
      topPages,
      items: pages,
      note: 'Free-mode backlink analytics are based on internal link authority and external link diversity signals.',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getLatestBacklinkAnalytics(req: Request, res: Response): void {
  try {
    const db = getDb();
    const latest = db
      .prepare(
        `SELECT id
         FROM scans
         WHERE status = 'completed'
         ORDER BY completed_at DESC, id DESC
         LIMIT 1`
      )
      .get() as { id: number } | undefined;

    if (!latest) {
      res.status(404).json({ error: 'No completed scans found yet.' });
      return;
    }

    req.params.scanId = String(latest.id);
    getBacklinkAnalytics(req, res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getScanReportPdf(req: Request, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const db = getDb();
    const row = db
      .prepare(
        `SELECT s.id, s.started_at, s.completed_at, s.pages_count, s.seo_score_avg, s.status, s.github_issues_created,
                s.claude_pr_url, s.claude_pr_created_at, s.claude_pr_email_sent_at, s.claude_pr_email_error,
                d.domain
         FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ?`
      )
      .get(scanId) as
      | {
          id: number;
          started_at: string;
          completed_at: string | null;
          pages_count: number;
          seo_score_avg: number | null;
          status: string;
          github_issues_created: number;
          claude_pr_url: string | null;
          claude_pr_created_at: string | null;
          claude_pr_email_sent_at: string | null;
          claude_pr_email_error: string | null;
          domain: string;
        }
      | undefined;

    if (!row) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }

    const meta: ScanPdfMeta = {
      id: row.id,
      domain: row.domain,
      started_at: row.started_at,
      completed_at: row.completed_at,
      pages_count: row.pages_count,
      seo_score_avg: row.seo_score_avg,
      status: row.status,
      github_issues_created: row.github_issues_created,
    };

    const stored = loadScanReportFile(scanId);
    let pdf: Buffer;
    if (stored?.pageReports && Object.keys(stored.pageReports).length > 0) {
      pdf = await buildScanReportPdfFromPageReports(meta, stored.pageReports);
    } else {
      const issues = db
        .prepare(
          `SELECT page_url, issue_type, message, ai_suggestion, status, github_issue_url
         FROM issues WHERE scan_id = ? ORDER BY page_url, id`
        )
        .all(scanId) as ScanPdfIssueRow[];
      pdf = await buildScanReportPdf(meta, issues);
    }
    const fname = suggestedFilename(row.domain, scanId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(pdf);
  } catch (e) {
    logger.error('getScanReportPdf', { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
}

export function getReports(_req: Request, res: Response): void {
  try {
    const db = getDb();
    const scans = db
      .prepare(
        `SELECT s.id, s.domain_id, d.domain, s.started_at, s.completed_at, s.pages_count, s.seo_score_avg,
                s.status, s.email_sent, s.email_sent_at, s.email_error, s.github_issues_created, s.scheduler_run,
                s.claude_pr_url, s.claude_pr_created_at, s.claude_pr_email_sent_at, s.claude_pr_email_error
         FROM scans s JOIN domains d ON d.id = s.domain_id
         ORDER BY s.started_at DESC LIMIT 100`
      )
      .all();

    const issues = db
      .prepare(
        `SELECT i.id, i.scan_id, i.page_url, i.issue_type, i.message, i.ai_suggestion, i.status, i.github_issue_url,
                i.seo_score, i.code_snippet, i.code_diff, i.github_pr_url, i.github_pr_branch
         FROM issues i ORDER BY i.id DESC LIMIT 500`
      )
      .all();

    res.json({ scans, issues });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postSendReport(req: Request, res: Response): Promise<void> {
  try {
    const { scanId, emailTo } = req.body as { scanId?: number; emailTo?: string };
    if (!scanId || !emailTo) {
      res.status(400).json({ error: 'scanId and emailTo are required' });
      return;
    }

    const db = getDb();
    const scan = db
      .prepare(
        `SELECT s.id, s.pages_count, d.domain FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ?`
      )
      .get(scanId) as { id: number; pages_count: number; domain: string } | undefined;

    if (!scan) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }

    const stored = loadScanReportFile(scanId);
    let issuesCount: number;
    let aiSummaryLines: string[];
    if (stored?.pageReports) {
      const reps = Object.values(stored.pageReports);
      issuesCount = reps.reduce((n, r) => n + r.issues.length, 0);
      aiSummaryLines = reps.slice(0, 12).map((r) => {
        const top = r.issues[0];
        return top
          ? `${r.url} (${r.seoScore}): ${top.description}`
          : `${r.url} — ${(r.suggestedMetaDescription || r.suggestedTitle || 'audit').slice(0, 100)}`;
      });
    } else {
      const issueRows = db
        .prepare(`SELECT message, ai_suggestion FROM issues WHERE scan_id = ? LIMIT 20`)
        .all(scanId) as { message: string; ai_suggestion: string | null }[];
      issuesCount = issueRows.length;
      aiSummaryLines = issueRows.map((i) => i.ai_suggestion || i.message);
    }

    const r = await sendReportEmail({
      scanId,
      domain: scan.domain,
      pagesCount: scan.pages_count,
      issuesCount,
      aiSummaryLines,
      to: emailTo,
    });

    if (r.ok) {
      db.prepare(
        `UPDATE scans SET email_sent = 1, email_sent_at = datetime('now'), email_error = NULL WHERE id = ?`
      ).run(scanId);
      logActivity('info', 'Manual email report sent', scanId, { to: emailTo });
      res.json({ ok: true, message: 'Email sent successfully' });
    } else {
      db.prepare(`UPDATE scans SET email_error = ? WHERE id = ?`).run(r.error, scanId);
      logActivity('warn', 'Manual email report failed', scanId, { error: r.error });
      res.status(502).json({ ok: false, error: r.error });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getDomains(_req: Request, res: Response): void {
  const rows = getDb().prepare('SELECT id, domain, created_at FROM domains ORDER BY id DESC').all();
  res.json(rows);
}

export function postDomain(req: Request, res: Response): void {
  const { domain } = req.body as { domain?: string };
  if (!domain) {
    res.status(400).json({ error: 'domain required' });
    return;
  }
  const d = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  try {
    getDb().prepare('INSERT OR IGNORE INTO domains (domain) VALUES (?)').run(d);
    const row = getDb().prepare('SELECT id, domain, created_at FROM domains WHERE domain = ?').get(d);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getDashboardStats(_req: Request, res: Response): void {
  const db = getDb();
  const domains = (db.prepare('SELECT COUNT(*) as c FROM domains').get() as { c: number }).c;
  const pages = (db.prepare('SELECT COALESCE(SUM(pages_count),0) as c FROM scans WHERE status = ?').get('completed') as {
    c: number;
  }).c;
  const issues = (db.prepare('SELECT COUNT(*) as c FROM issues').get() as { c: number }).c;
  const avg = db.prepare('SELECT AVG(seo_score_avg) as a FROM scans WHERE seo_score_avg IS NOT NULL').get() as {
    a: number | null;
  };
  res.json({
    totalDomains: domains,
    pagesScanned: pages,
    issuesDetected: issues,
    seoScoreAvg: avg.a != null ? Math.round(avg.a * 10) / 10 : null,
  });
}

export function getActivity(_req: Request, res: Response): void {
  const rows = getDb()
    .prepare('SELECT id, created_at, scan_id, level, message, meta FROM activity_log ORDER BY id DESC LIMIT 100')
    .all();
  res.json(rows);
}

export function getSettings(_req: Request, res: Response): void {
  const keys = [
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_REPO',
    'GITHUB_REPO_OWNER',
    'GITHUB_REPO_NAME',
    'GITHUB_DEFAULT_BRANCH',
    'GITHUB_CONTENT_ROOT_FOLDER',
    'GITHUB_FILE_EXTENSION',
    'CLAUDE_INSTANCE_ID',
    'CLAUDE_PR_ENDPOINT',
    'CLAUDE_API_TOKEN',
    'EMAIL_HOST',
    'EMAIL_PORT',
    'EMAIL_USER',
    'EMAIL_PASS',
    'EMAIL_FROM',
    'REPORT_EMAIL_TO',
    'scheduler.enabled',
    'scheduler.frequency',
    'scheduler.domain',
    'scheduler.email',
    'scheduler.rules',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = getSetting(k) || process.env[k] || '';
    if (!v) {
      out[k] = '';
      continue;
    }
    if (k.includes('PASS') || k.includes('TOKEN') || k.includes('KEY')) {
      out[k] = v.length > 4 ? `****${v.slice(-4)}` : '****';
    } else {
      out[k] = v;
    }
  }
  res.json(out);
}

export function putSettings(req: Request, res: Response): void {
  const body = req.body as Record<string, string>;
  const allowed = new Set([
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_REPO',
    'GITHUB_REPO_OWNER',
    'GITHUB_REPO_NAME',
    'GITHUB_DEFAULT_BRANCH',
    'GITHUB_CONTENT_ROOT_FOLDER',
    'GITHUB_FILE_EXTENSION',
    'CLAUDE_INSTANCE_ID',
    'CLAUDE_PR_ENDPOINT',
    'CLAUDE_API_TOKEN',
    'EMAIL_HOST',
    'EMAIL_PORT',
    'EMAIL_USER',
    'EMAIL_PASS',
    'EMAIL_FROM',
    'REPORT_EMAIL_TO',
    'scheduler.enabled',
    'scheduler.frequency',
    'scheduler.domain',
    'scheduler.email',
    'scheduler.rules',
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    if (v.startsWith('****')) continue;
    setSetting(k, v);
  }
  res.json({ ok: true });
}

export async function postIssuePullRequest(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare(
      `SELECT i.id, i.scan_id, i.page_url, i.issue_type, i.message, i.code_snippet, i.github_pr_url
       FROM issues i WHERE i.id = ?`
    )
    .get(id) as
    | {
        id: number;
        scan_id: number;
        page_url: string;
        issue_type: string;
        message: string;
        code_snippet: string | null;
        github_pr_url: string | null;
      }
    | undefined;

  if (!row) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  if (row.github_pr_url) {
    res.json({ ok: true, url: row.github_pr_url, message: 'Pull request already exists' });
    return;
  }
  const report = loadScanReportFile(row.scan_id);
  const pageReport = report?.pageReports?.[row.page_url];
  const compositeSnippet = buildCompositeSeoSnippet({
    title: pageReport?.improvedContent?.title || pageReport?.suggestedTitle,
    metaDescription: pageReport?.improvedContent?.metaDescription || pageReport?.suggestedMetaDescription,
    h1: pageReport?.improvedContent?.h1,
    bodyCopy: pageReport?.improvedContent?.bodyCopy,
  });
  const finalSnippet =
    compositeSnippet || normalizeSnippetForIssue(row.issue_type || row.message, row.code_snippet || '');

  const pr = await createGithubPullRequestForSeoFix({
    pageUrl: row.page_url,
    issue: 'page_seo_content_update',
    codeSnippet: finalSnippet,
  });
  if (!pr.ok || !pr.pullRequestUrl) {
    res.status(502).json({ ok: false, error: pr.error || 'Unable to create pull request' });
    return;
  }
  getDb()
    .prepare('UPDATE issues SET github_pr_url = ?, github_pr_branch = ?, status = ? WHERE id = ?')
    .run(pr.pullRequestUrl, pr.branch || null, 'pr_created', id);
  logActivity('info', 'GitHub pull request created', undefined, {
    issueId: id,
    page: row.page_url,
    branch: pr.branch,
    prUrl: pr.pullRequestUrl,
  });
  res.json({
    ok: true,
    url: pr.pullRequestUrl,
    branch: pr.branch,
    filePath: pr.filePath,
  });
}

export async function postIssueGithub(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare('SELECT i.id, i.page_url, i.message, i.ai_suggestion, i.github_issue_url FROM issues i WHERE i.id = ?')
    .get(id) as
    | { id: number; page_url: string; message: string; ai_suggestion: string | null; github_issue_url: string | null }
    | undefined;

  if (!row) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  if (row.github_issue_url) {
    res.json({ ok: true, url: row.github_issue_url, message: 'Issue already linked' });
    return;
  }

  const title = `SEO Issue: ${row.message.replace(/\s+/g, ' ').slice(0, 80)}`;
  const body = formatIssueBody({
    pageUrl: row.page_url,
    issue: row.message,
    aiFix: row.ai_suggestion || 'N/A',
  });
  const gh = await createGithubIssue({ title, body });
  if (gh.htmlUrl) {
    getDb().prepare('UPDATE issues SET github_issue_url = ? WHERE id = ?').run(gh.htmlUrl, id);
    logActivity('info', 'GitHub issue created', undefined, { issueId: id, url: gh.htmlUrl });
    res.json({ ok: true, url: gh.htmlUrl, number: gh.number });
  } else {
    res.status(502).json({ ok: false, error: gh.error });
  }
}

export function getSeoTrend(_req: Request, res: Response): void {
  const rows = getDb()
    .prepare(
      `SELECT s.id, d.domain, s.started_at, s.seo_score_avg FROM scans s
       JOIN domains d ON d.id = s.domain_id
       WHERE s.status = 'completed' AND s.seo_score_avg IS NOT NULL
       ORDER BY s.started_at ASC LIMIT 200`
    )
    .all();
  res.json(rows);
}

export async function postScanClaudePr(req: Request, res: Response): Promise<void> {
  const scanId = Number(req.params.scanId);
  if (!Number.isFinite(scanId) || scanId < 1) {
    res.status(400).json({ error: 'Invalid scan id' });
    return;
  }
  const row = getDb()
    .prepare(
      `SELECT s.id, d.domain, s.claude_pr_url
       FROM scans s JOIN domains d ON d.id = s.domain_id
       WHERE s.id = ?`
    )
    .get(scanId) as { id: number; domain: string; claude_pr_url: string | null } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Scan not found' });
    return;
  }
  if (row.claude_pr_url) {
    res.json({ ok: true, prUrl: row.claude_pr_url, message: 'PR already generated for this scan' });
    return;
  }
  const result = await createClaudePullRequest({ scanId, domain: row.domain });
  if (!result.ok || !result.prUrl) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  getDb()
    .prepare(`UPDATE scans SET claude_pr_url = ?, claude_pr_created_at = datetime('now') WHERE id = ?`)
    .run(result.prUrl, scanId);
  logActivity('info', 'Claude PR created', scanId, { prUrl: result.prUrl });
  res.json({ ok: true, prUrl: result.prUrl });
}

export async function postScanClaudePrEmail(req: Request, res: Response): Promise<void> {
  const scanId = Number(req.params.scanId);
  const { emailTo } = req.body as { emailTo?: string };
  if (!Number.isFinite(scanId) || scanId < 1) {
    res.status(400).json({ error: 'Invalid scan id' });
    return;
  }
  if (!emailTo || typeof emailTo !== 'string') {
    res.status(400).json({ error: 'emailTo is required' });
    return;
  }
  const row = getDb()
    .prepare(
      `SELECT s.id, d.domain, s.claude_pr_url
       FROM scans s JOIN domains d ON d.id = s.domain_id
       WHERE s.id = ?`
    )
    .get(scanId) as { id: number; domain: string; claude_pr_url: string | null } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Scan not found' });
    return;
  }
  if (!row.claude_pr_url) {
    res.status(400).json({ error: 'No Claude PR link exists for this scan yet.' });
    return;
  }
  const emailResult = await sendReportEmail({
    scanId,
    domain: row.domain,
    pagesCount: 0,
    issuesCount: 0,
    aiSummaryLines: [`Claude PR link: ${row.claude_pr_url}`],
    to: emailTo,
  });
  if (!emailResult.ok) {
    getDb().prepare(`UPDATE scans SET claude_pr_email_error = ? WHERE id = ?`).run(emailResult.error || 'Email failed', scanId);
    res.status(502).json({ ok: false, error: emailResult.error || 'Email failed' });
    return;
  }
  getDb()
    .prepare(`UPDATE scans SET claude_pr_email_sent_at = datetime('now'), claude_pr_email_error = NULL WHERE id = ?`)
    .run(scanId);
  logActivity('info', 'Claude PR link emailed', scanId, { to: emailTo });
  res.json({ ok: true, message: 'Claude PR link sent by email' });
}
