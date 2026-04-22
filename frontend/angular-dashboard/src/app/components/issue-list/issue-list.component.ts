import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService, IssueRow } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';

@Component({
  selector: 'app-issue-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './issue-list.component.html',
  styleUrl: './issue-list.component.scss',
})
export class IssueListComponent implements OnInit {
  private readonly api = inject(ApiService);

  issues: IssueRow[] = [];
  domainByScanId: Record<number, string> = {};
  busyId: number | null = null;
  message: string | null = null;
  error: string | null = null;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.getReports().subscribe({
      next: (r) => {
        this.issues = r.issues;
        this.domainByScanId = Object.fromEntries(r.scans.map((s) => [s.id, s.domain]));
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  get groupedByDomain(): { domain: string; pages: { pageUrl: string; issues: IssueRow[] }[] }[] {
    const byDomain = new Map<string, Map<string, IssueRow[]>>();
    for (const issue of this.issues) {
      const domain = this.domainByScanId[issue.scan_id] || 'unknown-domain';
      const pages = byDomain.get(domain) || new Map<string, IssueRow[]>();
      const pageRows = pages.get(issue.page_url) || [];
      pageRows.push(issue);
      pages.set(issue.page_url, pageRows);
      byDomain.set(domain, pages);
    }
    return [...byDomain.entries()].map(([domain, pages]) => ({
      domain,
      pages: [...pages.entries()].map(([pageUrl, rows]) => ({ pageUrl, issues: rows })),
    }));
  }

  get issueSectionGroups(): { domain: string; pages: { pageUrl: string; issues: IssueRow[] }[] }[] {
    return this.groupedByDomain;
  }

  get prSectionGroups(): { domain: string; pages: { pageUrl: string; issues: IssueRow[] }[] }[] {
    return this.groupedByDomain;
  }

  async copyCode(snippet: string | null | undefined): Promise<void> {
    if (!snippet?.trim()) {
      this.error = 'No suggested code snippet available for this issue.';
      return;
    }
    try {
      await navigator.clipboard.writeText(snippet);
      this.message = 'Suggested code copied to clipboard.';
      this.error = null;
    } catch (e) {
      this.error = `Failed to copy code: ${String(e)}`;
    }
  }

  createGithub(issue: IssueRow): void {
    this.busyId = issue.id;
    this.message = null;
    this.error = null;
    this.api.postIssueGithub(issue.id).subscribe({
      next: (res) => {
        this.busyId = null;
        if (res.ok && res.url) this.message = `GitHub issue: ${res.url}`;
        else this.error = res.error || 'Failed';
        this.load();
      },
      error: (e) => {
        this.busyId = null;
        this.error = httpErrorMessage(e);
      },
    });
  }

  createPullRequest(issue: IssueRow): void {
    this.busyId = issue.id;
    this.message = null;
    this.error = null;
    this.api.postIssuePullRequest(issue.id).subscribe({
      next: (res) => {
        this.busyId = null;
        if (res.ok && res.url) this.message = `Pull request created: ${res.url}`;
        else this.error = res.error || 'Failed';
        this.load();
      },
      error: (e) => {
        this.busyId = null;
        this.error = httpErrorMessage(e);
      },
    });
  }
}
