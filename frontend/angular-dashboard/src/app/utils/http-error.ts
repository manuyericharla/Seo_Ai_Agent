import { HttpErrorResponse } from '@angular/common/http';

/** Turns HttpClient errors into readable text (avoids "[object Object]"). */
export function httpErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error;
    if (body && typeof body === 'object') {
      const o = body as { error?: unknown; message?: unknown };
      if (typeof o.error === 'string') return o.error;
      if (typeof o.message === 'string') return o.message;
    }
    if (typeof body === 'string') return body;
    return err.message || `HTTP ${err.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
