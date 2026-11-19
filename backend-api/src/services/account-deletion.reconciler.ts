import type { Auth } from 'firebase-admin/auth';
import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { withDeletionEmulatorClients } from '../config/deletion-emulator-clients';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { getFirebaseAuth, getFirestoreDb } from '../config/firebase';
import { AppError } from '../middleware/errors';
import { parseAccountDeletion } from './account-deletion.data';
import { processAccountDeletion } from './account-deletion.processor';
import { runAccountDeletionWithLease } from './account-deletion.service';

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
  db?: Firestore;
  auth?: Auth;
}
export interface ReconciliationResult { read: number; eligible: number; processed: number; failed: number; malformed: number }
const emptyResult = (): ReconciliationResult => ({ read: 0, eligible: 0, processed: 0, failed: 0, malformed: 0 });
const testEnabledFlag = 'TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS';
const runtimeEnabledFlag = 'TEAMSPEAK_ENABLE_DELETION_RECONCILER';
const safeCode = (error: unknown) => error instanceof AppError ? error.code : 'INTERNAL_ERROR';

function parseBoolFlag(name: string): boolean {
  const value = process.env[name];
  if (value && value !== 'true' && value !== 'false') {
    throw new AppError(400, 'RECONCILER_CONFIG_INVALID', 'Habilitación de conciliación inválida.');
  }
  return value === 'true';
}

// No timers or SDK work at import.
export function createAccountDeletionReconciler(options: ReconcilerOptions = {}) {
  const testMode = parseBoolFlag(testEnabledFlag);
  const runtimeMode = parseBoolFlag(runtimeEnabledFlag);
  if (testMode && runtimeMode) {
    throw new AppError(400, 'RECONCILER_CONFIG_INVALID', 'No se pueden activar simultáneamente los modos de prueba y producción del conciliador.');
  }
  const enabled = testMode || runtimeMode;
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
  const assertRuntimeProjectSafe = (firestore?: Firestore, auth?: Auth) => {
    const expected = process.env.FIREBASE_EXPECTED_PROJECT_ID?.trim();
    const configured = process.env.FIREBASE_PROJECT_ID?.trim();
    if (process.env.NODE_ENV === 'production') {
      if (!expected || expected === deletionTestProject || configured !== expected) {
        throw new AppError(501, 'NOT_IMPLEMENTED', 'Proyecto Firebase esperado inválido o ausente para el conciliador.');
      }
      if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
        throw new AppError(501, 'NOT_IMPLEMENTED', 'El conciliador productivo no admite emuladores locales.');
      }
    } else if (expected && configured && configured !== expected) {
      throw new AppError(501, 'NOT_IMPLEMENTED', 'FIREBASE_PROJECT_ID no coincide con FIREBASE_EXPECTED_PROJECT_ID.');
    }
    const authProject = auth?.app?.options?.projectId;
    const dbProject = firestore && 'projectId' in firestore ? (firestore as { projectId?: unknown }).projectId : undefined;
    if (expected && authProject && authProject !== expected) {
      throw new AppError(501, 'NOT_IMPLEMENTED', 'El cliente Auth del conciliador apunta a un proyecto incorrecto.');
    }
    if (expected && typeof dbProject === 'string' && dbProject !== expected) {
      throw new AppError(501, 'NOT_IMPLEMENTED', 'El cliente Firestore del conciliador apunta a un proyecto incorrecto.');
    }
    if (authProject && typeof dbProject === 'string' && authProject !== dbProject) {
      throw new AppError(501, 'NOT_IMPLEMENTED', 'Auth y Firestore del conciliador apuntan a proyectos distintos.');
    }
  };
  const assertSafe = () => {
    if (testMode) {
      assertDeletionTestEnvironment();
      if (process.env[testEnabledFlag] !== 'true' || hosts[0] !== process.env.FIRESTORE_EMULATOR_HOST || hosts[1] !== process.env.FIREBASE_AUTH_EMULATOR_HOST) {
        throw new AppError(501, 'NOT_IMPLEMENTED', 'El aislamiento del conciliador cambió.');
      }
      return;
    }
    if (runtimeMode) {
      if (process.env[runtimeEnabledFlag] !== 'true') {
        throw new AppError(501, 'NOT_IMPLEMENTED', 'La configuración del conciliador cambió.');
      }
      assertRuntimeProjectSafe();
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

  async function processScope(
    firestore: Firestore,
    processUid: (uid: string) => Promise<unknown>,
    assertClientsSafe: () => void,
  ): Promise<ReconciliationResult> {
    const result = emptyResult();
    const instant = now();
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
        if (marker.status !== 'pending') continue;
        if (marker.nextAttemptAt && marker.nextAttemptAt.toMillis() > instant.toMillis()) continue;
        if (marker.leaseOwner && marker.leaseExpiresAt && marker.leaseExpiresAt.toMillis() > instant.toMillis()) continue;
        result.eligible++;
        try {
          assertSafe();
          await processUid(document.id);
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
    return result;
  }

  async function discoverAndProcess(): Promise<ReconciliationResult> {
    assertSafe();
    if (testMode) {
      let result = emptyResult();
      await withDeletionEmulatorClients(async ({ firestore, assertSafe: assertClientsSafe }) => {
        result = await processScope(firestore, (uid) => processAccountDeletion(uid), assertClientsSafe);
      });
      return result;
    }
    const firestore = options.db ?? getFirestoreDb();
    const auth = options.auth ?? getFirebaseAuth();
    assertRuntimeProjectSafe(firestore, auth);
    return processScope(firestore, (uid) => runAccountDeletionWithLease(uid, firestore, auth, now), () => assertRuntimeProjectSafe(firestore, auth));
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
