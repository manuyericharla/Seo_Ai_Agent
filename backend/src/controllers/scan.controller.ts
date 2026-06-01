import { Response } from 'express';
import type { AuthRequest } from '../context/company.context';
import { getRequestCompanyId, runWithCompanyContextAsync } from '../context/company.context';
import {
  dbAll,
  dbExecute,
  dbGet,
  deleteScanById,
  getDriver,
  isMultiTenantEnabled,
  logActivityAsync,
  recoverStaleRunningScans,
} from '../services/db.service';
import {
  getAppSettingsForApi,
  getCompanyConfig,
  getCompanySettingsForApi,
  mergeCompanySettings,
  SETTINGS_KEYS,
} from '../services/companyConfig.service';
import { getActiveSetting } from '../services/companyConfig.service';
import { createScanRecord, runScanPipeline } from '../services/scanPipeline.service';
import { deleteScanReportFile } from '../services/reportFile.service';
import { sqlNow } from '../helpers/companyScope';
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
  renderPdf,
  suggestedFilename,
  ScanPdfIssueRow,
  ScanPdfMeta,
  SerpRankRow,
} from '../services/pdfReport.service';
import { loadScanReportFile } from '../services/reportFile.service';
import { buildEnrichedAuditPayload } from '../services/auditReportPayload.service';
import { buildIntelligenceReport } from '../services/intelligenceReport.service';
import {
  buildLegacyScanReportMarkdown,
  renderMarkdownReport,
  suggestedJsonFilename,
  suggestedMdFilename,
} from '../services/markdownReport.service';
import { config } from '../config/config';
import {
  findActiveScanIdForDomain,
  listActiveScanIds,
  registerActiveScan,
  stopActiveScan,
  unregisterActiveScan,
  withDomainScanStartLock,
} from '../services/scanTaskRegistry.service';
import { fetchPageSpeedMetrics } from '../services/pagespeed.service';
import { fetchSerpLiveRank, testSerpApiConnection } from '../services/serpapi.service';

function companyIdFrom(req: AuthRequest): number | undefined {
  return getRequestCompanyId(req);
}

function normalizeScanDomain(domain: string): string {
  return domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

async function findRunningScanIdInDb(domain: string, companyId: number | undefined): Promise<number | null> {
  const dc = domainCompanyFilter(companyId);
  const row = await dbGet<{ id: number }>(
    `SELECT s.id FROM scans s JOIN domains d ON d.id = s.domain_id
     WHERE s.status = 'running' AND d.domain = ? AND ${dc.clause}
     ORDER BY s.id DESC LIMIT 1`,
    [domain, ...dc.params]
  );
  return row?.id ?? null;
}

function domainCompanyFilter(companyId: number | undefined): { clause: string; params: unknown[] } {
  if (companyId != null) return { clause: 'd.company_id = ?', params: [companyId] };
  return { clause: 'd.company_id IS NULL', params: [] };
}

export async function postScan(req: AuthRequest, res: Response): Promise<void> {
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

    const companyId = companyIdFrom(req);
    const normalizedDomain = normalizeScanDomain(domain);

    const startResult = await withDomainScanStartLock(companyId ?? null, normalizedDomain, async () => {
      const inMemoryRunning = findActiveScanIdForDomain(companyId ?? null, normalizedDomain);
      const dbRunning = await findRunningScanIdInDb(normalizedDomain, companyId);
      const existingScanId = inMemoryRunning ?? dbRunning;
      if (existingScanId != null) {
        return { kind: 'existing' as const, scanId: existingScanId };
      }
      const created = await createScanRecord(normalizedDomain, companyId, false);
      const controller = registerActiveScan(created.scanId, created.domain, companyId ?? null);
      return { kind: 'created' as const, created, controller };
    });

    if (startResult.kind === 'existing') {
      res.status(200).json({
        scanId: startResult.scanId,
        domain: normalizedDomain,
        status: 'running',
        message: 'A scan is already running for this domain.',
        alreadyRunning: true,
      });
      return;
    }

    const { created, controller } = startResult;

    const authStore = req.auth
      ? {
          ...req.auth,
          settings: companyId != null ? await getCompanyConfig(companyId) : req.auth.settings,
        }
      : undefined;

    const pipelineMs = config.scanPipelineMaxMs;
    const runJob = () => {
      logger.info('Scan pipeline started', { scanId: created.scanId, domain: created.domain });
      const pipeline = runScanPipeline(
        created.domain,
        {
          sendEmail: Boolean(emailTo),
          reportEmailTo: emailTo,
          createGithubIssues: Boolean(createGithubIssues),
        },
        { scanId: created.scanId, abortSignal: controller.signal }
      );
      const timed = Promise.race([
        pipeline,
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `Scan timed out after ${Math.round(pipelineMs / 60000)} minutes. Try again or increase SCAN_PIPELINE_MAX_MS.`
                )
              ),
            pipelineMs
          );
        }),
      ]);
      return timed
        .then((result) => {
          logger.info('Scan pipeline completed', {
            scanId: created.scanId,
            domain: created.domain,
            pages: result.pages.length,
          });
          return result;
        })
        .catch(async (e) => {
          logger.error('background scan failed', { scanId: created.scanId, error: String(e) });
          const err = String(e);
          await dbExecute(
            `UPDATE scans SET status = 'failed', completed_at = ${sqlNow()}, email_error = ? WHERE id = ? AND status = 'running'`,
            [err, created.scanId]
          );
        })
        .finally(() => unregisterActiveScan(created.scanId));
    };

    if (authStore) {
      void runWithCompanyContextAsync(authStore, runJob);
    } else {
      void runJob();
    }

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

