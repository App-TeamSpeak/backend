import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { withDeletionEmulatorClients } from '../config/deletion-emulator-clients';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, withFirestore } from './firestore.service';
import { assertOwnedReservation, deletionInconsistent, parseAccountDeletion, readDeletionResources } from './account-deletion.data';
import type { AccountDeletionDocument } from './firestore.documents';

// Local injection points for fixtures/fault tests; never supplied by an HTTP endpoint.
export interface DeletionProcessorOptions {
  beforeAuthDelete?: () => Promise<void>;
  now?: () => Timestamp;
  afterAuthDeleted?: () => Promise<void>;
  beforePhaseCommit?: () => void;
  beforeCleanupCommit?: () => void;
  afterCleanupCommitted?: () => Promise<void>;
}
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}
function failure(error: unknown): { permanent: boolean; code: string } {
  const code = errorCode(error);
  if (error instanceof AppError && error.code === 'PROFILE_INCONSISTENT') return { permanent: true, code: error.code };
  if (code === 'FIRESTORE_UNAVAILABLE') return { permanent: false, code };
  if (code === 'FIRESTORE_PERMISSION_DENIED') return { permanent: true, code };
  if (['auth/insufficient-permission', 'auth/invalid-uid', 'auth/invalid-argument'].includes(code as string)) return { permanent: true, code: 'AUTH_CONFIGURATION_ERROR' };
  if ([7, 'permission-denied'].includes(code as never)) return { permanent: true, code: 'FIRESTORE_PERMISSION_DENIED' };
  if ([4, 8, 10, 14, 'deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable'].includes(code as never)) return { permanent: false, code: 'FIRESTORE_UNAVAILABLE' };
  if (['app/network-error', 'app/network-timeout', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/quota-exceeded'].includes(code as string)) return { permanent: false, code: 'AUTH_UNAVAILABLE' };
  // Unknown outcomes are never treated as proof that a destructive step did not happen.
  return { permanent: false, code: 'INTERNAL_ERROR' };
}
function withoutRetry(marker: AccountDeletionDocument) {
  const { nextAttemptAt: _next, lastErrorCode: _error, ...rest } = marker;
  return rest;
}

export async function processAccountDeletion(uid: string, options: DeletionProcessorOptions = {}): Promise<AccountDeletionDocument> {
  assertDeletionTestEnvironment();
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) throw new AppError(400, 'VALIDATION_ERROR', 'UID interno no válido.');
  const allowed = ['now', 'beforeAuthDelete', 'afterAuthDeleted', 'beforePhaseCommit', 'beforeCleanupCommit', 'afterCleanupCommitted'];
  if (Object.keys(options).some((key) => !allowed.includes(key))) throw new AppError(501, 'NOT_IMPLEMENTED', 'No se admiten clientes SDK externos.');
  return withDeletionEmulatorClients(async ({ firestore, auth, assertSafe }) => {
  const now = options.now ?? Timestamp.now;
  const guard = () => {
    assertSafe();
    if (!('projectId' in firestore) || firestore.projectId !== deletionTestProject || auth.app.options.projectId !== deletionTestProject) {
      throw new AppError(501, 'NOT_IMPLEMENTED', 'Procesador disponible solo con instancias del proyecto demo.');
    }
  };
  guard();
  const { accountDeletions, usernames } = getFirestoreCollections(firestore);
  const markerRef = accountDeletions.doc(uid);
  async function readMarker(tx: Transaction) {
    const snapshot = await tx.get(markerRef);
    if (!snapshot.exists) throw new AppError(404, 'ACCOUNT_DELETION_NOT_FOUND', 'No existe una intención de eliminación.');
    return parseAccountDeletion(snapshot.data());
  }
  async function resources(tx: Transaction, marker: AccountDeletionDocument) {
    const current = await readDeletionResources(tx, firestore, uid);
    if (current.usernameKeys.some((key) => !marker.usernameKeys.includes(key))) return deletionInconsistent();
    for (const key of marker.usernameKeys) assertOwnedReservation(await tx.get(usernames.doc(key)), key, uid);
    return current;
  }
  const transaction = <T>(fn: (tx: Transaction) => Promise<T>) => {
    guard();
    return withFirestore(async (db) => {
      try { return await db.runTransaction(async (tx) => { guard(); return fn(tx); }); }
      catch (error) {
        if ([7, 'permission-denied'].includes(errorCode(error) as never)) throw new AppError(403, 'FIRESTORE_PERMISSION_DENIED', 'Permisos insuficientes para procesar la eliminación.');
        throw error;
      }
    }, firestore);
  };
  const admitted = await transaction(async (tx) => {
    const current = await readMarker(tx);
    if (current.status !== 'pending' || (current.nextAttemptAt && current.nextAttemptAt.toMillis() > now().toMillis())) return { marker: current, run: false };
    if (current.attempts === Number.MAX_SAFE_INTEGER) throw new AppError(409, 'ACCOUNT_DELETION_INCONSISTENT', 'Contador de intentos inválido.');
    const updated = { ...current, attempts: current.attempts + 1, updatedAt: now() };
    try { await resources(tx, current); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'PROFILE_INCONSISTENT') throw error;
      const blocked: AccountDeletionDocument = { ...withoutRetry(updated), status: 'blocked', lastErrorCode: error.code };
      tx.set(markerRef, blocked);
      return { marker: blocked, run: false };
    }
    tx.set(markerRef, updated);
    return { marker: updated, run: true };
  });
  if (!admitted.run) return admitted.marker;
  const attempt = admitted.marker.attempts;
  let expectedPhase = admitted.marker.phase;
  try {
    if (expectedPhase === 'auth') {
      await options.beforeAuthDelete?.();
      guard();
      try { await auth.deleteUser(uid); }
      catch (error) { if (errorCode(error) !== 'auth/user-not-found') throw error; }
      await options.afterAuthDeleted?.();
      const advanced = await transaction(async (tx) => {
        const current = await readMarker(tx);
        if (current.status !== 'pending' || current.phase !== 'auth') return current;
        const updated: AccountDeletionDocument = { ...withoutRetry(current), phase: 'firestore', updatedAt: now() };
        tx.set(markerRef, updated);
        options.beforePhaseCommit?.();
        return updated;
      });
      if (advanced.status !== 'pending') return advanced;
      expectedPhase = advanced.phase;
    }
    const result = await transaction(async (tx) => {
      const current = await readMarker(tx);
      if (current.status !== 'pending' || current.phase !== 'firestore') return current;
      let owned;
      try { owned = await resources(tx, current); }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== 'PROFILE_INCONSISTENT') throw error;
        const blocked: AccountDeletionDocument = { ...withoutRetry(current), status: 'blocked', lastErrorCode: error.code, updatedAt: now() };
        tx.set(markerRef, blocked);
        return blocked;
      }
      const completedAt = now();
      const completed: AccountDeletionDocument = {
        status: 'completed', phase: 'done', usernameKeys: [], attempts: current.attempts,
        requestedAt: current.requestedAt, updatedAt: completedAt, completedAt,
      };
      if (owned.profileExists) tx.delete(owned.profileRef);
      for (const key of owned.usernameKeys) tx.delete(usernames.doc(key));
      tx.set(markerRef, completed);
      options.beforeCleanupCommit?.();
      return completed;
    });
    await options.afterCleanupCommitted?.();
    return result;
  } catch (error) {
    if (error instanceof AppError && (error.statusCode === 501 || error.code === 'ACCOUNT_DELETION_INCONSISTENT' || error.code === 'ACCOUNT_DELETION_NOT_FOUND')) throw error;
    const classified = failure(error);
    return transaction(async (tx) => {
      const current = await readMarker(tx);
      // A stale failure must not overwrite another executor's progress or completion.
      if (current.status !== 'pending' || current.phase !== expectedPhase || current.attempts !== attempt) return current;
      const updated: AccountDeletionDocument = {
        ...withoutRetry(current), status: classified.permanent ? 'blocked' : 'pending',
        lastErrorCode: classified.code, updatedAt: now(),
        ...(classified.permanent ? {} : { nextAttemptAt: Timestamp.fromMillis(now().toMillis() + Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7)) * 1000) }),
      };
      tx.set(markerRef, updated);
      return updated;
    });
  }
  });
}
