import { Component, ElementRef, HostListener, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, ScanRow } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';

@Component({
  selector: 'app-scan-results',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scan-results.component.html',
  styleUrl: './scan-results.component.scss',
})
export class ScanResultsComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  scans: ScanRow[] = [];
  statusFilter: 'all' | 'running' | 'completed' | 'stopped' | 'failed' = 'all';
  emailTo = '';
  busyId: number | null = null;
  stoppingScanId: number | null = null;
  rerunScanId: number | null = null;
  claudePrBusyId: number | null = null;
  emailPrBusyId: number | null = null;
  deletingScanId: number | null = null;
  reportDownloading: { scanId: number; format: 'pdf' | 'json' | 'md' } | null = null;
  reportMenuForScanId: number | null = null;
  showPrByScanId: Record<number, boolean> = {};
  message: string | null = null;
  error: string | null = null;
  readonly pageSize = 10;
  currentPage = 1;

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
    this.stopRefreshTimer();
  }

  /** Poll only while a scan is running — stops when all scans finish or fail. */
  private syncRefreshTimer(): void {
    const hasRunning = this.scans.some((s) => s.status === 'running');
    if (hasRunning && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.load(true), 5000);
    } else if (!hasRunning) {
      this.stopRefreshTimer();
    }
  }

  runningScanCount(): number {
    return this.scans.filter((s) => s.status === 'running').length;
  }

  completedScanCount(): number {
    return this.scans.filter((s) => s.status === 'completed').length;
  }

  failedScanCount(): number {
    return this.scans.filter((s) => s.status === 'failed').length;
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  load(silent = false): void {
    this.api.getReports().subscribe({
      next: (r) => {
        this.scans = r.scans;
        this.ensureValidPage();
        this.syncRefreshTimer();
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

  reportDownloadingLabelForScan(scanId: number): 'PDF' | 'JSON' | 'MD' | null {
    if (!this.reportDownloading || this.reportDownloading.scanId !== scanId) return null;
    return this.reportDownloading.format === 'pdf'
      ? 'PDF'
      : this.reportDownloading.format === 'json'
        ? 'JSON'
        : 'MD';
  }

  toggleReportMenu(scanId: number): void {
    this.reportMenuForScanId = this.reportMenuForScanId === scanId ? null : scanId;
  }

  chooseReportFormat(scan: ScanRow, format: 'pdf' | 'json' | 'md'): void {
    this.reportMenuForScanId = null;
    this.downloadReport(scan, format);
  }

  statusClass(status: ScanRow['status']): string {
    if (status === 'completed') return 'status-completed';
    if (status === 'running') return 'status-running';
    if (status === 'failed') return 'status-failed';
    if (status === 'stopped') return 'status-stopped';
    return 'status-default';
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.reportMenuForScanId == null) return;
    const targetNode = event.target as Node | null;
    if (!targetNode) return;

    const targetElement =
      targetNode instanceof Element ? targetNode : (targetNode.parentElement ?? null);

    // Close when click happens outside any report menu/trigger block.
    if (!targetElement || !targetElement.closest('.report-menu')) {
      this.reportMenuForScanId = null;
    }
  }

  downloadReport(scan: ScanRow, format: 'pdf' | 'json' | 'md'): void {
    if (this.reportDownloading != null) return;
    this.reportDownloading = { scanId: scan.id, format };
    this.error = null;
    const request =
      format === 'pdf'
        ? this.api.downloadReportPdf(scan.id)
        : format === 'json'
          ? this.api.downloadReportJson(scan.id)
          : this.api.downloadReportMarkdown(scan.id);
    const ext = format === 'pdf' ? 'pdf' : format === 'json' ? 'json' : 'md';
    request.subscribe({
      next: (blob) => {
        this.reportDownloading = null;
        const safeDomain = scan.domain.replace(/[^\w.-]+/g, '-');
        this.saveBlobDownload(blob, `seo-report-${safeDomain}-${scan.id}.${ext}`);
      },
      error: (e) => {
        this.reportDownloading = null;
        void this.reportDownloadErrorMessage(e).then((msg) => (this.error = msg));
      },
    });
  }

  private saveBlobDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private async reportDownloadErrorMessage(err: unknown): Promise<string> {
    if (err instanceof HttpErrorResponse && err.error instanceof Blob) {
      try {
        const text = await err.error.text();
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) return parsed.error;
        return text || httpErrorMessage(err);
      } catch {
        return httpErrorMessage(err);
      }
    }
    return httpErrorMessage(err);
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
    if (this.rerunScanId != null) return;
    if (this.scans.some((s) => s.domain === scan.domain && s.status === 'running')) {
      this.error = `A scan is already running for ${scan.domain}.`;
      return;
    }
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
          this.message = r.alreadyRunning
            ? `Scan already running for ${r.domain} (ID ${r.scanId}).`
            : `Re-run started for ${r.domain} (ID ${r.scanId}).`;
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

  deleteScan(scan: ScanRow): void {
    if (!confirm(`Delete scan #${scan.id} for ${scan.domain}? This cannot be undone.`)) return;
    this.deletingScanId = scan.id;
    this.error = null;
    this.message = null;
    this.api.deleteScan(scan.id).subscribe({
      next: (r) => {
        this.deletingScanId = null;
        this.message = r.message || 'Scan deleted.';
        this.load();
      },
      error: (e) => {
        this.deletingScanId = null;
        this.error = httpErrorMessage(e);
      },
    });
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
