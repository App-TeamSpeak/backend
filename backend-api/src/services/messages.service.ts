import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { getRoomMembersCollection, getRoomMessagesCollection, withFirestore } from './firestore.service';
import { getRoom } from './rooms.service';
import type { MessageDocument } from './firestore.documents';

function serialize(message: MessageDocument) { return { ...message, createdAt: message.createdAt.toDate().toISOString() }; }
export async function listMessages(uid: string, roomId: string, db?: Firestore) {
  return withFirestore(async firestore => {
    await getRoom(uid, roomId, firestore);
    const snapshot = await getRoomMessagesCollection(roomId, firestore).orderBy('createdAt', 'asc').limit(50).get();
    return snapshot.docs.map(doc => serialize(doc.data()));
  }, db);
}
export async function createMessage(uid: string, roomId: string, text: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const member = await getRoomMembersCollection(roomId, firestore).doc(uid).get();
    if (!member.exists) throw new AppError(403, 'ROOM_ACCESS_DENIED', 'Debes unirte a la sala antes de enviar mensajes.');
    const ref = getRoomMessagesCollection(roomId, firestore).doc();
    const message: MessageDocument = { messageId: ref.id, roomId, senderId: uid, text, createdAt: Timestamp.now() };
    await ref.create(message);
    return serialize(message);
  }, db);
}
