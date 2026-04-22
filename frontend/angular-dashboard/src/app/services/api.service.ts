import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface DashboardStats {
  totalDomains: number;
  pagesScanned: number;
  issuesDetected: number;
  seoScoreAvg: number | null;
}

export interface DomainRow {
  id: number;
  domain: string;
  created_at: string;
}

export interface ScanRow {
  id: number;
  domain_id: number;
  domain: string;
  started_at: string;
  completed_at: string | null;
  pages_count: number;
  seo_score_avg: number | null;
  status: string;
  email_sent: number;
  email_sent_at: string | null;
  email_error: string | null;
  github_issues_created: number;
  scheduler_run: number;
  claude_pr_url?: string | null;
  claude_pr_created_at?: string | null;
  claude_pr_email_sent_at?: string | null;
  claude_pr_email_error?: string | null;
}

export interface IssueRow {
  id: number;
  scan_id: number;
  page_url: string;
  issue_type: string;
  message: string;
  ai_suggestion: string | null;
  status: string;
  github_issue_url: string | null;
  seo_score?: number | null;
  code_snippet?: string | null;
  code_diff?: string | null;
  github_pr_url?: string | null;
  github_pr_branch?: string | null;
}

export interface ActivityRow {
  id: number;
  created_at: string;
  scan_id: number | null;
  level: string;
  message: string;
  meta: string | null;
}

export interface SeoTrendPoint {
  id: number;
  domain: string;
  started_at: string;
  seo_score_avg: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  getDashboardStats(): Observable<DashboardStats> {
    return this.http.get<DashboardStats>(`${this.base}/dashboard-stats`);
  }

  getReports(): Observable<{ scans: ScanRow[]; issues: IssueRow[] }> {
    return this.http.get<{ scans: ScanRow[]; issues: IssueRow[] }>(`${this.base}/reports`);
  }

  getDomains(): Observable<DomainRow[]> {
    return this.http.get<DomainRow[]>(`${this.base}/domains`);
  }

  postDomain(domain: string): Observable<DomainRow> {
    return this.http.post<DomainRow>(`${this.base}/domains`, { domain });
  }

  postScan(body: {
    domain: string;
    emailTo?: string;
    createGithubIssues?: boolean;
  }): Observable<{ scanId: number; domain: string; status: string; message: string }> {
    return this.http.post<{ scanId: number; domain: string; status: string; message: string }>(`${this.base}/scan`, body);
  }

  stopScan(scanId: number): Observable<{ ok: boolean; scanId: number; status: string; message: string }> {
    return this.http.post<{ ok: boolean; scanId: number; status: string; message: string }>(
      `${this.base}/scan/${scanId}/stop`,
      {}
    );
  }

  createClaudePr(scanId: number): Observable<{ ok: boolean; prUrl?: string; error?: string; message?: string }> {
    return this.http.post<{ ok: boolean; prUrl?: string; error?: string; message?: string }>(
      `${this.base}/scans/${scanId}/claude-pr`,
      {}
    );
  }

  emailClaudePrLink(
    scanId: number,
    emailTo: string
  ): Observable<{ ok: boolean; message?: string; error?: string }> {
    return this.http.post<{ ok: boolean; message?: string; error?: string }>(`${this.base}/scans/${scanId}/claude-pr/email`, {
      emailTo,
    });
  }

  postSendReport(scanId: number, emailTo: string): Observable<{ ok: boolean; message?: string; error?: string }> {
    return this.http.post<{ ok: boolean; message?: string; error?: string }>(`${this.base}/send-report`, {
      scanId,
      emailTo,
    });
  }

  getSettings(): Observable<Record<string, string>> {
    return this.http.get<Record<string, string>>(`${this.base}/settings`);
  }

  putSettings(body: Record<string, string>): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.base}/settings`, body);
  }

  postIssueGithub(issueId: number): Observable<{ ok: boolean; url?: string; error?: string }> {
    return this.http.post<{ ok: boolean; url?: string; error?: string }>(`${this.base}/issues/${issueId}/github`, {});
  }

  postIssuePullRequest(
    issueId: number
  ): Observable<{ ok: boolean; url?: string; branch?: string; filePath?: string; error?: string }> {
    return this.http.post<{ ok: boolean; url?: string; branch?: string; filePath?: string; error?: string }>(
      `${this.base}/issues/${issueId}/pull-request`,
      {}
    );
  }

  getActivity(): Observable<ActivityRow[]> {
    return this.http.get<ActivityRow[]>(`${this.base}/activity`);
  }

  getSeoTrend(): Observable<SeoTrendPoint[]> {
    return this.http.get<SeoTrendPoint[]>(`${this.base}/seo-trend`);
  }
}
