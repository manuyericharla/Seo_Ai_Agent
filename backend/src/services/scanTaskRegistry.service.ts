type ActiveScanTask = {
  scanId: number;
  domain: string;
  controller: AbortController;
  startedAt: string;
};

const activeScans = new Map<number, ActiveScanTask>();

export function registerActiveScan(scanId: number, domain: string): AbortController {
  const existing = activeScans.get(scanId);
  if (existing) return existing.controller;
  const controller = new AbortController();
  activeScans.set(scanId, {
    scanId,
    domain,
    controller,
    startedAt: new Date().toISOString(),
  });
  return controller;
}

export function getActiveScan(scanId: number): ActiveScanTask | undefined {
  return activeScans.get(scanId);
}

export function unregisterActiveScan(scanId: number): void {
  activeScans.delete(scanId);
}

export function stopActiveScan(scanId: number): boolean {
  const task = activeScans.get(scanId);
  if (!task) return false;
  task.controller.abort(new Error('Scan aborted by user'));
  return true;
}
