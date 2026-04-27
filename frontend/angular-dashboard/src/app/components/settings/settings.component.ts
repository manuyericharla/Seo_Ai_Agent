import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);

  form: Record<string, string> = {};
  message: string | null = null;
  error: string | null = null;
  googleTestUrl = 'https://example.com';
  googleTestResult: string | null = null;
  googleTestStatus: 'good' | 'needs' | 'poor' | null = null;
  googleTestRunning = false;
  liveSerpRankEnabled = false;

  readonly fields = [
    { key: 'OPENAI_API_KEY', label: 'OpenAI API key', type: 'password' },
    { key: 'GOOGLE_API_KEY', label: 'Google API key (PageSpeed)', type: 'password' },
    { key: 'SERPAPI_KEY', label: 'SerpAPI key (live rank)', type: 'password' },
    { key: 'GITHUB_TOKEN', label: 'GitHub token', type: 'password' },
    { key: 'GITHUB_REPO_OWNER', label: 'GitHub repository owner', type: 'text' },
    { key: 'GITHUB_REPO_NAME', label: 'GitHub repository name', type: 'text' },
    { key: 'GITHUB_DEFAULT_BRANCH', label: 'GitHub default branch', type: 'text' },
    { key: 'GITHUB_CONTENT_ROOT_FOLDER', label: 'GitHub content root folder', type: 'text' },
    { key: 'GITHUB_FILE_EXTENSION', label: 'GitHub file extension', type: 'text' },
    { key: 'CLAUDE_INSTANCE_ID', label: 'Claude instance ID', type: 'text' },
    { key: 'CLAUDE_PR_ENDPOINT', label: 'Claude PR endpoint URL', type: 'text' },
    { key: 'EMAIL_HOST', label: 'SMTP host', type: 'text' },
    { key: 'EMAIL_PORT', label: 'SMTP port', type: 'text' },
    { key: 'EMAIL_USER', label: 'SMTP user', type: 'text' },
    { key: 'EMAIL_PASS', label: 'SMTP password', type: 'password' },
    { key: 'EMAIL_FROM', label: 'From address', type: 'text' },
    { key: 'REPORT_EMAIL_TO', label: 'Default report recipient', type: 'text' },
  ];

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.getSettings().subscribe({
      next: (s) => {
        this.form = { ...s };
        this.liveSerpRankEnabled = String(this.form['ENABLE_LIVE_SERP_RANK'] || '')
          .toLowerCase()
          .trim() === 'true';
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  save(): void {
    this.message = null;
    this.error = null;
    this.form['ENABLE_LIVE_SERP_RANK'] = this.liveSerpRankEnabled ? 'true' : 'false';
    this.api.putSettings(this.form).subscribe({
      next: () => {
        this.message = 'Settings saved on the server (use environment variables in production).';
        this.load();
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  testGooglePageSpeed(): void {
    this.googleTestResult = null;
    this.googleTestStatus = null;
    this.error = null;
    this.googleTestRunning = true;
    this.api.testGooglePageSpeed(this.googleTestUrl).subscribe({
      next: (r) => {
        this.googleTestRunning = false;
        if (!r.ok) {
          this.googleTestStatus = 'poor';
          this.googleTestResult = r.error || 'Google PageSpeed test failed.';
          return;
        }
        const m = r.metrics || {};
        const perf = Number(m['lighthousePerformanceScore'] ?? 0);
        this.googleTestStatus = perf >= 90 ? 'good' : perf >= 50 ? 'needs' : 'poor';
        this.googleTestResult =
          `OK - ${r.url || this.googleTestUrl} | ` +
          `LCP: ${m['lcpMs'] ?? 'n/a'} ms, ` +
          `FCP: ${m['fcpMs'] ?? 'n/a'} ms, ` +
          `INP: ${m['inpMs'] ?? 'n/a'} ms, ` +
          `CLS: ${m['cls'] ?? 'n/a'}, ` +
          `Perf score: ${m['lighthousePerformanceScore'] ?? 'n/a'}`;
      },
      error: (e) => {
        this.googleTestRunning = false;
        this.googleTestStatus = 'poor';
        this.googleTestResult = httpErrorMessage(e);
      },
    });
  }
}
