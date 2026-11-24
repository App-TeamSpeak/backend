import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { assertNoAccountDeletion } from './account-state.service';
import { getFirestoreCollections, getRoomMembersCollection, getRoomMessagesCollection, withFirestore } from './firestore.service';
import { requireRoom } from './rooms.service';
import type { MessageHistoryQuery } from '../validators/message.validator';
import type { MessageDocument } from './firestore.documents';

function formatFullName(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const nombre = typeof data.nombre === 'string' ? data.nombre.trim() : '';
  const apellido = typeof data.apellido === 'string' ? data.apellido.trim() : '';
  const fullName = `${nombre} ${apellido}`.trim();
  return fullName || null;
}

async function resolveAuthorNames(messages: MessageDocument[], firestore: Firestore): Promise<Map<string, string | null>> {
  const uids = [...new Set(
    messages
      .filter(message => !message.authorDeleted && typeof message.senderId === 'string' && message.senderId.length > 0)
      .map(message => message.senderId as string),
  )];
  const resolved = new Map<string, string | null>();
  if (uids.length === 0) return resolved;

  const { users, accountDeletions } = getFirestoreCollections(firestore);
  const userRefs = uids.map(uid => users.doc(uid));
  const deletionRefs = uids.map(uid => accountDeletions.doc(uid));
  const snapshots = typeof firestore.getAll === 'function'
    ? await firestore.getAll(...userRefs, ...deletionRefs)
    : await Promise.all([...userRefs, ...deletionRefs].map(ref => ref.get()));

  for (let index = 0; index < uids.length; index += 1) {
    const userSnap = snapshots[index];
    const deletionSnap = snapshots[uids.length + index];
    if (deletionSnap?.exists || !userSnap?.exists) {
      resolved.set(uids[index], null);
      continue;
    }
    resolved.set(uids[index], formatFullName(userSnap.data() as Record<string, unknown> | undefined));
  }
  return resolved;
}

function serialize(message: MessageDocument, authorName: string | null = null) {
  return { ...message, authorName, createdAt: message.createdAt.toDate().toISOString() };
}
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

    const chronological = page.reverse().map(doc => doc.data());
    const authorNames = await resolveAuthorNames(chronological, firestore);

    return {
      data: chronological.map(message => serialize(
        message,
        message.authorDeleted || !message.senderId ? null : (authorNames.get(message.senderId) ?? null),
      )),
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
