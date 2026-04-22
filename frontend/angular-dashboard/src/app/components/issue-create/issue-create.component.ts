import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, IssueRow } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';

@Component({
  selector: 'app-issue-create',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './issue-create.component.html',
  styleUrl: './issue-create.component.scss',
})
export class IssueCreateComponent implements OnInit {
  private readonly api = inject(ApiService);
  issues: IssueRow[] = [];
  allDomains: string[] = [];
  domainByScanId: Record<number, string> = {};
  selectedDomain = '';
  readonly pageSize = 8;
  currentPage = 1;
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
        this.syncSelectedDomain();
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
    this.api.getDomains().subscribe({
      next: (domains) => {
        this.allDomains = domains.map((d) => d.domain).filter(Boolean);
        this.syncSelectedDomain();
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  get availableDomains(): string[] {
    const domains = new Set<string>(this.allDomains);
    for (const issue of this.issues) {
      domains.add(this.domainByScanId[issue.scan_id] || 'unknown-domain');
    }
    return [...domains].sort((a, b) => a.localeCompare(b));
  }

  private syncSelectedDomain(): void {
    if (!this.selectedDomain && this.availableDomains.length) {
      this.selectedDomain = this.availableDomains[0];
      this.currentPage = 1;
    }
    if (this.selectedDomain && !this.availableDomains.includes(this.selectedDomain)) {
      this.selectedDomain = this.availableDomains[0] || '';
      this.currentPage = 1;
    }
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

  get selectedDomainGroups(): { domain: string; pages: { pageUrl: string; issues: IssueRow[] }[] }[] {
    if (!this.selectedDomain) return [];
    return this.groupedByDomain.filter((x) => x.domain === this.selectedDomain);
  }

  get selectedPages(): { pageUrl: string; issues: IssueRow[] }[] {
    return this.selectedDomainGroups[0]?.pages || [];
  }

  get pagedSelectedPages(): { pageUrl: string; issues: IssueRow[] }[] {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.selectedPages.slice(start, start + this.pageSize);
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.selectedPages.length / this.pageSize));
  }

  get pageNumbers(): number[] {
    return Array.from({ length: this.totalPages }, (_, i) => i + 1);
  }

  onDomainChange(): void {
    this.currentPage = 1;
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
}
