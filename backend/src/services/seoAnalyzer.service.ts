import { config } from '../config/config';
import { CrawlPageResult, SeoIssue } from '../models/scan.model';

export function analyzePages(pages: CrawlPageResult[]): SeoIssue[] {
  const issues: SeoIssue[] = [];

  for (const p of pages) {
    if (!p.title || p.title.trim().length === 0) {
      issues.push({
        type: 'missing_title',
        pageUrl: p.url,
        message: 'Missing page title',
      });
    }

    if (!p.metaDescription || p.metaDescription.trim().length === 0) {
      issues.push({
        type: 'missing_meta_description',
        pageUrl: p.url,
        message: 'Missing meta description',
      });
    }

    if (p.h1Count > 1) {
      issues.push({
        type: 'multiple_h1',
        pageUrl: p.url,
        message: `Multiple H1 headings detected (${p.h1Count})`,
        details: 'Use a single H1 per page for clearer topical focus.',
      });
    }

    if (p.h1Count === 0 && p.title) {
      issues.push({
        type: 'multiple_h1',
        pageUrl: p.url,
        message: 'No H1 heading on page',
        details: 'Add one descriptive H1 that matches the page intent.',
      });
    }

    for (const bl of p.brokenLinks) {
      issues.push({
        type: 'broken_links',
        pageUrl: p.url,
        message: `Broken or unreachable link: ${bl}`,
        details: bl,
      });
    }

    for (const inv of p.invalidNavLinks || []) {
      issues.push({
        type: 'invalid_or_nonfunctional_link',
        pageUrl: p.url,
        message: `Non-functional or placeholder link (${inv.reason}): ${inv.href}`,
        details: inv.context ? `Context: ${inv.context}` : undefined,
      });
    }

    if (p.imagesWithoutAlt > 0) {
      issues.push({
        type: 'images_without_alt',
        pageUrl: p.url,
        message: `${p.imagesWithoutAlt} image(s) missing ALT text`,
      });
    }

    if (p.loadTimeMs > config.slowPageMs) {
      issues.push({
        type: 'slow_page',
        pageUrl: p.url,
        message: `Slow page load (~${p.loadTimeMs}ms)`,
        details: `Threshold: ${config.slowPageMs}ms`,
      });
    }
  }

  return issues;
}
