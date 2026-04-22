import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, DomainRow } from '../../services/api.service';
import { httpErrorMessage } from '../../utils/http-error';

@Component({
  selector: 'app-domain-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './domain-management.component.html',
  styleUrl: './domain-management.component.scss',
})
export class DomainManagementComponent implements OnInit {
  private readonly api = inject(ApiService);

  domains: DomainRow[] = [];
  newDomain = '';
  scanDomain = '';
  emailTo = '';
  createGithub = false;
  launching = false;
  message: string | null = null;
  error: string | null = null;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.getDomains().subscribe({
      next: (d) => (this.domains = d),
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  add(): void {
    if (!this.newDomain.trim()) return;
    this.error = null;
    this.api.postDomain(this.newDomain.trim()).subscribe({
      next: () => {
        this.newDomain = '';
        this.load();
        this.message = 'Domain added.';
      },
      error: (e) => (this.error = httpErrorMessage(e)),
    });
  }

  scan(): void {
    if (!this.scanDomain.trim()) return;
    this.launching = true;
    this.message = null;
    this.error = null;
    this.api
      .postScan({
        domain: this.scanDomain.trim(),
        emailTo: this.emailTo.trim() || undefined,
        createGithubIssues: this.createGithub,
      })
      .subscribe({
        next: (r) => {
          this.launching = false;
          this.message = `Scan started for ${r.domain} (ID ${r.scanId}). You can start another scan now.`;
        },
        error: (e) => {
          this.launching = false;
          this.error = httpErrorMessage(e);
        },
      });
  }
}
