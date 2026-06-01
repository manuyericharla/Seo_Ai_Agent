import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { loadAppSettings } from './appsettings';

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

function num(v: string | undefined, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parses .NET-style strings: Server=host;Port=6432;Database=SEOAgent;User Id=u;Password=p; */
function parseDotNetPgConnectionString(raw: string): string {
  const parts: Record<string, string> = {};
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const value = segment.slice(eq + 1).trim();
    parts[key] = value;
  }
  const host = parts.server || parts.host || parts['data source'] || '';
  const port = parts.port || '5432';
  const database = parts.database || parts['initial catalog'] || '';
  const user = parts['user id'] || parts.userid || parts.username || parts.user || '';
  const password = parts.password || '';
  if (!host || !database || !user) return '';
  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);
  return `postgresql://${encUser}:${encPass}@${host}:${port}/${database}`;
}

function resolveDatabaseUrl(appSettings: ReturnType<typeof loadAppSettings>): string {
  if (String(process.env.USE_SQLITE || '').toLowerCase() === 'true') return '';
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const hiperbrains =
    process.env.HIPERBRAINS_DATABASE?.trim() ||
    process.env.DATABASE_CONNECTION_STRING?.trim() ||
    appSettings.hiperbrainsDatabase;
  if (hiperbrains) return parseDotNetPgConnectionString(hiperbrains);
  return '';
}

const appSettings = loadAppSettings();

export const config = {
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  /** Always from appsettings.json ConnectionStrings — not stored in company_configs DB. */
  openaiConnection: appSettings.openaiConnection,
  googleConnection: appSettings.googleConnection,
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || '',
  email: {
    host: process.env.EMAIL_HOST || '',
    port: num(process.env.EMAIL_PORT, 587),
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || '',
  },
  cronSchedule: process.env.CRON_SCHEDULE || '0 9 * * *',
  /** Max pages per crawl; `0` = auto (crawl all discoverable same-origin pages, up to maxDiscoverablePages). */
  maxPagesPerScan: num(process.env.MAX_PAGES_PER_SCAN, 0),
  crawlWorkers: Math.max(10, Math.min(20, num(process.env.CRAWL_WORKERS, 12))),
  crawlMaxDepth: Math.max(1, num(process.env.CRAWL_MAX_DEPTH, 4)),
  crawlTimeoutMs: Math.max(3000, num(process.env.CRAWL_TIMEOUT_MS, 12000)),
  brokenLinkCheckCap: Math.max(50, num(process.env.BROKEN_LINK_CHECK_CAP, 200)),
  maxDiscoverablePages: Math.max(100, num(process.env.MAX_DISCOVERABLE_PAGES, 500)),
  scanTimeBudgetMs: Math.max(60000, num(process.env.SCAN_TIME_BUDGET_MS, 300000)),
  /** Hard cap for entire background scan job (crawl + AI + email). */
  scanPipelineMaxMs: Math.max(120000, num(process.env.SCAN_PIPELINE_MAX_MS, 480000)),
  slowPageMs: num(process.env.SLOW_PAGE_MS, 3000),
  enablePageSpeed: String(process.env.ENABLE_PAGESPEED || 'true').toLowerCase() === 'true',
  pageSpeedPagesLimit: Math.max(0, num(process.env.PAGESPEED_PAGES_LIMIT, 5)),
  pageSpeedStrategy: (process.env.PAGESPEED_STRATEGY || 'mobile').toLowerCase() === 'desktop' ? 'desktop' : 'mobile',
  pageSpeedTimeoutMs: Math.max(5000, num(process.env.PAGESPEED_TIMEOUT_MS, 15000)),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'seo-agent.db'),
  /** PostgreSQL connection string — enables multi-tenant auth + company-scoped data (public schema). */
  databaseUrl: resolveDatabaseUrl(appSettings),
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production-seo-agent',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  /** Keep scans/issues/reports/activity newer than this many days; `0` disables automatic purge. */
  dataRetentionDays: num(process.env.DATA_RETENTION_DAYS, 7),
  /** When to run retention purge (cron). Default 03:00 UTC daily. */
  dataRetentionCron: process.env.DATA_RETENTION_CRON || '0 3 * * *',
};
