import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Pool, type QueryResultRow } from 'pg';
import { config } from '../config/config';
import { logger } from '../utils/logger';
import { toPgPlaceholders } from '../database/sql';

export type DbDriver = 'sqlite' | 'postgres';

let driver: DbDriver = 'sqlite';
let sqliteDb: Database.Database | null = null;
let pgPool: Pool | null = null;
let initPromise: Promise<void> | null = null;

function ensureDataDir(): void {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getDriver(): DbDriver {
  return driver;
}

export function isMultiTenantEnabled(): boolean {
  return driver === 'postgres';
}

export async function initDb(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (config.databaseUrl) {
      try {
        driver = 'postgres';
        pgPool = new Pool({
          connectionString: config.databaseUrl,
          connectionTimeoutMillis: 15_000,
          idleTimeoutMillis: 30_000,
        });
        pgPool.on('error', (err) => {
          logger.error('PostgreSQL pool error', { error: String(err) });
        });
        await migratePostgres();
        logger.info('Database: PostgreSQL (multi-tenant)');
        return;
      } catch (err) {
        logger.warn('PostgreSQL init failed; falling back to SQLite', {
          error: String(err instanceof Error ? err.message : err),
        });
        if (pgPool) {
          await pgPool.end().catch(() => undefined);
          pgPool = null;
        }
        driver = 'sqlite';
      }
    }
    ensureDataDir();
    sqliteDb = new Database(config.dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    migrateSqlite();
    logger.info('Database: SQLite (single-tenant legacy)');
  })();
  return initPromise;
}

/** Legacy sync accessor — SQLite only. */
export function getDb(): Database.Database {
  if (driver !== 'sqlite' || !sqliteDb) {
    throw new Error('getDb() is only available in SQLite mode. Use async db helpers with PostgreSQL.');
  }
  return sqliteDb;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  await initDb();
  if (driver === 'postgres') {
    const r = await pgPool!.query<T>(toPgPlaceholders(sql), params);
    return r.rows;
  }
  return getDb().prepare(sql).all(...params) as T[];
}

export async function dbQueryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await dbQuery<T>(sql, params);
  return rows[0];
}

export async function dbAll<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return dbQuery<T>(sql, params);
}

export async function dbGet<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  return dbQueryOne<T>(sql, params);
}

export async function dbExecute(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertId?: number }> {
  await initDb();
  if (driver === 'postgres') {
    let pgSql = toPgPlaceholders(sql);
    const trimmed = pgSql.trim();
    if (/^INSERT\s/i.test(trimmed) && !/\bRETURNING\b/i.test(trimmed)) {
      pgSql = `${trimmed.replace(/;\s*$/, '')} RETURNING id`;
    }
    const r = await pgPool!.query(pgSql, params);
    const lastInsertId = r.rows[0]?.id != null ? Number((r.rows[0] as { id: number }).id) : undefined;
    return { changes: r.rowCount ?? 0, lastInsertId };
  }
  const info = getDb().prepare(sql).run(...params);
  return { changes: info.changes, lastInsertId: Number(info.lastInsertRowid) };
}

function migrateSqlite(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS company_configs (
      company_id INTEGER PRIMARY KEY,
      settings TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      domain TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      pages_count INTEGER NOT NULL DEFAULT 0,
      seo_score_avg REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      email_sent INTEGER NOT NULL DEFAULT 0,
      email_sent_at TEXT,
      email_error TEXT,
      github_issues_created INTEGER NOT NULL DEFAULT 0,
      scheduler_run INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (domain_id) REFERENCES domains(id)
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      page_url TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      message TEXT NOT NULL,
      ai_suggestion TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      github_issue_url TEXT,
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      scan_id INTEGER,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE SET NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(domain_id);
    CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);
  `);
  ensureSqliteColumn(d, 'issues', 'seo_score', 'REAL');
  ensureSqliteColumn(d, 'issues', 'code_snippet', 'TEXT');
  ensureSqliteColumn(d, 'issues', 'code_diff', 'TEXT');
  ensureSqliteColumn(d, 'issues', 'github_pr_url', 'TEXT');
  ensureSqliteColumn(d, 'issues', 'github_pr_branch', 'TEXT');
  ensureSqliteColumn(d, 'scans', 'claude_pr_url', 'TEXT');
  ensureSqliteColumn(d, 'scans', 'claude_pr_created_at', 'TEXT');
  ensureSqliteColumn(d, 'scans', 'claude_pr_email_sent_at', 'TEXT');
  ensureSqliteColumn(d, 'scans', 'claude_pr_email_error', 'TEXT');
  ensureSqliteColumn(d, 'domains', 'company_id', 'INTEGER REFERENCES companies(id)');
  ensureSqliteColumn(d, 'activity_log', 'company_id', 'INTEGER');
  try {
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_company_domain ON domains(company_id, domain)`);
  } catch {
    // legacy rows may block unique index until cleaned
  }
}

