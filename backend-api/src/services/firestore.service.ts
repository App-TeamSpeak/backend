import { FieldPath, type CollectionReference, type Firestore } from 'firebase-admin/firestore';
import { getFirestoreDb } from '../config/firebase';
import type { MemberDocument, MessageDocument, RoomDocument, UserDocument, UsernameDocument } from './firestore.documents';

export function getFirestoreCollections(firestore: Firestore = getFirestoreDb()) {
  return {
    users: firestore.collection('users') as CollectionReference<UserDocument>,
    usernames: firestore.collection('usernames') as CollectionReference<UsernameDocument>,
    rooms: firestore.collection('rooms') as CollectionReference<RoomDocument>,
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