export async function deleteScan(req: AuthRequest, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const companyId = companyIdFrom(req);
    if (isMultiTenantEnabled() && companyId == null) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (companyId != null) {
      const ok = await deleteScanById(scanId, companyId);
      if (!ok) {
        res.status(404).json({ error: 'Scan not found' });
        return;
      }
    } else {
      const row = await dbGet<{ id: number }>(
        `SELECT s.id FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ? AND d.company_id IS NULL`,
        [scanId]
      );
      if (!row) {
        res.status(404).json({ error: 'Scan not found' });
        return;
      }
      await dbExecute('DELETE FROM issues WHERE scan_id = ?', [scanId]);
      await dbExecute('DELETE FROM activity_log WHERE scan_id = ?', [scanId]);
      await dbExecute('DELETE FROM scans WHERE id = ?', [scanId]);
    }
    deleteScanReportFile(scanId);
    await logActivityAsync('info', `Scan deleted: #${scanId}`, undefined, { scanId }, companyId);
    res.json({ ok: true, message: 'Scan deleted' });
  } catch (e) {
    logger.error('deleteScan', { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
}

export async function postStopScan(req: AuthRequest, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const companyId = companyIdFrom(req);
    const dc = domainCompanyFilter(companyId);
    const row = await dbGet<{ id: number; status: string; domain: string }>(
      `SELECT s.id, s.status, d.domain FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ? AND ${dc.clause}`,
      [scanId, ...dc.params]
    );
    if (!row) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }

    const wasActive = stopActiveScan(scanId);
    if (row.status === 'running') {
      await dbExecute(`UPDATE scans SET status = 'stopped', completed_at = ${sqlNow()}, email_error = ? WHERE id = ?`, [
        'Stopped manually by user',
        scanId,
      ]);
      await logActivityAsync('warn', `Scan stopped: ${row.domain}`, scanId, { manual: true }, companyId);
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

type ScanReportRow = {
  id: number;
  started_at: string;
  completed_at: string | null;
  pages_count: number;
  seo_score_avg: number | null;
  status: string;
  github_issues_created: number;
  domain: string;
};

async function loadScanReportRow(
  req: AuthRequest,
  scanId: number
): Promise<ScanReportRow | undefined> {
  const dc = domainCompanyFilter(companyIdFrom(req));
  return (await dbGet(
    `SELECT s.id, s.started_at, s.completed_at, s.pages_count, s.seo_score_avg, s.status, s.github_issues_created,
            d.domain
     FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ? AND ${dc.clause}`,
    [scanId, ...dc.params]
  )) as ScanReportRow | undefined;
}

function setDownloadHeaders(res: Response, contentType: string, filename: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

export async function getPageReportsJson(req: AuthRequest, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const row = await loadScanReportRow(req, scanId);
    if (!row) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    const stored = loadScanReportFile(scanId);
    if (!stored) {
      res.status(404).json({ error: 'No page-level report file for this scan (run a new scan).' });
      return;
    }
    const payload = await buildEnrichedAuditPayload(stored);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getScanReportJsonDownload(req: AuthRequest, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const row = await loadScanReportRow(req, scanId);
    if (!row) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    const stored = loadScanReportFile(scanId);
    if (!stored) {
      res.status(404).json({ error: 'No page-level report file for this scan (run a new scan).' });
      return;
    }
    const payload = await buildEnrichedAuditPayload(stored);
    const body = JSON.stringify(payload, null, 2);
    setDownloadHeaders(res, 'application/json; charset=utf-8', suggestedJsonFilename(row.domain, scanId));
    res.send(body);
  } catch (e) {
    logger.error('getScanReportJsonDownload', { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
}

export async function getScanReportMarkdown(req: AuthRequest, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const row = await loadScanReportRow(req, scanId);
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
    let markdown: string;
    if (stored?.pageReports && Object.keys(stored.pageReports).length > 0) {
      const payload = await buildEnrichedAuditPayload(stored);
      const intelligenceReport = buildIntelligenceReport(stored);
      const serpRows = (payload.liveRankAnalysis as { rows?: SerpRankRow[] } | undefined)?.rows ?? [];
      markdown = renderMarkdownReport(intelligenceReport, {
        domain: row.domain,
        scanId,
        generatedAt: stored.generatedAt,
      }, serpRows);
    } else {
      const issues = (await dbAll(
        `SELECT page_url, issue_type, message, ai_suggestion, status, github_issue_url
         FROM issues WHERE scan_id = ? ORDER BY page_url, id`,
        [scanId]
      )) as ScanPdfIssueRow[];
      markdown = buildLegacyScanReportMarkdown(meta, issues);
    }

    setDownloadHeaders(res, 'text/markdown; charset=utf-8', suggestedMdFilename(row.domain, scanId));
    res.send(markdown);
  } catch (e) {
    logger.error('getScanReportMarkdown', { error: String(e) });
    res.status(500).json({ error: String(e) });
  }
}

export function getKeywordOpportunities(req: AuthRequest, res: Response): void {
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
    const intelligenceReport = buildIntelligenceReport(stored);
    const opportunities = intelligenceReport.keywordStrategy.primaryKeywords
      .map((k: any) => ({
        keyword: k.keyword,
        category: 'domain_trend',
        searchIntent: k.intent,
        priorityScore: k.priorityScore,
        opportunityScore: k.opportunityScore,
        suggestedPageUrl: k.targetPage || '',
      }))
      .sort((a, b) => (b.opportunityScore - a.opportunityScore) || (b.priorityScore - a.priorityScore))
      .slice(0, limit);

    res.json({
      scanId,
      domain: stored.domain,
      generatedAt: stored.generatedAt,
      totalPages: intelligenceReport.summary.pagesAnalyzed,
      totalTrendKeywords: intelligenceReport.dataQualityCheck.uniqueKeywords,
      items: opportunities,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

async function latestCompletedScanId(req: AuthRequest): Promise<number | undefined> {
  const dc = domainCompanyFilter(companyIdFrom(req));
  const latest = await dbGet<{ id: number }>(
    `SELECT s.id FROM scans s JOIN domains d ON d.id = s.domain_id
     WHERE s.status = 'completed' AND ${dc.clause}
     ORDER BY s.completed_at DESC, s.id DESC LIMIT 1`,
    dc.params
  );
  return latest?.id;
}

export async function getLatestKeywordOpportunities(req: AuthRequest, res: Response): Promise<void> {
  try {
    const id = await latestCompletedScanId(req);
    if (!id) {
      res.status(404).json({ error: 'No completed scans found yet.' });
      return;
    }
    req.params.scanId = String(id);
    getKeywordOpportunities(req, res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getBacklinkAnalytics(req: AuthRequest, res: Response): void {
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

export async function getLatestBacklinkAnalytics(req: AuthRequest, res: Response): Promise<void> {
  try {
    const id = await latestCompletedScanId(req);
    if (!id) {
      res.status(404).json({ error: 'No completed scans found yet.' });
      return;
    }
    req.params.scanId = String(id);
    getBacklinkAnalytics(req, res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function getImageAltRouteMap(req: AuthRequest, res: Response): void {
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

    if (!stored.pages || stored.pages.length === 0) {
      res.status(404).json({
        error:
          'No image route map found in this scan report. Run a new scan to capture per-route image ALT details.',
      });
      return;
    }

    const routes = stored.pages.map((page) => {
      const images = (page.images || []).map((img) => ({
        src: img.src,
        alt: img.alt || '',
        suggestedAlt: img.suggestedAlt || '',
        hasAlt: Boolean(img.alt && img.alt.trim()),
      }));
      return {
        route: page.url,
        totalImages: images.length,
        missingAltCount: images.filter((i) => !i.hasAlt).length,
        images,
      };
    });

    res.json({
      scanId,
      domain: stored.domain,
      generatedAt: stored.generatedAt,
      totalRoutes: routes.length,
      totalImages: routes.reduce((n, r) => n + r.totalImages, 0),
      missingAltImages: routes.reduce((n, r) => n + r.missingAltCount, 0),
      routes,
      note: 'Use suggestedAlt values as draft ALT text for CMS/WordPress updates.',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getLatestImageAltRouteMap(req: AuthRequest, res: Response): Promise<void> {
  try {
    const id = await latestCompletedScanId(req);
    if (!id) {
      res.status(404).json({ error: 'No completed scans found yet.' });
      return;
    }
    req.params.scanId = String(id);
    getImageAltRouteMap(req, res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getScanReportPdf(req: AuthRequest, res: Response): Promise<void> {
  try {
    const scanId = Number(req.params.scanId);
    if (!Number.isFinite(scanId) || scanId < 1) {
      res.status(400).json({ error: 'Invalid scan id' });
      return;
    }
    const dc = domainCompanyFilter(companyIdFrom(req));
    const row = (await dbGet(
      `SELECT s.id, s.started_at, s.completed_at, s.pages_count, s.seo_score_avg, s.status, s.github_issues_created,
              s.claude_pr_url, s.claude_pr_created_at, s.claude_pr_email_sent_at, s.claude_pr_email_error,
              d.domain
       FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ? AND ${dc.clause}`,
      [scanId, ...dc.params]
    )) as
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
      const report = buildIntelligenceReport(stored);
      pdf = await renderPdf(report);
    } else {
      const issues = (await dbAll(
        `SELECT page_url, issue_type, message, ai_suggestion, status, github_issue_url
         FROM issues WHERE scan_id = ? ORDER BY page_url, id`,
        [scanId]
      )) as ScanPdfIssueRow[];
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

export async function getReports(req: AuthRequest, res: Response): Promise<void> {
  try {
    await recoverStaleRunningScans(listActiveScanIds());
    const dc = domainCompanyFilter(companyIdFrom(req));
    const scans = await dbAll(
      `SELECT s.id, s.domain_id, d.domain, s.started_at, s.completed_at, s.pages_count, s.seo_score_avg,
              s.status, s.email_sent, s.email_sent_at, s.email_error, s.github_issues_created, s.scheduler_run,
              s.claude_pr_url, s.claude_pr_created_at, s.claude_pr_email_sent_at, s.claude_pr_email_error
       FROM scans s JOIN domains d ON d.id = s.domain_id
       WHERE ${dc.clause}
       ORDER BY s.started_at DESC LIMIT 100`,
      dc.params
    );

    const issues = await dbAll(
      `SELECT i.id, i.scan_id, i.page_url, i.issue_type, i.message, i.ai_suggestion, i.status, i.github_issue_url,
              i.seo_score, i.code_snippet, i.code_diff, i.github_pr_url, i.github_pr_branch
       FROM issues i
       JOIN scans s ON s.id = i.scan_id
       JOIN domains d ON d.id = s.domain_id
       WHERE ${dc.clause}
       ORDER BY i.id DESC LIMIT 500`,
      dc.params
    );

    res.json({ scans, issues });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function postSendReport(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { scanId, emailTo } = req.body as { scanId?: number; emailTo?: string };
    if (!scanId || !emailTo) {
      res.status(400).json({ error: 'scanId and emailTo are required' });
      return;
    }

    const companyId = companyIdFrom(req);
    const dc = domainCompanyFilter(companyId);
    const scan = await dbGet<{ id: number; pages_count: number; domain: string }>(
      `SELECT s.id, s.pages_count, d.domain FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.id = ? AND ${dc.clause}`,
      [scanId, ...dc.params]
    );

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
      const issueRows = await dbAll<{ message: string; ai_suggestion: string | null }>(
        `SELECT message, ai_suggestion FROM issues WHERE scan_id = ? LIMIT 20`,
        [scanId]
      );
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

    const emailSentSql = getDriver() === 'postgres' ? 'TRUE' : '1';
    if (r.ok) {
      await dbExecute(
        `UPDATE scans SET email_sent = ${emailSentSql}, email_sent_at = ${sqlNow()}, email_error = NULL WHERE id = ?`,
        [scanId]
      );
      await logActivityAsync('info', 'Manual email report sent', scanId, { to: emailTo }, companyId);
      res.json({ ok: true, message: 'Email sent successfully' });
    } else {
      await dbExecute(`UPDATE scans SET email_error = ? WHERE id = ?`, [r.error, scanId]);
      await logActivityAsync('warn', 'Manual email report failed', scanId, { error: r.error }, companyId);
      res.status(502).json({ ok: false, error: r.error });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getDomains(req: AuthRequest, res: Response): Promise<void> {
  const companyId = companyIdFrom(req);
  const dc = domainCompanyFilter(companyId);
  const rows = await dbAll(
    `SELECT id, domain, created_at FROM domains d WHERE ${dc.clause} ORDER BY id DESC`,
    dc.params
  );
  res.json(rows);
}

export async function postDomain(req: AuthRequest, res: Response): Promise<void> {
  const { domain } = req.body as { domain?: string };
  if (!domain) {
    res.status(400).json({ error: 'domain required' });
    return;
  }
  const d = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  try {
    const companyId = companyIdFrom(req);
    if (companyId != null) {
      let row = await dbGet<{ id: number; domain: string; created_at: string }>(
        'SELECT id, domain, created_at FROM domains WHERE company_id = ? AND domain = ?',
        [companyId, d]
      );
      if (!row) {
        await dbExecute('INSERT INTO domains (company_id, domain) VALUES (?, ?)', [companyId, d]);
        row = await dbGet('SELECT id, domain, created_at FROM domains WHERE company_id = ? AND domain = ?', [
          companyId,
          d,
        ]);
      }
      res.json(row);
      return;
    }
    const exists = await dbGet('SELECT id FROM domains WHERE domain = ? AND company_id IS NULL', [d]);
    if (!exists) await dbExecute('INSERT INTO domains (domain) VALUES (?)', [d]);
    const row = await dbGet('SELECT id, domain, created_at FROM domains WHERE domain = ? AND company_id IS NULL', [d]);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function getDashboardStats(req: AuthRequest, res: Response): Promise<void> {
  const companyId = companyIdFrom(req);
  const dc = domainCompanyFilter(companyId);
  const domainCount = (await dbGet<{ c: number }>(`SELECT COUNT(*) as c FROM domains d WHERE ${dc.clause}`, dc.params))?.c ?? 0;
  const pagesRow = await dbGet<{ c: number }>(
    `SELECT COALESCE(SUM(s.pages_count),0) as c FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.status = 'completed' AND ${dc.clause}`,
    dc.params
  );
  const issuesRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*) as c FROM issues i JOIN scans s ON s.id = i.scan_id JOIN domains d ON d.id = s.domain_id WHERE ${dc.clause}`,
    dc.params
  );
  const avg = await dbGet<{ a: number | null }>(
    `SELECT AVG(s.seo_score_avg) as a FROM scans s JOIN domains d ON d.id = s.domain_id WHERE s.seo_score_avg IS NOT NULL AND ${dc.clause}`,
    dc.params
  );
  res.json({
    totalDomains: domainCount,
    pagesScanned: pagesRow?.c ?? 0,
    issuesDetected: issuesRow?.c ?? 0,
    seoScoreAvg: avg?.a != null ? Math.round(avg.a * 10) / 10 : null,
  });
}

export async function getActivity(req: AuthRequest, res: Response): Promise<void> {
  const companyId = companyIdFrom(req);
  let rows;
  if (companyId != null) {
    rows = await dbAll(
      'SELECT id, created_at, scan_id, level, message, meta FROM activity_log WHERE company_id = ? ORDER BY id DESC LIMIT 100',
      [companyId]
    );
  } else {
    rows = await dbAll(
      'SELECT id, created_at, scan_id, level, message, meta FROM activity_log ORDER BY id DESC LIMIT 100'
    );
  }
  res.json(rows);
}

export async function getSettings(req: AuthRequest, res: Response): Promise<void> {
  const companyId = companyIdFrom(req);
  if (isMultiTenantEnabled() && companyId == null) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (companyId != null) {
    const out = await getCompanySettingsForApi(companyId);
    res.json(out);
    return;
  }
  const { getLegacySetting } = await import('../services/db.service');
  const out: Record<string, string> = { ...getAppSettingsForApi() };
  for (const k of SETTINGS_KEYS) {
    const v = getLegacySetting(k) || process.env[k] || '';
    if (!v) {
      out[k] = '';
      continue;
    }
    out[k] = k.includes('PASS') || k.includes('TOKEN') || k.includes('KEY') ? (v.length > 4 ? `****${v.slice(-4)}` : '****') : v;
  }
  res.json(out);
}

export async function putSettings(req: AuthRequest, res: Response): Promise<void> {
  const body = req.body as Record<string, string>;
  const allowed = new Set<string>(SETTINGS_KEYS);
  const partial: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    if (v.startsWith('****')) continue;
    partial[k] = v;
  }
  const companyId = companyIdFrom(req);
  if (isMultiTenantEnabled() && companyId == null) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (companyId != null) {
    await mergeCompanySettings(companyId, partial);
    if (req.auth) req.auth.settings = await getCompanyConfig(companyId);
    res.json({ ok: true, companyId });
    return;
  }
  const { setLegacySetting } = await import('../services/db.service');
  for (const [k, v] of Object.entries(partial)) setLegacySetting(k, v);
  res.json({ ok: true });
}

export async function postGooglePageSpeedTest(req: AuthRequest, res: Response): Promise<void> {
  try {
    const url = String((req.body as { url?: string })?.url || 'https://example.com').trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid URL' });
      return;
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
      res.status(400).json({ ok: false, error: 'Only http/https URLs are supported' });
      return;
    }

    const metrics = await fetchPageSpeedMetrics(parsed.toString());
    if (!metrics) {
      res.status(502).json({
        ok: false,
        error: 'PageSpeed API call failed. Check ConnectionStrings.Google in appsettings.json and URL accessibility.',
      });
      return;
    }

    res.json({
      ok: true,
      url: parsed.toString(),
      metrics,
      message: 'Google PageSpeed API connection is working.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

export async function postSerpApiTest(req: AuthRequest, res: Response): Promise<void> {
  try {
    const keyword = String((req.body as { keyword?: string })?.keyword || 'seo audit tools').trim();
    const test = await testSerpApiConnection(keyword);
    res.json({ ...test, message: 'SerpAPI connection is working.' });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e) });
  }
}

export async function postSerpLiveRank(req: AuthRequest, res: Response): Promise<void> {
  try {
    const body = req.body as {
      keyword?: string;
      targetDomain?: string;
      location?: string;
      device?: 'desktop' | 'mobile';
      num?: number;
    };
    const keyword = String(body.keyword || '').trim();
    const targetDomain = String(body.targetDomain || '').trim();
    if (!keyword || !targetDomain) {
      res.status(400).json({ ok: false, error: 'keyword and targetDomain are required.' });
      return;
    }
    const data = await fetchSerpLiveRank({
      keyword,
      targetDomain,
      location: body.location || 'India',
      device: body.device === 'mobile' ? 'mobile' : 'desktop',
      num: body.num,
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e) });
  }
}

async function issueForCompany(id: number, companyId: number | undefined) {
  const dc = domainCompanyFilter(companyId);
  return dbGet(
    `SELECT i.id, i.scan_id, i.page_url, i.issue_type, i.message, i.code_snippet, i.github_pr_url, i.ai_suggestion, i.github_issue_url
     FROM issues i JOIN scans s ON s.id = i.scan_id JOIN domains d ON d.id = s.domain_id
     WHERE i.id = ? AND ${dc.clause}`,
    [id, ...dc.params]
  );
}

export async function postIssuePullRequest(req: AuthRequest, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const row = (await issueForCompany(id, companyIdFrom(req))) as
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
  await dbExecute('UPDATE issues SET github_pr_url = ?, github_pr_branch = ?, status = ? WHERE id = ?', [
    pr.pullRequestUrl,
    pr.branch || null,
    'pr_created',
    id,
  ]);
  await logActivityAsync('info', 'GitHub pull request created', undefined, {
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

export async function postIssueGithub(req: AuthRequest, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const row = (await issueForCompany(id, companyIdFrom(req))) as
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
    await dbExecute('UPDATE issues SET github_issue_url = ? WHERE id = ?', [gh.htmlUrl, id]);
    await logActivityAsync('info', 'GitHub issue created', undefined, { issueId: id, url: gh.htmlUrl }, companyIdFrom(req));
    res.json({ ok: true, url: gh.htmlUrl, number: gh.number });
  } else {
    res.status(502).json({ ok: false, error: gh.error });
  }
}

export async function getSeoTrend(req: AuthRequest, res: Response): Promise<void> {
  const dc = domainCompanyFilter(companyIdFrom(req));
  const rows = await dbAll(
    `SELECT s.id, d.domain, s.started_at, s.seo_score_avg FROM scans s
     JOIN domains d ON d.id = s.domain_id
     WHERE s.status = 'completed' AND s.seo_score_avg IS NOT NULL AND ${dc.clause}
     ORDER BY s.started_at ASC LIMIT 200`,
    dc.params
  );
  res.json(rows);
}

export async function postScanClaudePr(req: AuthRequest, res: Response): Promise<void> {
  const scanId = Number(req.params.scanId);
  if (!Number.isFinite(scanId) || scanId < 1) {
    res.status(400).json({ error: 'Invalid scan id' });
    return;
  }
  const dc = domainCompanyFilter(companyIdFrom(req));
  const row = await dbGet<{ id: number; domain: string; claude_pr_url: string | null }>(
    `SELECT s.id, d.domain, s.claude_pr_url
     FROM scans s JOIN domains d ON d.id = s.domain_id
     WHERE s.id = ? AND ${dc.clause}`,
    [scanId, ...dc.params]
  );
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
  await dbExecute(`UPDATE scans SET claude_pr_url = ?, claude_pr_created_at = ${sqlNow()} WHERE id = ?`, [
    result.prUrl,
    scanId,
  ]);
  await logActivityAsync('info', 'Claude PR created', scanId, { prUrl: result.prUrl }, companyIdFrom(req));
  res.json({ ok: true, prUrl: result.prUrl });
}

export async function postScanClaudePrEmail(req: AuthRequest, res: Response): Promise<void> {
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
  const dc = domainCompanyFilter(companyIdFrom(req));
  const row = await dbGet<{ id: number; domain: string; claude_pr_url: string | null }>(
    `SELECT s.id, d.domain, s.claude_pr_url
     FROM scans s JOIN domains d ON d.id = s.domain_id
     WHERE s.id = ? AND ${dc.clause}`,
    [scanId, ...dc.params]
  );
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
    await dbExecute(`UPDATE scans SET claude_pr_email_error = ? WHERE id = ?`, [emailResult.error || 'Email failed', scanId]);
    res.status(502).json({ ok: false, error: emailResult.error || 'Email failed' });
    return;
  }
  await dbExecute(`UPDATE scans SET claude_pr_email_sent_at = ${sqlNow()}, claude_pr_email_error = NULL WHERE id = ?`, [scanId]);
  await logActivityAsync('info', 'Claude PR link emailed', scanId, { to: emailTo }, companyIdFrom(req));
  res.json({ ok: true, message: 'Claude PR link sent by email' });
}
