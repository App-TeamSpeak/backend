import type { Auth } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getFirebaseAuth } from '../config/firebase';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, getRoomMembersCollection, getRoomMessagesCollection, withFirestore } from './firestore.service';
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

async function deleteOwnedRooms(firestore: Firestore, uid: string): Promise<void> {
  const { rooms } = getFirestoreCollections(firestore);
  const ownedRooms = await rooms.where('ownerId', '==', uid).get();
  for (const roomDoc of ownedRooms.docs) {
    const roomId = roomDoc.id;
    const [members, messages] = await Promise.all([
      getRoomMembersCollection(roomId, firestore).get(),
      getRoomMessagesCollection(roomId, firestore).get(),
    ]);
    const batch = firestore.batch();
    batch.delete(roomDoc.ref);
    members.docs.forEach((doc) => batch.delete(doc.ref));
    messages.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export async function deleteAccountImmediately(
  uid: string,
  db?: Firestore,
  auth?: Auth,
): Promise<{ status: 'deleted' }> {
  return withFirestore(async (firestore) => {
    const { accountDeletions, usernames, users } = getFirestoreCollections(firestore);
    const markerRef = accountDeletions.doc(uid);
    const existingMarker = await markerRef.get();
    if (existingMarker.exists) {
      const parsed = parseAccountDeletion(existingMarker.data());
      if (parsed.status === 'blocked') throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'El proceso de eliminación está bloqueado.');
      if (parsed.status === 'completed') throw new AppError(409, 'ACCOUNT_DELETED', 'La cuenta ya fue eliminada.');
    }

    await deleteOwnedRooms(firestore, uid);

    let firebaseAuth: Auth;
    try {
      firebaseAuth = auth ?? getFirebaseAuth();
    } catch {
      throw new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está disponible.');
    }
    try {
      await firebaseAuth.deleteUser(uid);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== 'auth/user-not-found') {
        if (new Set<unknown>(['app/network-error', 'app/network-timeout', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/quota-exceeded']).has(code)) {
          throw new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está disponible.');
        }
        throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo eliminar la cuenta en Authentication.');
      }
    }

    await firestore.runTransaction(async (tx) => {
      const [profileSnap, ownedUsernames, markerSnap] = await Promise.all([
        tx.get(users.doc(uid)),
        tx.get(usernames.where('uid', '==', uid)),
        tx.get(markerRef),
      ]);
      const now = Timestamp.now();
      const previous = markerSnap.exists ? parseAccountDeletion(markerSnap.data()) : undefined;
      if (profileSnap.exists) tx.delete(users.doc(uid));
      for (const reservation of ownedUsernames.docs) tx.delete(reservation.ref);
      const completed: AccountDeletionDocument = {
        status: 'completed',
        phase: 'done',
        usernameKeys: [],
        attempts: previous ? previous.attempts + 1 : 1,
        requestedAt: previous?.requestedAt ?? now,
        updatedAt: now,
        completedAt: now,
      };
      tx.set(markerRef, completed);
    });

    return { status: 'deleted' };
  }, db);
}
