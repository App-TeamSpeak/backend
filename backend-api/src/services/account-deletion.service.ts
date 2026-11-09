import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, withFirestore } from './firestore.service';
import type { AccountDeletionDocument } from './firestore.documents';

const keySchema = z.string().min(8).max(30).regex(/^[a-z0-9_-]+$/);
const markerSchema = z.object({
  status: z.enum(['pending', 'blocked', 'completed']), phase: z.enum(['auth', 'firestore', 'done']),
  usernameKeys: z.array(keySchema).refine((keys) => new Set(keys).size === keys.length),
  requestedAt: z.instanceof(Timestamp), updatedAt: z.instanceof(Timestamp),
  attempts: z.number().int().nonnegative(), completedAt: z.instanceof(Timestamp).optional(),
  nextAttemptAt: z.instanceof(Timestamp).optional(), lastErrorCode: z.string().optional(),
}).refine((data) => data.status === 'completed'
  ? data.phase === 'done' && data.completedAt !== undefined
  : data.phase !== 'done' && data.completedAt === undefined);

function inconsistent(): never {
  throw new AppError(409, 'PROFILE_INCONSISTENT', 'No se puede registrar la eliminación con los datos actuales.');
}
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
    const { users, usernames, accountDeletions } = getFirestoreCollections(firestore);
    return firestore.runTransaction(async (tx) => {
      const markerRef = accountDeletions.doc(identity.uid);
      const existing = await tx.get(markerRef);
      if (existing.exists) {
        const parsed = markerSchema.safeParse(existing.data());
        if (!parsed.success) throw new AppError(409, 'ACCOUNT_DELETION_INCONSISTENT', 'El proceso existente requiere revisión.');
        if (parsed.data.status === 'blocked') throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'El proceso existente está bloqueado.');
        if (parsed.data.status === 'completed') throw new AppError(409, 'ACCOUNT_DELETED', 'Existe un proceso de eliminación completado.');
        // Repetition never rewrites progress or trusts a recorded foreign reservation.
        for (const key of parsed.data.usernameKeys) {
          const reservation = await tx.get(usernames.doc(key));
          if (reservation.exists && (reservation.data()?.uid !== identity.uid || reservation.data()?.usernameKey !== key)) return inconsistent();
          if (!reservation.exists && parsed.data.phase === 'auth') return inconsistent();
        }
        return { status: 'pending' as const };
      }
      requireRecent(identity.authTime);
      const profileSnapshot = await tx.get(users.doc(identity.uid));
      const owned = await tx.get(usernames.where('uid', '==', identity.uid));
      const keys = new Set<string>();
      for (const reservation of owned.docs) {
        const data = reservation.data();
        if (!keySchema.safeParse(reservation.id).success || data.usernameKey !== reservation.id || data.uid !== identity.uid) return inconsistent();
        keys.add(reservation.id);
      }
      if (profileSnapshot.exists) {
        const profile = profileSnapshot.data() as unknown as Record<string, unknown>;
        if ('uid' in profile && profile.uid !== identity.uid) return inconsistent();
        let key: string | undefined;
        if ('usernameKey' in profile) {
          if (!keySchema.safeParse(profile.usernameKey).success) return inconsistent();
          key = profile.usernameKey as string;
        }
        if ('username' in profile) {
          if (typeof profile.username !== 'string' || !/^[A-Za-z0-9_-]{8,30}$/.test(profile.username)) return inconsistent();
          const derived = profile.username.toLowerCase();
          if (key && key !== derived) return inconsistent();
          key = derived;
        }
        if (key) {
          const reservation = await tx.get(usernames.doc(key));
          if (reservation.exists) {
            if (reservation.data()?.uid !== identity.uid || reservation.data()?.usernameKey !== key) return inconsistent();
            keys.add(key);
          }
          // A missing reservation is not fabricated; only verified owned documents are recorded.
        }
      }
      const now = Timestamp.now();
      const marker: AccountDeletionDocument = { status: 'pending', phase: 'auth', usernameKeys: [...keys].sort(), requestedAt: now, updatedAt: now, attempts: 0 };
      tx.create(markerRef, marker);
      return { status: 'pending' as const };
    });
  }, db);
}
