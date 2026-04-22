type Level = 'info' | 'warn' | 'error' | 'debug';

function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const line = meta ? `${ts} [${level.toUpperCase()}] ${message} ${JSON.stringify(meta)}` : `${ts} [${level.toUpperCase()}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
  debug: (m: string, meta?: Record<string, unknown>) => log('debug', m, meta),
};
