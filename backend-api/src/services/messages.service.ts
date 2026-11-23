import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { assertNoAccountDeletion } from './account-state.service';
import { getFirestoreCollections, getRoomMembersCollection, getRoomMessagesCollection, withFirestore } from './firestore.service';
import { requireRoom } from './rooms.service';
import type { MessageHistoryQuery } from '../validators/message.validator';
import type { MessageDocument } from './firestore.documents';

function serialize(message: MessageDocument) { return { ...message, createdAt: message.createdAt.toDate().toISOString() }; }
export async function listMessages(
  uid: string,
  roomId: string,
  db?: Firestore,
  { limit = 50, cursor }: MessageHistoryQuery = {},
) {
  return withFirestore(async firestore => {
    await requireRoom(roomId, uid, firestore);
    let query = getRoomMessagesCollection(roomId, firestore)
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    if (cursor) {
      const [seconds, nanoseconds, documentId] = cursor;
      query = query.startAfter(new Timestamp(seconds, nanoseconds), documentId);
    }

    const snapshot = await query.limit(limit + 1).get();
    const page = snapshot.docs.slice(0, limit);
    const oldest = page.at(-1);
    let nextCursor: string | null = null;
    if (oldest && snapshot.docs.length > limit) {
      const { seconds, nanoseconds } = oldest.data().createdAt;
      nextCursor = Buffer.from(JSON.stringify([seconds, nanoseconds, oldest.id])).toString('base64url');
    }

    return {
      data: page.reverse().map(doc => serialize(doc.data())),
      pagination: { nextCursor },
    };
  }, db);
}
export async function createMessage(uid: string, roomId: string, text: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const { accountDeletions } = getFirestoreCollections(firestore);
    const memberRef = getRoomMembersCollection(roomId, firestore).doc(uid);
    const ref = getRoomMessagesCollection(roomId, firestore).doc();
    const message: MessageDocument = { messageId: ref.id, roomId, senderId: uid, text, createdAt: Timestamp.now() };
    await firestore.runTransaction(async transaction => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(uid)));
      const member = await transaction.get(memberRef);
      if (!member.exists) throw new AppError(403, 'ROOM_ACCESS_DENIED', 'Debes unirte a la sala antes de enviar mensajes.');
      transaction.create(ref, message);
    });
    return serialize(message);
  }, db);
}
