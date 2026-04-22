import cron from 'node-cron';
import { config } from '../config/config';
import { getDb, logActivity } from './db.service';
import { logger } from '../utils/logger';
import { createScanRecord, runScanPipeline } from './scanPipeline.service';
import { registerActiveScan, unregisterActiveScan } from './scanTaskRegistry.service';

let task: cron.ScheduledTask | null = null;

export function startScheduler(): void {
  const schedule = config.cronSchedule;
  if (task) task.stop();

  task = cron.schedule(
    schedule,
    async () => {
      logger.info('Scheduled scan started', { schedule });
      const rows = getDb().prepare('SELECT id, domain FROM domains').all() as { id: number; domain: string }[];
      for (const row of rows) {
        try {
          const created = createScanRecord(row.domain, true);
          const controller = registerActiveScan(created.scanId, created.domain);
          void runScanPipeline(
            created.domain,
            { schedulerRun: true, sendEmail: true, createGithubIssues: true },
            { scanId: created.scanId, abortSignal: controller.signal }
          )
            .catch((e) => {
              logger.error('Scheduled scan failed for domain', { domain: row.domain, error: String(e) });
              logActivity('error', `Scheduled scan failed: ${row.domain}`, created.scanId, { error: String(e) });
            })
            .finally(() => unregisterActiveScan(created.scanId));
        } catch (e) {
          logger.error('Scheduled scan failed for domain', { domain: row.domain, error: String(e) });
          logActivity('error', `Scheduled scan failed: ${row.domain}`, undefined, { error: String(e) });
        }
      }
      if (rows.length === 0) {
        logActivity('info', 'Scheduled scan: no domains registered');
      }
    },
    { timezone: process.env.TZ || 'UTC' }
  );

  logger.info('Scheduler registered', { schedule });
}

export function stopScheduler(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
