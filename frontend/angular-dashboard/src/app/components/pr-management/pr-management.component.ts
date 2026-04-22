import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService, IssueRow } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';
import { formatSeoSnippet } from '../../utils/seo-snippet';

@Component({
  selector: 'app-pr-management',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './pr-management.component.html',
  styleUrl: './pr-management.component.scss',
})
export class PrManagementComponent implements OnInit {
  private readonly api = inject(ApiService);
  issues: IssueRow[] = [];
  domainByScanId: Record<number, string> = {};
  busyId: number | null = null;
  message: string | null = null;
  error: string | null = null;
  readonly pageSize = 8;
  currentPage = 1;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.getReports().subscribe({
      next: (r) => {
        this.issues = r.issues;
        this.domainByScanId = Object.fromEntries(r.scans.map((s) => [s.id, s.domain]));
        if (this.currentPage > this.totalPages) this.currentPage = this.totalPages;
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  get groupedByDomain(): { domain: string; pages: { pageUrl: string; issues: IssueRow[] }[] }[] {
    const byDomain = new Map<string, Map<string, IssueRow[]>>();
    for (const issue of this.issues) {
      const formattedSnippet = formatSeoSnippet(issue);
      if (!formattedSnippet.trim()) continue;
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

  get flatPages(): { domain: string; pageUrl: string; issues: IssueRow[] }[] {
    return this.groupedByDomain.flatMap((d) => d.pages.map((p) => ({ domain: d.domain, pageUrl: p.pageUrl, issues: p.issues })));
  }

  get pagedFlatPages(): { domain: string; pageUrl: string; issues: IssueRow[] }[] {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.flatPages.slice(start, start + this.pageSize);
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.flatPages.length / this.pageSize));
  }

  get pageNumbers(): number[] {
    return Array.from({ length: this.totalPages }, (_, i) => i + 1);
  }

  goToPage(page: number): void {
    this.currentPage = Math.min(this.totalPages, Math.max(1, page));
  }

  previousPage(): void {
    this.goToPage(this.currentPage - 1);
  }

  nextPage(): void {
    this.goToPage(this.currentPage + 1);
  }

  snippet(issue: IssueRow): string {
    return formatSeoSnippet(issue);
  }

  async copyCode(issue: IssueRow): Promise<void> {
    const text = this.snippet(issue);
    if (!text) {
      this.error = 'No code snippet available for this issue.';
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.message = 'Code snippet copied to clipboard.';
      this.error = null;
    } catch (e) {
      this.error = `Failed to copy code: ${String(e)}`;
    }
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
