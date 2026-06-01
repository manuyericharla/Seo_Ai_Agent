import type { NextFunction, Response } from 'express';
import { isMultiTenantEnabled } from '../services/db.service';
import { verifyToken } from '../services/auth.service';
import { getCompanyConfig } from '../services/companyConfig.service';
import type { AuthRequest } from '../context/company.context';
import { companyContext } from '../context/company.context';
import { logger } from '../utils/logger';

function isDbConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    /connection terminated/i.test(err.message)
  );
}

const PUBLIC_PATHS = new Set([
  '/auth/signup',
  '/auth/login',
  '/auth/health',
]);

export function requireAuthToken(req: AuthRequest, res: Response, next: NextFunction): void {
  void (async () => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const auth = verifyToken(token);
    if (!auth) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    try {
      const settings = await getCompanyConfig(auth.companyId);
      req.auth = { ...auth, settings };
      companyContext.run(req.auth, () => next());
    } catch (err) {
      logger.error('Auth middleware DB error', { error: String(err) });
      const status = isDbConnectionError(err) ? 503 : 500;
      res.status(status).json({
        error:
          status === 503
            ? 'Database unavailable. Check PostgreSQL connectivity or set USE_SQLITE=true for local SQLite.'
            : 'Internal server error',
      });
    }
  })();
}

export function requireAuthUnlessPublic(req: AuthRequest, res: Response, next: NextFunction): void {
  void (async () => {
    if (!isMultiTenantEnabled()) {
      next();
      return;
    }

    const path = req.path.replace(/^\/+/, '');
    if (PUBLIC_PATHS.has(path) || path === '') {
      next();
      return;
    }

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const auth = verifyToken(token);
    if (!auth) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    try {
      const settings = await getCompanyConfig(auth.companyId);
      const store = { ...auth, settings };
      req.auth = store;
      companyContext.run(store, () => next());
    } catch (err) {
      logger.error('Auth middleware DB error', { error: String(err) });
      const status = isDbConnectionError(err) ? 503 : 500;
      res.status(status).json({
        error:
          status === 503
            ? 'Database unavailable. Check PostgreSQL connectivity or set USE_SQLITE=true for local SQLite.'
            : 'Internal server error',
      });
    }
  })();
}
