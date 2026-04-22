import nodemailer from 'nodemailer';
import { getEmailConfig } from './secrets.service';
import { logger } from '../utils/logger';
import { getDb } from './db.service';
import { loadScanReportFile } from './reportFile.service';
import {
  buildScanReportPdf,
  buildScanReportPdfFromPageReports,
  ScanPdfIssueRow,
  ScanPdfMeta,
  suggestedFilename,
} from './pdfReport.service';

export interface EmailReportPayload {
  scanId?: number;
  domain: string;
  pagesCount: number;
  issuesCount: number;
  aiSummaryLines: string[];
  to: string;
}

async function buildDownloadPdfAttachment(scanId: number): Promise<{ filename: string; content: Buffer }> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id, s.started_at, s.completed_at, s.pages_count, s.seo_score_avg, s.status, s.github_issues_created,
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
        domain: string;
      }
    | undefined;

  if (!row) throw new Error(`Scan not found for PDF attachment: ${scanId}`);

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
  const pdf = stored?.pageReports && Object.keys(stored.pageReports).length > 0
    ? await buildScanReportPdfFromPageReports(meta, stored.pageReports)
    : await buildScanReportPdf(
        meta,
        db
          .prepare(
            `SELECT page_url, issue_type, message, ai_suggestion, status, github_issue_url
             FROM issues WHERE scan_id = ? ORDER BY page_url, id`
          )
          .all(scanId) as ScanPdfIssueRow[]
      );

  return { filename: suggestedFilename(row.domain, scanId), content: pdf };
}

export async function sendReportEmail(payload: EmailReportPayload): Promise<{ ok: boolean; error?: string }> {
  const { host, port, user, pass, from } = getEmailConfig();
  if (!host || !user) {
    return { ok: false, error: 'Email not configured (EMAIL_HOST / EMAIL_USER)' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  const subject = `SEO audit report: ${payload.domain}`;
  const text = [
    'SEO AUDIT REPORT',
    '=================',
    '',
    `Domain scanned: ${payload.domain}`,
    `Pages: ${payload.pagesCount}`,
    `Issues detected: ${payload.issuesCount}`,
    '',
    'Top findings and suggestions:',
    ...payload.aiSummaryLines.map((l) => `- ${l}`),
    '',
    'PDF report attached: open the attachment for full page-by-page findings and recommendations.',
  ].join('\n');
  const html = `
    <div style="background:#0f172a;padding:24px;font-family:Arial,'Segoe UI',Helvetica,sans-serif;color:#e2e8f0;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;">
      <div style="max-width:680px;margin:0 auto;border:1px solid #334155;border-radius:12px;overflow:hidden;background:#111c33;">
        <div style="padding:20px 22px;border-bottom:2px solid #5eead4;">
          <div style="font-size:26px;font-weight:700;line-height:1.2;color:#e2e8f0;">AI SEO Agent</div>
          <div style="margin-top:6px;color:#94a3b8;font-size:14px;">Your intelligent SEO audit assistant</div>
        </div>
        <div style="padding:22px;">
          <p style="margin:0 0 14px;font-size:30px;font-weight:700;line-height:1.25;color:#e2e8f0;">Hi there,</p>
          <p style="margin:0 0 18px;font-size:18px;line-height:1.5;color:#e2e8f0;">
            I've finished analyzing <strong>${payload.domain}</strong>. Below is a quick snapshot.
            Your <span style="color:#5eead4;font-weight:700;">full SEO audit</span> is attached as a PDF.
          </p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px;">
            <div style="flex:1 1 220px;border:1px solid #334155;background:#111c33;border-radius:12px;padding:14px;">
              <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;">Pages analyzed</div>
              <div style="font-size:34px;font-weight:700;color:#e2e8f0;margin-top:4px;">${payload.pagesCount}</div>
            </div>
            <div style="flex:1 1 220px;border:1px solid #334155;background:#111c33;border-radius:12px;padding:14px;">
              <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;">Issues flagged</div>
              <div style="font-size:34px;font-weight:700;color:#e2e8f0;margin-top:4px;">${payload.issuesCount}</div>
            </div>
          </div>
          <div style="border:1px solid #2c7a7b;background:#1e293b;border-radius:12px;padding:14px;">
            <div style="font-size:26px;font-weight:700;color:#5eead4;margin-bottom:6px;">PDF report attached</div>
            <div style="font-size:16px;line-height:1.45;color:#e2e8f0;">
              Open the attachment for the complete breakdown: page-by-page findings, technical notes, and suggested fixes.
            </div>
          </div>
          <p style="margin:22px 0 0;color:#94a3b8;">— AI SEO Agent</p>
        </div>
      </div>
    </div>
  `;

  try {
    const pdfAttachment = payload.scanId ? await buildDownloadPdfAttachment(payload.scanId) : null;

    await transporter.sendMail({
      from: from || user,
      to: payload.to,
      subject,
      text,
      html,
      attachments: pdfAttachment
        ? [
            {
              filename: pdfAttachment.filename,
              content: pdfAttachment.content,
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    });
    return { ok: true };
  } catch (e) {
    logger.error('sendReportEmail failed', { error: String(e) });
    return { ok: false, error: String(e) };
  }
}
