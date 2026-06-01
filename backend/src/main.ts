import fs from 'fs';
import type { Server } from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config/config';
import { initDb, recoverOrphanedRunningScans } from './services/db.service';
import { scanRouter } from './routes/scan.routes';
import { authRouter } from './routes/auth.routes';
import { requireAuthUnlessPublic } from './middleware/auth.middleware';
import { startDataRetentionScheduler } from './services/dataRetention.service';
import { startScheduler } from './services/scheduler.service';
import { failInFlightScansOnShutdown } from './services/scanTaskRegistry.service';
import { logger } from './utils/logger';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api', requireAuthUnlessPublic, scanRouter);

const clientDirCandidates = [
  path.join(__dirname, '..', 'frontend', 'angular-dashboard', 'dist', 'angular-dashboard', 'browser'),
  path.join(__dirname, '..', '..', 'frontend', 'angular-dashboard', 'dist', 'angular-dashboard', 'browser'),
];
const clientDir = clientDirCandidates.find((p) => fs.existsSync(p)) ?? clientDirCandidates[0];
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDir, 'index.html'), (err) => {
      if (err) next();
    });
  });
} else {
  logger.info('Angular build not found; API only mode', { clientDir });
}

let httpServer: Server | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Shutting down (${signal})…`);
  await failInFlightScansOnShutdown();
  await new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: String(reason) });
});

httpServer = app.listen(config.port, () => {
  logger.info(`SEO Agent API listening on port ${config.port}`);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${config.port} is already in use. Stop other Node processes (Task Manager / netstat) and run a single backend instance.`
    );
    process.exit(1);
  }
  throw err;
});

void initDb()
  .then(async () => {
    try {
      await recoverOrphanedRunningScans();
      startDataRetentionScheduler();
      startScheduler();
    } catch (err) {
      logger.error('Post-init startup failed', {
        error: String(err instanceof Error ? err.message : err),
      });
    }
  })
  .catch((err) => {
    logger.error('Database init failed — API /health up; DB routes may fail', {
      error: String(err instanceof Error ? err.message : err),
    });
  });
