import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
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

export const config = {
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || process.env.GoogleAPIKey || '',
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
  /** Max pages per crawl; `0` = no limit (all discoverable same-origin URLs via links). */
  maxPagesPerScan: num(process.env.MAX_PAGES_PER_SCAN, 25),
  crawlWorkers: Math.max(10, Math.min(20, num(process.env.CRAWL_WORKERS, 12))),
  crawlMaxDepth: Math.max(1, num(process.env.CRAWL_MAX_DEPTH, 4)),
  crawlTimeoutMs: Math.max(3000, num(process.env.CRAWL_TIMEOUT_MS, 12000)),
  brokenLinkCheckCap: Math.max(50, num(process.env.BROKEN_LINK_CHECK_CAP, 200)),
  maxDiscoverablePages: Math.max(100, num(process.env.MAX_DISCOVERABLE_PAGES, 500)),
  scanTimeBudgetMs: Math.max(60000, num(process.env.SCAN_TIME_BUDGET_MS, 300000)),
  slowPageMs: num(process.env.SLOW_PAGE_MS, 3000),
  enablePageSpeed: String(process.env.ENABLE_PAGESPEED || 'true').toLowerCase() === 'true',
  pageSpeedPagesLimit: Math.max(0, num(process.env.PAGESPEED_PAGES_LIMIT, 5)),
  pageSpeedStrategy: (process.env.PAGESPEED_STRATEGY || 'mobile').toLowerCase() === 'desktop' ? 'desktop' : 'mobile',
  pageSpeedTimeoutMs: Math.max(5000, num(process.env.PAGESPEED_TIMEOUT_MS, 15000)),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'seo-agent.db'),
};
