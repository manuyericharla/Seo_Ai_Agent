import fs from 'fs';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config/config';
import { getDb } from './services/db.service';
import { scanRouter } from './routes/scan.routes';
import { startScheduler } from './services/scheduler.service';
import { logger } from './utils/logger';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api', scanRouter);

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

getDb();

app.listen(config.port, () => {
  logger.info(`SEO Agent API listening on port ${config.port}`);
  startScheduler();
});
