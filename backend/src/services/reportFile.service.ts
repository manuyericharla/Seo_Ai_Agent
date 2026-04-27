import fs from 'fs';
import path from 'path';
import { config } from '../config/config';
import type { CrawlPageResult, SeoPageReport } from '../models/scan.model';

function reportsDir(): string {
  return path.join(path.dirname(config.dbPath), 'reports');
}

export interface StoredScanReport {
  scanId: number;
  domain: string;
  generatedAt: string;
  pageReports: Record<string, SeoPageReport>;
  pages?: CrawlPageResult[];
}

export function saveScanReportFile(
  scanId: number,
  domain: string,
  pageReports: Record<string, SeoPageReport>,
  pages?: CrawlPageResult[]
): void {
  const dir = reportsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload: StoredScanReport = {
    scanId,
    domain,
    generatedAt: new Date().toISOString(),
    pageReports,
    pages,
  };
  fs.writeFileSync(path.join(dir, `${scanId}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

export function loadScanReportFile(scanId: number): StoredScanReport | null {
  const p = path.join(reportsDir(), `${scanId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StoredScanReport;
  } catch {
    return null;
  }
}
