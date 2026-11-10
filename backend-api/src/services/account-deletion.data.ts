import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections } from './firestore.service';
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


export function deletionInconsistent(): never {
  throw new AppError(409, 'PROFILE_INCONSISTENT', 'Los documentos relacionados no permiten una eliminación segura.');
}
export function parseAccountDeletion(value: unknown): AccountDeletionDocument {
  const parsed = markerSchema.safeParse(value);
  if (!parsed.success) throw new AppError(409, 'ACCOUNT_DELETION_INCONSISTENT', 'El proceso existente requiere revisión.');
  return parsed.data;
}
export function assertOwnedReservation(snapshot: { exists: boolean; data(): unknown }, key: string, uid: string): boolean {
  if (!snapshot.exists) return false;
  const data = snapshot.data() as Record<string, unknown> | undefined;
  if (!data || data.uid !== uid || data.usernameKey !== key) return deletionInconsistent();
  return true;
}

// Shared by authorization and processing. No writes, no Authentication calls.
export async function readDeletionResources(tx: Transaction, firestore: Firestore, uid: string) {
  const { users, usernames } = getFirestoreCollections(firestore);
  const profileRef = users.doc(uid);
  const profile = await tx.get(profileRef);
  const owned = await tx.get(usernames.where('uid', '==', uid));
  const keys = new Set<string>();
  for (const reservation of owned.docs) {
    if (!keySchema.safeParse(reservation.id).success) return deletionInconsistent();
    assertOwnedReservation({ exists: true, data: () => reservation.data() }, reservation.id, uid);
    keys.add(reservation.id);
  }
  if (profile.exists) {
    const data = profile.data() as unknown as Record<string, unknown>;
    if ('uid' in data && data.uid !== uid) return deletionInconsistent();
    let key: string | undefined;
    if ('usernameKey' in data) {
      if (!keySchema.safeParse(data.usernameKey).success) return deletionInconsistent();
      key = data.usernameKey as string;
    }
    if ('username' in data) {
      if (typeof data.username !== 'string' || !/^[A-Za-z0-9_-]{8,30}$/.test(data.username)) return deletionInconsistent();
      const derived = data.username.toLowerCase();
      if (key && key !== derived) return deletionInconsistent();
      key = derived;
    }
    if (key && assertOwnedReservation(await tx.get(usernames.doc(key)), key, uid)) keys.add(key);
  }
  return { profileRef, profileExists: profile.exists, usernameKeys: [...keys].sort() };
}
