import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, withFirestore } from './firestore.service';
import { parseAccountDeletion, readDeletionResources, assertOwnedReservation, deletionInconsistent } from './account-deletion.data';
import type { AccountDeletionDocument } from './firestore.documents';

function requireRecent(authTime: unknown): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0 || authTime > now || now - authTime > 300) {
    throw new AppError(401, 'AUTH_RECENT_REQUIRED', 'Vuelve a autenticarte antes de solicitar la eliminación.');
  }
}

export async function beginAccountDeletion(identity: { uid: string; authTime?: number }, db?: Firestore) {
  assertDeletionTestEnvironment();
  return withFirestore(async (firestore) => {
    if (!('projectId' in firestore) || firestore.projectId !== deletionTestProject) throw new AppError(501, 'NOT_IMPLEMENTED', 'Proyecto de pruebas incorrecto.');
    const { usernames, accountDeletions } = getFirestoreCollections(firestore);
    return firestore.runTransaction(async (tx) => {
      const markerRef = accountDeletions.doc(identity.uid);
      const existing = await tx.get(markerRef);
      if (existing.exists) {
        const parsed = parseAccountDeletion(existing.data());
        if (parsed.status === 'blocked') throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'El proceso existente está bloqueado.');
        if (parsed.status === 'completed') throw new AppError(409, 'ACCOUNT_DELETED', 'Existe un proceso de eliminación completado.');
        // Repetition never rewrites progress or trusts a recorded foreign reservation.
        for (const key of parsed.usernameKeys) {
          const reservation = await tx.get(usernames.doc(key));
          const owned = assertOwnedReservation(reservation, key, identity.uid);
          if (!owned && parsed.phase === 'auth') return deletionInconsistent();
        }
        return { status: 'pending' as const };
      }
      requireRecent(identity.authTime);
      const resources = await readDeletionResources(tx, firestore, identity.uid);
      const now = Timestamp.now();
      const marker: AccountDeletionDocument = { status: 'pending', phase: 'auth', usernameKeys: resources.usernameKeys, requestedAt: now, updatedAt: now, attempts: 0 };
      tx.create(markerRef, marker);
      return { status: 'pending' as const };
    });
  }, db);
}