function ensureSqliteColumn(d: Database.Database, tableName: string, columnName: string, columnDefinition: string): void {
  const cols = d.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (cols.some((col) => col.name === columnName)) return;
  d.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

async function migratePostgres(): Promise<void> {
  await pgPool!.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL DEFAULT '',
      last_name VARCHAR(100) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS company_configs (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS domains (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      domain VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_company_domain ON domains(company_id, domain);
    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      pages_count INTEGER NOT NULL DEFAULT 0,
      seo_score_avg REAL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
      email_sent_at TIMESTAMPTZ,
      email_error TEXT,
      github_issues_created INTEGER NOT NULL DEFAULT 0,
      scheduler_run BOOLEAN NOT NULL DEFAULT FALSE,
      claude_pr_url TEXT,
      claude_pr_created_at TIMESTAMPTZ,
      claude_pr_email_sent_at TIMESTAMPTZ,
      claude_pr_email_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(domain_id);
    CREATE TABLE IF NOT EXISTS issues (
      id SERIAL PRIMARY KEY,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      issue_type VARCHAR(128) NOT NULL,
      message TEXT NOT NULL,
      ai_suggestion TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'open',
      github_issue_url TEXT,
      seo_score REAL,
      code_snippet TEXT,
      code_diff TEXT,
      github_pr_url TEXT,
      github_pr_branch TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      scan_id INTEGER REFERENCES scans(id) ON DELETE SET NULL,
      level VARCHAR(16) NOT NULL,
      message TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// --- Company config JSON ---

export function getCompanyConfigJson(companyId: number): Record<string, string> {
  if (driver === 'postgres') {
    throw new Error('Use getCompanyConfigJsonAsync for PostgreSQL');
  }
  const row = getDb()
    .prepare('SELECT settings FROM company_configs WHERE company_id = ?')
    .get(companyId) as { settings: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.settings) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function getCompanyConfigJsonAsync(companyId: number): Promise<Record<string, string>> {
  await initDb();
  if (driver === 'sqlite') return getCompanyConfigJson(companyId);
  const row = await dbQueryOne<{ settings: Record<string, unknown> }>(
    'SELECT settings FROM company_configs WHERE company_id = ?',
    [companyId]
  );
  if (!row?.settings) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.settings)) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

export function setCompanyConfigJson(companyId: number, settings: Record<string, string>): void {
  if (driver === 'postgres') {
    throw new Error('Use setCompanyConfigJsonAsync for PostgreSQL');
  }
  const json = JSON.stringify(settings);
  getDb()
    .prepare(
      `INSERT INTO company_configs (company_id, settings, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(company_id) DO UPDATE SET settings = excluded.settings, updated_at = datetime('now')`
    )
    .run(companyId, json);
}

export async function setCompanyConfigJsonAsync(companyId: number, settings: Record<string, string>): Promise<void> {
  await initDb();
  if (driver === 'sqlite') {
    setCompanyConfigJson(companyId, settings);
    return;
  }
  await dbExecute(
    `INSERT INTO company_configs (company_id, settings, updated_at) VALUES (?, ?::jsonb, NOW())
     ON CONFLICT (company_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [companyId, JSON.stringify(settings)]
  );
}

/** Legacy global settings table — not used in PostgreSQL multi-tenant mode (use company_configs). */
export function getLegacySetting(key: string): string | null {
  if (driver === 'postgres') return null;
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setLegacySetting(key: string, value: string): void {
  if (driver === 'postgres') return; // per-company: company_configs.settings JSONB
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value);
}

/** @deprecated Use company config or getActiveSetting from companyConfig.service */
export function getSetting(key: string): string | null {
  return getLegacySetting(key);
}

/** @deprecated Use company config */
export function setSetting(key: string, value: string): void {
  setLegacySetting(key, value);
}

export function logActivity(
  level: 'info' | 'warn' | 'error',
  message: string,
  scanId?: number,
  meta?: Record<string, unknown>,
  companyId?: number
): void {
  try {
    const cid = companyId;
    if (driver === 'sqlite') {
      getDb()
        .prepare('INSERT INTO activity_log (company_id, scan_id, level, message, meta) VALUES (?, ?, ?, ?, ?)')
        .run(cid ?? null, scanId ?? null, level, message, meta ? JSON.stringify(meta) : null);
      return;
    }
    void logActivityAsync(level, message, scanId, meta, cid);
  } catch (e) {
    logger.error('activity_log insert failed', { error: String(e) });
  }
}

export async function logActivityAsync(
  level: 'info' | 'warn' | 'error',
  message: string,
  scanId?: number,
  meta?: Record<string, unknown>,
  companyId?: number
): Promise<void> {
  try {
    await initDb();
    if (driver === 'sqlite') {
      logActivity(level, message, scanId, meta, companyId);
      return;
    }
    await dbExecute(
      'INSERT INTO activity_log (company_id, scan_id, level, message, meta) VALUES (?, ?, ?, ?, ?::jsonb)',
      [companyId ?? null, scanId ?? null, level, message, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    logger.error('activity_log insert failed', { error: String(e) });
  }
}

export async function scanBelongsToCompany(scanId: number, companyId: number): Promise<boolean> {
  const row = await dbQueryOne<{ id: number }>(
    `SELECT s.id FROM scans s
     JOIN domains d ON d.id = s.domain_id
     WHERE s.id = ? AND d.company_id = ?`,
    [scanId, companyId]
  );
  return !!row;
}

const ORPHAN_SCAN_MSG =
  'Scan interrupted (server restarted or worker stopped). Delete or re-run this scan.';

/** Marks all `running` scans as failed — use on cold start when no workers are alive. */
export async function recoverOrphanedRunningScans(): Promise<number> {
  await initDb();
  const now = driver === 'postgres' ? 'NOW()' : "datetime('now')";
  const r = await dbExecute(
    `UPDATE scans SET status = 'failed', completed_at = ${now}, email_error = ? WHERE status = 'running'`,
    [ORPHAN_SCAN_MSG]
  );
  if (r.changes > 0) {
    logger.info('Recovered orphaned running scans', { count: r.changes });
  }
  return r.changes;
}

/** Fails `running` scans with no in-memory worker (e.g. tsx restart failed to recover on boot). */
export async function recoverStaleRunningScans(
  activeScanIds: number[],
  staleAfterMs = 120_000
): Promise<number> {
  await initDb();
  const active = new Set(activeScanIds);
  const rows = await dbAll<{ id: number; started_at: string }>(
    `SELECT id, started_at FROM scans WHERE status = 'running'`
  );
  const now = driver === 'postgres' ? 'NOW()' : "datetime('now')";
  let count = 0;
  const cutoff = Date.now() - staleAfterMs;
  for (const row of rows) {
    if (active.has(row.id)) continue;
    const started = new Date(row.started_at).getTime();
    if (!Number.isFinite(started) || started > cutoff) continue;
    await dbExecute(
      `UPDATE scans SET status = 'failed', completed_at = ${now}, email_error = ? WHERE id = ? AND status = 'running'`,
      [ORPHAN_SCAN_MSG, row.id]
    );
    count++;
  }
  if (count > 0) {
    logger.info('Recovered stale running scans', { count });
  }
  return count;
}

export async function deleteScanById(scanId: number, companyId: number): Promise<boolean> {
  const ok = await scanBelongsToCompany(scanId, companyId);
  if (!ok) return false;
  await dbExecute('DELETE FROM issues WHERE scan_id = ?', [scanId]);
  await dbExecute('DELETE FROM activity_log WHERE scan_id = ?', [scanId]);
  const r = await dbExecute('DELETE FROM scans WHERE id = ?', [scanId]);
  return r.changes > 0;
}

export function closeDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  if (pgPool) {
    void pgPool.end();
    pgPool = null;
  }
  initPromise = null;
}
