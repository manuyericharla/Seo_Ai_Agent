import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';

interface SchedulerRule {
  domain: string;
  frequency: '1 day' | '1 week' | '1 month';
  email: string;
  active: boolean;
  createdAt: string;
}

@Component({
  selector: 'app-automatic-scheduler',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './automatic-scheduler.component.html',
  styleUrl: './automatic-scheduler.component.scss',
})
export class AutomaticSchedulerComponent implements OnInit {
  private readonly api = inject(ApiService);
  private schedulerRules: SchedulerRule[] = [];

  schedulerFrequency: '1 day' | '1 week' | '1 month' = '1 week';
  schedulerDomain = 'www.example.com';
  schedulerEmail = 'you@company.com';
  schedulerSaving = false;
  schedulerMessage: string | null = null;
  schedulerError: string | null = null;
  scheduledScans: Array<{
    domain: string;
    frequency: string;
    email: string;
    lastRun: string | null;
    nextRun: string | null;
    active: boolean;
  }> = [];

  ngOnInit(): void {
    this.loadSchedulerSettings();
  }

  saveScheduler(): void {
    this.schedulerError = null;
    this.schedulerMessage = null;
    const domain = this.schedulerDomain.trim();
    const email = this.schedulerEmail.trim();
    if (!domain) {
      this.schedulerError = 'Domain is required.';
      return;
    }
    if (!email) {
      this.schedulerError = 'Email is required.';
      return;
    }

    this.schedulerSaving = true;
    const existingIndex = this.schedulerRules.findIndex((row) => row.domain.toLowerCase() === domain.toLowerCase());
    const nextRule: SchedulerRule = {
      domain,
      frequency: this.schedulerFrequency,
      email,
      active: true,
      createdAt: existingIndex >= 0 ? this.schedulerRules[existingIndex].createdAt : new Date().toISOString(),
    };
    const nextRules = [...this.schedulerRules];
    if (existingIndex >= 0) nextRules[existingIndex] = nextRule;
    else nextRules.unshift(nextRule);

    this.api
      .putSettings({
        'scheduler.enabled': 'true',
        'scheduler.frequency': this.schedulerFrequency,
        'scheduler.domain': domain,
        'scheduler.email': email,
        'scheduler.rules': JSON.stringify(nextRules),
      })
      .subscribe({
        next: () => {
          this.schedulerSaving = false;
          this.schedulerRules = nextRules;
          this.schedulerMessage = 'Automatic scheduler saved.';
          this.refreshScheduledScans();
        },
        error: (e) => {
          this.schedulerSaving = false;
          this.schedulerError = httpErrorMessage(e);
        },
      });
  }

  markInactive(domain: string): void {
    this.schedulerMessage = null;
    this.schedulerError = null;
    const nextRules = this.schedulerRules.map((row) =>
      row.domain.toLowerCase() === domain.toLowerCase() ? { ...row, active: false } : row
    );
    this.schedulerSaving = true;
    this.api
      .putSettings({
        'scheduler.rules': JSON.stringify(nextRules),
      })
      .subscribe({
        next: () => {
          this.schedulerSaving = false;
          this.schedulerRules = nextRules;
          this.schedulerMessage = `Marked ${domain} as inactive.`;
          this.refreshScheduledScans();
        },
        error: (e) => {
          this.schedulerSaving = false;
          this.schedulerError = httpErrorMessage(e);
        },
      });
  }

  markActive(domain: string): void {
    this.schedulerMessage = null;
    this.schedulerError = null;
    const nextRules = this.schedulerRules.map((row) =>
      row.domain.toLowerCase() === domain.toLowerCase() ? { ...row, active: true } : row
    );
    this.schedulerSaving = true;
    this.api
      .putSettings({
        'scheduler.rules': JSON.stringify(nextRules),
      })
      .subscribe({
        next: () => {
          this.schedulerSaving = false;
          this.schedulerRules = nextRules;
          this.schedulerMessage = `Marked ${domain} as active.`;
          this.refreshScheduledScans();
        },
        error: (e) => {
          this.schedulerSaving = false;
          this.schedulerError = httpErrorMessage(e);
        },
      });
  }

  private loadSchedulerSettings(): void {
    this.api.getSettings().subscribe({
      next: (settings) => {
        const savedFrequency = settings['scheduler.frequency'];
        const savedDomain = settings['scheduler.domain'];
        const savedEmail = settings['scheduler.email'];
        const savedRules = settings['scheduler.rules'];

        if (savedFrequency === '1 day' || savedFrequency === '1 week' || savedFrequency === '1 month') {
          this.schedulerFrequency = savedFrequency;
        }
        if (savedDomain) this.schedulerDomain = savedDomain;
        if (savedEmail) this.schedulerEmail = savedEmail;

        if (savedRules) {
          try {
            const parsed = JSON.parse(savedRules) as SchedulerRule[];
            if (Array.isArray(parsed)) this.schedulerRules = parsed;
          } catch {
            this.schedulerRules = [];
          }
        }

        this.refreshScheduledScans();
      },
      error: (e) => {
        this.schedulerError = httpErrorMessage(e);
      },
    });
  }

  private refreshScheduledScans(): void {
    this.scheduledScans = this.schedulerRules.map((row) => ({
      domain: row.domain,
      frequency: row.frequency,
      email: row.email,
      lastRun: null,
      nextRun: this.computeNextRun(new Date().toISOString(), row.frequency),
      active: row.active,
    }));
  }

  private computeNextRun(baseTime: string, frequency: '1 day' | '1 week' | '1 month'): string | null {
    const d = new Date(baseTime);
    if (Number.isNaN(d.getTime())) return null;
    if (frequency === '1 day') d.setDate(d.getDate() + 1);
    else if (frequency === '1 week') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    return d.toISOString();
  }
}
