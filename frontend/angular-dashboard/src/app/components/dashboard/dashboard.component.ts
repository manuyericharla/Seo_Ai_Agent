import {
  Component,
  OnDestroy,
  OnInit,
  AfterViewInit,
  ElementRef,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule, NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Chart, registerables } from 'chart.js';
import { ApiService, ActivityRow, DashboardStats, SeoTrendPoint } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';
import { Subscription } from 'rxjs';

Chart.register(...registerables);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, NgClass, RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  @ViewChild('trendCanvas') trendCanvas?: ElementRef<HTMLCanvasElement>;
  readonly activityPageSize = 10;

  stats: DashboardStats | null = null;
  activity: ActivityRow[] = [];
  trend: SeoTrendPoint[] = [];
  error: string | null = null;
  activityPage = 1;
  scheduledScans: Array<{
    domain: string;
    frequency: string;
    email: string;
    active: boolean;
  }> = [];
  private chart?: Chart;
  private sub = new Subscription();

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
          this.activityPage = 1;
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

  get activityPagesCount(): number {
    return Math.max(1, Math.ceil(this.activity.length / this.activityPageSize));
  }

  get pagedActivity(): ActivityRow[] {
    const start = (this.activityPage - 1) * this.activityPageSize;
    return this.activity.slice(start, start + this.activityPageSize);
  }

  get activityPageNumbers(): number[] {
    return Array.from({ length: this.activityPagesCount }, (_, idx) => idx + 1);
  }

  previousActivityPage(): void {
    this.activityPage = Math.max(1, this.activityPage - 1);
  }

  nextActivityPage(): void {
    this.activityPage = Math.min(this.activityPagesCount, this.activityPage + 1);
  }

  goToActivityPage(page: number): void {
    this.activityPage = Math.min(this.activityPagesCount, Math.max(1, page));
  }

  private renderChart(): void {
    if (!this.trendCanvas || !this.trend.length) return;
    this.chart?.destroy();
    const labels = this.trend.map((x) => new Date(x.started_at).toLocaleDateString());
    const data = this.trend.map((x) => x.seo_score_avg);
    this.chart = new Chart(this.trendCanvas.nativeElement, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'SEO score (avg)',
            data,
            borderColor: '#5eead4',
            backgroundColor: 'rgba(94, 234, 212, 0.15)',
            fill: true,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#e2e8f0' } } },
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.15)' } },
          y: {
            min: 0,
            max: 100,
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(148,163,184,0.15)' },
          },
        },
      },
    });
  }

}
