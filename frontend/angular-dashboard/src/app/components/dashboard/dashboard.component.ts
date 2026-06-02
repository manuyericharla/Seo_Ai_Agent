import {
  Component,
  OnDestroy,
  OnInit,
  AfterViewInit,
  ElementRef,
  ViewChild,
  HostListener,
  inject,
} from '@angular/core';
import { CommonModule, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Chart, registerables } from 'chart.js';
import {
  ApiService,
  ActivityRow,
  DashboardStats,
  DomainRow,
  ScanRow,
  SeoTrendPoint,
} from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';
import { Subscription } from 'rxjs';

Chart.register(...registerables);

export interface TrendDelta {
  up: boolean;
  pct: number;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, NgClass, RouterLink, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  @ViewChild('trendCanvas') trendCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('rangePopoverRoot') rangePopoverRoot?: ElementRef<HTMLElement>;
  private static readonly activityPreviewLimit = 10;
  /** X-axis labels like "Apr 20" (en-US), independent of browser locale. */
  private static readonly chartDayLabelFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  });
  /** Toolbar chip: "May 11, 2026 – May 17, 2026" */
  private static readonly toolbarRangeFmt = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  stats: DashboardStats | null = null;
  activity: ActivityRow[] = [];
  trend: SeoTrendPoint[] = [];
  scans: ScanRow[] = [];
  domains: DomainRow[] = [];
  error: string | null = null;
  chartDays = 30;
  scheduledScans: Array<{
    domain: string;
    frequency: string;
    email: string;
    active: boolean;
  }> = [];
  private chart?: Chart;
  private sub = new Subscription();

  /** Reporting window for domain/pages/issues trend cards (local calendar days). */
  rangeStart!: Date;
  rangeEnd!: Date;
  rangeMenuOpen = false;
  draftStartStr = '';
  draftEndStr = '';

  constructor() {
    const w = DashboardComponent.defaultCalendarWeek(new Date());
    this.rangeStart = w.start;
    this.rangeEnd = w.end;
  }

  ngOnInit(): void {
    this.sub.add(
      this.api.getDashboardStats().subscribe({
        next: (s) => (this.stats = s),
        error: (e) => (this.error = httpErrorMessage(e)),
      })
    );
    this.sub.add(
      this.api.getActivity().subscribe({
        next: (a) => {
          this.activity = [...a].sort(
            (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
          );
        },
      })
    );
    this.sub.add(
      this.api.getSeoTrend().subscribe({
        next: (t) => {
          this.trend = t;
          queueMicrotask(() => this.renderChart());
        },
      })
    );
    this.sub.add(
      this.api.getReports().subscribe({
        next: (r) => (this.scans = r.scans ?? []),
        error: () => (this.scans = []),
      })
    );
    this.sub.add(
      this.api.getDomains().subscribe({
        next: (d) => (this.domains = d ?? []),
        error: () => (this.domains = []),
      })
    );
    this.sub.add(
      this.api.getSettings().subscribe({
        next: (settings) => {
          const savedRules = settings['scheduler.rules'];
          if (!savedRules) {
            this.scheduledScans = [];
            return;
          }
          try {
            const parsed = JSON.parse(savedRules) as Array<{
              domain: string;
              frequency: string;
              email: string;
              active: boolean;
            }>;
            this.scheduledScans = Array.isArray(parsed) ? parsed : [];
          } catch {
            this.scheduledScans = [];
          }
        },
      })
    );
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => this.renderChart());
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.chart?.destroy();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.rangeMenuOpen) return;
    const root = this.rangePopoverRoot?.nativeElement;
    if (root && !root.contains(ev.target as Node)) {
      this.rangeMenuOpen = false;
    }
  }

  get toolbarRangeLabel(): string {
    return `${DashboardComponent.toolbarRangeFmt.format(this.rangeStart)} – ${DashboardComponent.toolbarRangeFmt.format(this.rangeEnd)}`;
  }

  toggleRangeMenu(ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.rangeMenuOpen) {
      this.rangeMenuOpen = false;
    } else {
      this.syncDraftFromRange();
      this.rangeMenuOpen = true;
    }
  }

  closeRangeMenu(): void {
    this.rangeMenuOpen = false;
  }

  applyDraftRange(): void {
    const s = DashboardComponent.parseYmd(this.draftStartStr);
    const e = DashboardComponent.parseYmd(this.draftEndStr);
    if (!s || !e) return;
    if (DashboardComponent.startOfDay(s).getTime() > DashboardComponent.startOfDay(e).getTime()) return;
    this.rangeStart = DashboardComponent.startOfDay(s);
    this.rangeEnd = DashboardComponent.startOfDay(e);
    this.rangeMenuOpen = false;
  }

  presetThisWeek(): void {
    const w = DashboardComponent.defaultCalendarWeek(new Date());
    this.rangeStart = w.start;
    this.rangeEnd = w.end;
    this.syncDraftFromRange();
    this.rangeMenuOpen = false;
  }

  presetLastDays(n: number): void {
    const end = DashboardComponent.startOfDay(new Date());
    const start = new Date(end);
    start.setDate(end.getDate() - (n - 1));
    this.rangeStart = start;
    this.rangeEnd = end;
    this.syncDraftFromRange();
    this.rangeMenuOpen = false;
  }

  get chartPeriodLabel(): string {
    return `Last ${this.chartDays} days`;
  }

  setChartDays(days: number): void {
    this.chartDays = days;
    queueMicrotask(() => this.renderChart());
  }

  get trendFilteredForChart(): SeoTrendPoint[] {
    if (!this.trend.length) return [];
    const cut = new Date();
    cut.setDate(cut.getDate() - this.chartDays);
    const t0 = cut.getTime();
    return [...this.trend]
      .filter((p) => new Date(p.started_at).getTime() >= t0)
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  }

  domainTrend(): TrendDelta | null {
    const { recent, prev } = this.countDomainsInWindows();
    return this.formatCountDelta(recent, prev);
  }

  pagesTrend(): TrendDelta | null {
    const { recent, prev } = this.sumPagesInWindows();
    return this.formatCountDelta(recent, prev);
  }

  issuesTrend(): TrendDelta | null {
    const { recent, prev } = this.sumGithubIssuesInWindows();
    return this.formatCountDelta(recent, prev);
  }

  seoTrend(): TrendDelta | null {
    const pts = this.trendFilteredForChart;
    if (pts.length < 2) return null;
    const first = pts[0].seo_score_avg;
    const last = pts[pts.length - 1].seo_score_avg;
    if (first === 0) return null;
    const raw = ((last - first) / first) * 100;
    return { up: raw >= 0, pct: Math.min(999, Math.round(Math.abs(raw))) };
  }

  trendCaptionForMetricRange(): string {
    const n = DashboardComponent.inclusiveDayCount(this.rangeStart, this.rangeEnd);
    return `vs prior ${n} day${n === 1 ? '' : 's'}`;
  }

  trendCaptionChartPeriod(): string {
    return `in last ${this.chartDays} days`;
  }

  markInactive(domain: string): void {
    const nextRules = this.scheduledScans.map((row) =>
      row.domain.toLowerCase() === domain.toLowerCase() ? { ...row, active: false } : row
    );
    this.api
      .putSettings({
        'scheduler.rules': JSON.stringify(nextRules),
      })
      .subscribe({
        next: () => {
          this.scheduledScans = nextRules;
        },
        error: (e) => {
          this.error = httpErrorMessage(e);
        },
      });
  }

  markActive(domain: string): void {
    const nextRules = this.scheduledScans.map((row) =>
      row.domain.toLowerCase() === domain.toLowerCase() ? { ...row, active: true } : row
    );
    this.api
      .putSettings({
        'scheduler.rules': JSON.stringify(nextRules),
      })
      .subscribe({
        next: () => {
          this.scheduledScans = nextRules;
        },
        error: (e) => {
          this.error = httpErrorMessage(e);
        },
      });
  }

  /** Latest N activity rows for the dashboard card (no pagination). */
  get recentActivity(): ActivityRow[] {
    return this.activity.slice(0, DashboardComponent.activityPreviewLimit);
  }

  /** Split "Scan completed: domain" so label and URL stack like the reference layout. */
  activityMessageParts(msg: string): { first: string; second?: string } {
    const prefix = 'Scan completed: ';
    if (msg.startsWith(prefix)) {
      const detail = msg.slice(prefix.length).trim();
      if (detail) return { first: 'Scan completed:', second: detail };
    }
    return { first: msg };
  }

  private countDomainsInWindows(): { recent: number; prev: number } {
    const { cur0, cur1, prev0, prev1 } = this.metricWindows();
    let recent = 0;
    let prev = 0;
    for (const row of this.domains) {
      const t = new Date(row.created_at).getTime();
      if (t >= cur0 && t <= cur1) recent++;
      else if (t >= prev0 && t <= prev1) prev++;
    }
    return { recent, prev };
  }

  private sumPagesInWindows(): { recent: number; prev: number } {
    const { cur0, cur1, prev0, prev1 } = this.metricWindows();
    let recent = 0;
    let prev = 0;
    for (const scan of this.scans) {
      if (scan.status !== 'completed' || !scan.completed_at) continue;
      const t = new Date(scan.completed_at).getTime();
      const pc = scan.pages_count ?? 0;
      if (t >= cur0 && t <= cur1) recent += pc;
      else if (t >= prev0 && t <= prev1) prev += pc;
    }
    return { recent, prev };
  }

  private sumGithubIssuesInWindows(): { recent: number; prev: number } {
    const { cur0, cur1, prev0, prev1 } = this.metricWindows();
    let recent = 0;
    let prev = 0;
    for (const scan of this.scans) {
      if (scan.status !== 'completed' || !scan.completed_at) continue;
      const t = new Date(scan.completed_at).getTime();
      const c = scan.github_issues_created ?? 0;
      if (t >= cur0 && t <= cur1) recent += c;
      else if (t >= prev0 && t <= prev1) prev += c;
    }
    return { recent, prev };
  }

  private metricWindows(): { cur0: number; cur1: number; prev0: number; prev1: number } {
    const cur0 = DashboardComponent.startOfDay(this.rangeStart).getTime();
    const cur1 = DashboardComponent.endOfDay(this.rangeEnd).getTime();
    const n = DashboardComponent.inclusiveDayCount(this.rangeStart, this.rangeEnd);
    const prevEnd = new Date(DashboardComponent.startOfDay(this.rangeStart));
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - (n - 1));
    return {
      cur0,
      cur1,
      prev0: DashboardComponent.startOfDay(prevStart).getTime(),
      prev1: DashboardComponent.endOfDay(prevEnd).getTime(),
    };
  }

  private syncDraftFromRange(): void {
    this.draftStartStr = DashboardComponent.toYmd(this.rangeStart);
    this.draftEndStr = DashboardComponent.toYmd(this.rangeEnd);
  }

  private static defaultCalendarWeek(now: Date): { start: Date; end: Date } {
    const dow = now.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const start = new Date(now);
    start.setDate(now.getDate() + mondayOffset);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
  }

  private static startOfDay(d: Date): Date {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private static endOfDay(d: Date): Date {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  private static inclusiveDayCount(a: Date, b: Date): number {
    const t0 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const t1 = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.floor((t1 - t0) / 86400000) + 1;
  }

  private static toYmd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private static parseYmd(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const y = +m[1];
    const mo = +m[2] - 1;
    const d = +m[3];
    const dt = new Date(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
    return dt;
  }

  private formatCountDelta(recent: number, prev: number): TrendDelta | null {
    if (recent === 0 && prev === 0) return null;
    if (prev === 0) return { up: recent >= 0, pct: recent > 0 ? 100 : 0 };
    const raw = ((recent - prev) / prev) * 100;
    return { up: raw >= 0, pct: Math.min(999, Math.round(Math.abs(raw))) };
  }

  private renderChart(): void {
    if (!this.trendCanvas) return;
    const series = this.trendFilteredForChart;
    if (!series.length) {
      this.chart?.destroy();
      this.chart = undefined;
      return;
    }
    this.chart?.destroy();
    const labels = series.map((x) =>
      DashboardComponent.chartDayLabelFmt.format(new Date(x.started_at))
    );
    const data = series.map((x) => x.seo_score_avg);
    this.chart = new Chart(this.trendCanvas.nativeElement, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'SEO score (avg)',
            data,
            borderColor: '#4f8df7',
            backgroundColor: 'rgba(79, 141, 247, 0.14)',
            fill: true,
            tension: 0.32,
            borderWidth: 3,
            pointRadius: 3,
            pointHoverRadius: 4,
            pointBackgroundColor: '#4f8df7',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            align: 'center',
            labels: {
              color: '#4b5563',
              boxWidth: 32,
              boxHeight: 10,
              borderRadius: 4,
              padding: 16,
              font: { size: 12, family: 'Inter, system-ui, sans-serif', weight: 500 },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: '#8a98ab',
              font: { size: 10, family: 'Inter, system-ui, sans-serif' },
              maxTicksLimit: 8,
              maxRotation: 0,
              minRotation: 0,
            },
            grid: { color: 'rgba(148, 163, 184, 0.16)' },
            border: { color: 'rgba(148, 163, 184, 0.22)' },
          },
          y: {
            min: 0,
            max: 100,
            ticks: {
              stepSize: 10,
              color: '#8a98ab',
              font: { size: 10, family: 'Inter, system-ui, sans-serif' },
            },
            grid: { color: 'rgba(148, 163, 184, 0.16)' },
            border: { color: 'rgba(148, 163, 184, 0.22)' },
          },
        },
      },
    });
  }
}
