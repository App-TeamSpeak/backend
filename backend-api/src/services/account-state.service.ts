import { readAuthorizationDocument } from './authorization-read.service';
import type { Firestore } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, withFirestore } from './firestore.service';

// Existence is authoritative. Unknown/malformed states also deny access.
export function assertNoAccountDeletion(snapshot: { exists: boolean; data(): unknown }): void {
  if (!snapshot.exists) return;
  const data = snapshot.data();
  const status = typeof data === 'object' && data !== null && 'status' in data ? data.status : undefined;
  const code = status === 'completed' ? 'ACCOUNT_DELETED'
    : status === 'blocked' ? 'ACCOUNT_DELETION_BLOCKED' : 'ACCOUNT_DELETION_PENDING';
  throw new AppError(403, code, 'La cuenta no puede acceder a recursos privados debido a su proceso de eliminación.');
}

export async function ensureAccountActive(uid: string, db?: Firestore): Promise<void> {
  await withFirestore(async (firestore) => {
    assertNoAccountDeletion(await readAuthorizationDocument(getFirestoreCollections(firestore).accountDeletions.doc(uid)));
  }, db);
}
