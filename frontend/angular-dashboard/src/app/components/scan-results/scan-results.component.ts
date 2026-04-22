import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, ScanRow } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-scan-results',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scan-results.component.html',
  styleUrl: './scan-results.component.scss',
})
export class ScanResultsComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  scans: ScanRow[] = [];
  statusFilter: 'all' | 'running' | 'completed' | 'stopped' | 'failed' = 'all';
  emailTo = '';
  busyId: number | null = null;
  stoppingScanId: number | null = null;
  rerunScanId: number | null = null;
  claudePrBusyId: number | null = null;
  emailPrBusyId: number | null = null;
  showPrByScanId: Record<number, boolean> = {};
  message: string | null = null;
  error: string | null = null;
  readonly pageSize = 10;
  currentPage = 1;

  ngOnInit(): void {
    this.load();
    this.refreshTimer = setInterval(() => this.load(true), 5000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  load(silent = false): void {
    this.api.getReports().subscribe({
      next: (r) => {
        this.scans = r.scans;
        this.ensureValidPage();
      },
      error: (e) => {
        if (!silent) this.error = httpErrorMessage(e);
      },
    });
  }

  get filteredScans(): ScanRow[] {
    if (this.statusFilter === 'all') return this.scans;
    return this.scans.filter((s) => s.status === this.statusFilter);
  }

  get pagedScans(): ScanRow[] {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredScans.slice(start, start + this.pageSize);
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filteredScans.length / this.pageSize));
  }

  get pageNumbers(): number[] {
    return Array.from({ length: this.totalPages }, (_, i) => i + 1);
  }

  onStatusFilterChange(): void {
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

  private ensureValidPage(): void {
    if (this.currentPage > this.totalPages) this.currentPage = this.totalPages;
    if (this.currentPage < 1) this.currentPage = 1;
  }

  /** Same-origin URL for GET PDF (works with `ng serve` proxy). */
  pdfUrl(scanId: number): string {
    return `${environment.apiUrl}/reports/${scanId}/pdf`;
  }

  scoreQuality(score: number | null): 'Good' | 'Needs Improvement' | 'Poor' | 'N/A' {
    if (score == null) return 'N/A';
    if (score >= 80) return 'Good';
    if (score >= 50) return 'Needs Improvement';
    return 'Poor';
  }

  scoreQualityClass(score: number | null): string {
    const quality = this.scoreQuality(score);
    if (quality === 'Good') return 'good';
    if (quality === 'Needs Improvement') return 'needs';
    if (quality === 'Poor') return 'poor';
    return 'na';
  }

  sendReport(scan: ScanRow): void {
    if (!this.emailTo.trim()) {
      this.error = 'Enter an email address above.';
      return;
    }
    this.busyId = scan.id;
    this.error = null;
    this.message = null;
    this.api.postSendReport(scan.id, this.emailTo.trim()).subscribe({
      next: (r) => {
        this.busyId = null;
        this.message = r.message || 'Sent.';
        this.load();
      },
      error: (e) => {
        this.busyId = null;
        this.error = httpErrorMessage(e);
      },
    });
  }

  stopScan(scan: ScanRow): void {
    this.stoppingScanId = scan.id;
    this.error = null;
    this.message = null;
    this.api.stopScan(scan.id).subscribe({
      next: (r) => {
        this.stoppingScanId = null;
        this.message = r.message || 'Scan stopped.';
        this.load();
      },
      error: (e) => {
        this.stoppingScanId = null;
        this.error = httpErrorMessage(e);
      },
    });
  }

  rerunScan(scan: ScanRow): void {
    this.rerunScanId = scan.id;
    this.error = null;
    this.message = null;
    this.api
      .postScan({
        domain: scan.domain,
      })
      .subscribe({
        next: (r) => {
          this.rerunScanId = null;
          this.message = `Re-run started for ${r.domain} (ID ${r.scanId}).`;
          this.load();
        },
        error: (e) => {
          this.rerunScanId = null;
          this.error = httpErrorMessage(e);
        },
      });
  }

  togglePrLink(scan: ScanRow): void {
    this.showPrByScanId[scan.id] = !this.showPrByScanId[scan.id];
  }

  createClaudePr(scan: ScanRow): void {
    this.claudePrBusyId = scan.id;
    this.message = null;
    this.error = null;
    this.api.createClaudePr(scan.id).subscribe({
      next: (r) => {
        this.claudePrBusyId = null;
        if (r.ok && r.prUrl) {
          this.message = `Claude PR created: ${r.prUrl}`;
          this.showPrByScanId[scan.id] = true;
        } else {
          this.error = r.error || 'Failed to generate PR via Claude.';
        }
        this.load();
      },
      error: (e) => {
        this.claudePrBusyId = null;
        this.error = httpErrorMessage(e);
      },
    });
  }

  async copyPrLink(link: string | null | undefined): Promise<void> {
    if (!link) {
      this.error = 'No PR link available.';
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      this.message = 'PR link copied.';
    } catch (e) {
      this.error = `Failed to copy PR link: ${String(e)}`;
    }
  }

  emailPrLink(scan: ScanRow): void {
    const to = this.emailTo.trim();
    if (!to) {
      this.error = 'Enter an email address above.';
      return;
    }
    this.emailPrBusyId = scan.id;
    this.message = null;
    this.error = null;
    this.api.emailClaudePrLink(scan.id, to).subscribe({
      next: (r) => {
        this.emailPrBusyId = null;
        if (r.ok) this.message = r.message || 'PR link sent.';
        else this.error = r.error || 'Failed to email PR link.';
        this.load();
      },
      error: (e) => {
        this.emailPrBusyId = null;
        this.error = httpErrorMessage(e);
      },
    });
  }
}
