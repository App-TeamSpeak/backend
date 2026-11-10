import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { withDeletionEmulatorClients } from '../config/deletion-emulator-clients';
import { assertDeletionTestEnvironment } from '../config/deletion-test';
import { AppError } from '../middleware/errors';
import { parseAccountDeletion } from './account-deletion.data';
import { processAccountDeletion } from './account-deletion.processor';

const settingsSchema = z.object({
  intervalMs: z.number().int().min(1000).max(300000).default(30000),
  batchSize: z.number().int().min(1).max(100).default(10),
  pageSize: z.number().int().min(1).max(100).default(25),
  scanLimit: z.number().int().min(1).max(1000).default(100),
  concurrency: z.literal(1).default(1),
});
export interface ReconcilerOptions {
  intervalMs?: number; batchSize?: number; pageSize?: number; scanLimit?: number; concurrency?: 1;
  now?: () => Timestamp;
}
export interface ReconciliationResult { read: number; eligible: number; processed: number; failed: number; malformed: number }
const emptyResult = (): ReconciliationResult => ({ read: 0, eligible: 0, processed: 0, failed: 0, malformed: 0 });
const enabledFlag = 'TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS';
const safeCode = (error: unknown) => error instanceof AppError ? error.code : 'INTERNAL_ERROR';

// No timers or SDK work at import. Real clients always come from the scoped emulator factory.
export function createAccountDeletionReconciler(options: ReconcilerOptions = {}) {
  const flag = process.env[enabledFlag];
  if (flag && flag !== 'true' && flag !== 'false') throw new AppError(400, 'RECONCILER_CONFIG_INVALID', 'Habilitación de conciliación inválida.');
  const enabled = flag === 'true';
  const environment: Record<string, number> = {};
  if (enabled) {
    for (const [key, name] of Object.entries({ intervalMs: 'INTERVAL_MS', batchSize: 'BATCH_SIZE', pageSize: 'PAGE_SIZE', scanLimit: 'SCAN_LIMIT', concurrency: 'CONCURRENCY' })) {
      const value = process.env[`TEAMSPEAK_DELETION_RECONCILER_${name}`];
      if (value !== undefined) environment[key] = Number(value);
    }
  }
  const parsed = settingsSchema.safeParse({ ...environment, ...options });
  if (!parsed.success) throw new AppError(400, 'RECONCILER_CONFIG_INVALID', 'Límites de conciliación inválidos.');
  const settings = parsed.data;
  const now = options.now ?? Timestamp.now;
  const hosts = [process.env.FIRESTORE_EMULATOR_HOST, process.env.FIREBASE_AUTH_EMULATOR_HOST];
  const assertSafe = () => {
    assertDeletionTestEnvironment();
    if (process.env[enabledFlag] !== 'true' || hosts[0] !== process.env.FIRESTORE_EMULATOR_HOST || hosts[1] !== process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new AppError(501, 'NOT_IMPLEMENTED', 'El aislamiento del conciliador cambió.');
    }
  };
  if (enabled) assertSafe();
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<ReconciliationResult> | undefined;
  let starting: Promise<void> | undefined;
  let cursor: string | undefined;
  let lastResult: ReconciliationResult | undefined;
  let lastErrorCode: string | undefined;
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const report = (event: string, error: unknown) => console.error({ event, code: safeCode(error) });

  async function discoverAndProcess(): Promise<ReconciliationResult> {
    assertSafe();
    const result = emptyResult();
    const instant = now();
    await withDeletionEmulatorClients(async ({ firestore, assertSafe: assertClientsSafe }) => {
      while (!stopped && result.read < settings.scanLimit && result.eligible < settings.batchSize) {
        assertSafe(); assertClientsSafe();
        const limit = Math.min(settings.pageSize, settings.scanLimit - result.read);
        let query = firestore.collection('accountDeletions').where('status', '==', 'pending').orderBy(FieldPath.documentId()).limit(limit);
        if (cursor) query = query.startAfter(cursor);
        let page;
        try { page = await query.get(); }
        catch (error) {
          if (error instanceof AppError && error.statusCode === 501) throw error;
          throw new AppError(503, 'RECONCILER_QUERY_FAILED', 'No se pudo consultar el trabajo pendiente.');
        }
        result.read += page.size;
        for (const document of page.docs) {
          if (stopped || result.eligible >= settings.batchSize) break;
          assertSafe(); assertClientsSafe();
          cursor = document.id;
          let marker;
          try { marker = parseAccountDeletion(document.data()); }
          catch (error) { result.malformed++; report('deletion_reconciler_invalid_marker', error); continue; }
          if (marker.status !== 'pending' || (marker.nextAttemptAt && marker.nextAttemptAt.toMillis() > instant.toMillis())) continue;
          result.eligible++;
          try {
            assertSafe();
            await processAccountDeletion(document.id);
            result.processed++;
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 501) throw error;
            result.failed++;
            report('deletion_reconciler_account_failed', error);
          }
        }
        if (stopped || result.eligible >= settings.batchSize) break;
        if (page.size < limit) { cursor = undefined; break; }
      }
    });
    return result;
  }
  function runOnce(): Promise<ReconciliationResult> {
    if (!enabled || stopped) return Promise.resolve(emptyResult());
    if (inFlight) return inFlight;
    inFlight = discoverAndProcess().then((result) => { lastResult = result; lastErrorCode = undefined; return result; }).catch((error: unknown) => {
      lastErrorCode = safeCode(error);
      if (error instanceof AppError && error.statusCode === 501) { stopped = true; cancelTimer(); }
      report('deletion_reconciler_pass_failed', error);
      throw error;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  function schedule() {
    if (!enabled || stopped) return;
    try { assertSafe(); }
    catch (error) {
      stopped = true; lastErrorCode = safeCode(error);
      report('deletion_reconciler_schedule_failed', error);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().catch(() => undefined).finally(schedule);
    }, settings.intervalMs);
    timer.unref();
  }
  function start(): Promise<void> {
    if (!enabled || stopped) return Promise.resolve();
    if (starting) return starting;
    started = true;
    starting = runOnce().catch((error: unknown) => {
      if (error instanceof AppError && error.statusCode === 501) throw error;
    }).then(() => { schedule(); });
    return starting;
  }
  async function stop(): Promise<void> {
    stopped = true; cancelTimer();
    await inFlight?.catch(() => undefined);
  }
  return { start, runOnce, stop, getState: () => ({ enabled, started, stopped, running: !!inFlight, scheduled: !!timer, cursor, lastErrorCode, lastResult: lastResult ? { ...lastResult } : undefined, settings: { ...settings } }) };
}
