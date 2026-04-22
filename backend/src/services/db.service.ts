import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config/config';
import { logger } from '../utils/logger';

let db: Database.Database | null = null;

function ensureDataDir(): void {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getDb(): Database.Database {
  if (db) return db;
  ensureDataDir();
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  migrate();
  return db;
}

function migrate(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      FOREIGN KEY (scan_id) REFERENCES scans(id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      scan_id INTEGER,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta TEXT,
      FOREIGN KEY (scan_id) REFERENCES scans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(domain_id);
    CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);
  `);
  ensureColumn(d, 'issues', 'seo_score', 'REAL');
  ensureColumn(d, 'issues', 'code_snippet', 'TEXT');
  ensureColumn(d, 'issues', 'code_diff', 'TEXT');
  ensureColumn(d, 'issues', 'github_pr_url', 'TEXT');
  ensureColumn(d, 'issues', 'github_pr_branch', 'TEXT');
  ensureColumn(d, 'scans', 'claude_pr_url', 'TEXT');
  ensureColumn(d, 'scans', 'claude_pr_created_at', 'TEXT');
  ensureColumn(d, 'scans', 'claude_pr_email_sent_at', 'TEXT');
  ensureColumn(d, 'scans', 'claude_pr_email_error', 'TEXT');
}

function ensureColumn(d: Database.Database, tableName: string, columnName: string, columnDefinition: string): void {
  const cols = d.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (cols.some((col) => col.name === columnName)) return;
  d.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value);
}

export function logActivity(
  level: 'info' | 'warn' | 'error',
  message: string,
  scanId?: number,
  meta?: Record<string, unknown>
): void {
  try {
    getDb()
      .prepare('INSERT INTO activity_log (scan_id, level, message, meta) VALUES (?, ?, ?, ?)')
      .run(scanId ?? null, level, message, meta ? JSON.stringify(meta) : null);
  } catch (e) {
    logger.error('activity_log insert failed', { error: String(e) });
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
