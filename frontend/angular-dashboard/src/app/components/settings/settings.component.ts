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

  readonly fields = [
    { key: 'OPENAI_API_KEY', label: 'OpenAI API key', type: 'password' },
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
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  save(): void {
    this.message = null;
    this.error = null;
    this.api.putSettings(this.form).subscribe({
      next: () => {
        this.message = 'Settings saved on the server (use environment variables in production).';
        this.load();
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }
}
