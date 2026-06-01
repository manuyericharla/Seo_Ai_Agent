import cron from 'node-cron';
import { config } from '../config/config';
import { getDb, isMultiTenantEnabled } from './db.service';
import { deleteScanReportFile } from './reportFile.service';
import { logger } from '../utils/logger';

let retentionTask: cron.ScheduledTask | null = null;

export interface PurgeResult {
  scanIdsRemoved: number[];
  issuesDeleted: number;
  activityDeleted: number;
}

/**
 * Deletes scans (and issues, report JSON, linked activity) older than `retentionDays`.
 * Also deletes activity_log rows older than the cutoff (standalone / stale entries).
 */
export function purgeDataOlderThanDays(retentionDays: number): PurgeResult {
  if (retentionDays <= 0) {
    return { scanIdsRemoved: [], issuesDeleted: 0, activityDeleted: 0 };
  }

  const db = getDb();
  const modifier = `-${retentionDays} days`;
  const scanRows = db
    .prepare(`SELECT id FROM scans WHERE started_at < datetime('now', ?)`)
    .all(modifier) as { id: number }[];

  const scanIdsRemoved = scanRows.map((r) => r.id);
  if (scanIdsRemoved.length === 0) {
    const activityOnly = db
      .prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', ?)`)
      .run(modifier);
    return { scanIdsRemoved: [], issuesDeleted: 0, activityDeleted: activityOnly.changes };
  }

  const placeholders = scanIdsRemoved.map(() => '?').join(',');
  const idArgs = scanIdsRemoved as unknown as (string | number)[];

  const tx = db.transaction(() => {
    const issuesDeleted = db.prepare(`DELETE FROM issues WHERE scan_id IN (${placeholders})`).run(...idArgs).changes;
    const activityForScans = db.prepare(`DELETE FROM activity_log WHERE scan_id IN (${placeholders})`).run(...idArgs)
      .changes;
    db.prepare(`DELETE FROM scans WHERE id IN (${placeholders})`).run(...idArgs);
    const activityByDate = db
      .prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', ?)`)
      .run(modifier).changes;
    return { issuesDeleted, activityDeleted: activityForScans + activityByDate };
  });

  const { issuesDeleted, activityDeleted } = tx();

  for (const id of scanIdsRemoved) {
    deleteScanReportFile(id);
  }

  return { scanIdsRemoved, issuesDeleted, activityDeleted };
}

export function startDataRetentionScheduler(): void {
  const days = config.dataRetentionDays;
  if (days <= 0) {
    logger.info('Data retention disabled (DATA_RETENTION_DAYS=0)');
    return;
  }
  if (isMultiTenantEnabled()) {
    logger.info('Data retention purge skipped in PostgreSQL mode (SQLite-only helper)');
    return;
  }

  try {
    const first = purgeDataOlderThanDays(days);
    if (first.scanIdsRemoved.length > 0 || first.activityDeleted > 0) {
      logger.info('Data retention purge on startup', {
        retentionDays: days,
        scansRemoved: first.scanIdsRemoved.length,
        issuesDeleted: first.issuesDeleted,
        activityRowsDeleted: first.activityDeleted,
      });
    }
  } catch (e) {
    logger.error('Data retention startup purge failed', { error: String(e) });
  }

  if (retentionTask) retentionTask.stop();
  retentionTask = cron.schedule(
    config.dataRetentionCron,
    () => {
      try {
        const r = purgeDataOlderThanDays(days);
        if (r.scanIdsRemoved.length > 0 || r.activityDeleted > 0) {
          logger.info('Data retention scheduled purge', {
            scansRemoved: r.scanIdsRemoved.length,
            issuesDeleted: r.issuesDeleted,
            activityRowsDeleted: r.activityDeleted,
          });
        }
      } catch (e) {
        logger.error('Data retention scheduled purge failed', { error: String(e) });
      }
    },
    { timezone: process.env.TZ || 'UTC' }
  );

  logger.info('Data retention scheduler registered', {
    retentionDays: days,
    cron: config.dataRetentionCron,
  });
}

export function stopDataRetentionScheduler(): void {
  if (retentionTask) {
    retentionTask.stop();
    retentionTask = null;
  }
}
