import { FieldPath, type CollectionReference, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { getFirestoreDb } from '../config/firebase';
import type { AccountDeletionDocument, MemberDocument, MessageDocument, RoomDocument, UserDocument, UsernameDocument } from './firestore.documents';

export function getFirestoreCollections(firestore: Firestore = getFirestoreDb()) {
  return {
    users: firestore.collection('users') as CollectionReference<UserDocument>,
    usernames: firestore.collection('usernames') as CollectionReference<UsernameDocument>,
    rooms: firestore.collection('rooms') as CollectionReference<RoomDocument>,
    accountDeletions: firestore.collection('accountDeletions') as CollectionReference<AccountDeletionDocument>,
  };
}

export function getRoomMembersCollection(roomId: string, firestore: Firestore = getFirestoreDb()) {
  return firestore.collection('rooms').doc(roomId).collection('members') as CollectionReference<MemberDocument>;
}

export function getRoomMessagesCollection(roomId: string, firestore: Firestore = getFirestoreDb()) {
  return firestore.collection('rooms').doc(roomId).collection('messages') as CollectionReference<MessageDocument>;
}

export async function checkFirestoreConnection(firestore: Firestore = getFirestoreDb()): Promise<void> {
  // La consulta solo comprueba conectividad y permisos; nunca devuelve documentos privados.
  await firestore.collection('users').select(FieldPath.documentId()).limit(1).get();
}
export async function getSprint0DemoDocument(
  firestore: Firestore = getFirestoreDb(),
): Promise<Record<string, unknown> | null> {
  const snapshot = await firestore.collection('sprint_prueba').doc('verificacion_sprint0').get();
  return snapshot.exists ? (snapshot.data() as Record<string, unknown>) : null;
}

// Tracks actual service work, including transactions after an HTTP disconnect.
let activeOperations = 0;
const idleWaiters = new Set<() => void>();
export function waitForFirestoreIdle(timeoutMs: number): Promise<boolean> {
  if (activeOperations === 0) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (idle: boolean) => { clearTimeout(timer); idleWaiters.delete(done); resolve(idle); };
    const done = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    idleWaiters.add(done);
  });
}
export async function withFirestore<T>(operation: (db: Firestore) => Promise<T>, db?: Firestore): Promise<T> {
  activeOperations++;
  try {
    return await operation(db ?? getFirestoreDb());
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (new Set<unknown>([4, 8, 10, 14, 'deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable']).has(code)) {
      throw new AppError(503, 'FIRESTORE_UNAVAILABLE', 'Firestore no está disponible.');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Ocurrió un error interno.');
  } finally {
    activeOperations--;
    if (activeOperations === 0) for (const done of [...idleWaiters]) done();
  }
}
