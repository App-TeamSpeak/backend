import { Timestamp } from 'firebase-admin/firestore';
import { getFirestoreDb } from '../config/firebase';
import { withAuthorizationTimeout } from './account-state.service';

export type RoomChatErrorCode = 'ROOM_NOT_FOUND' | 'ROOM_ACCESS_DENIED' | 'AUTHORIZATION_UNAVAILABLE' | 'EVENT_FAILED';

export class RoomChatError extends Error {
  constructor(public readonly code: RoomChatErrorCode) {
    super(code);
    this.name = 'RoomChatError';
  }
}

function assertValidId(value: string, code: RoomChatErrorCode): void {
  if (!value || value.length > 128 || value.includes('/')) {
    throw new RoomChatError(code);
  }
}

export async function ensureRoomAccessible(roomId: string, uid: string): Promise<void> {
  assertValidId(roomId, 'ROOM_NOT_FOUND');
  assertValidId(uid, 'ROOM_ACCESS_DENIED');
  const db = getFirestoreDb();
  let roomSnapshot;
  try {
    roomSnapshot = await withAuthorizationTimeout(() => db.collection('rooms').doc(roomId).get());
  } catch {
    throw new RoomChatError('AUTHORIZATION_UNAVAILABLE');
  }
  if (!roomSnapshot.exists) {
    throw new RoomChatError('ROOM_NOT_FOUND');
  }
  const data = roomSnapshot.data() as { ownerId?: unknown } | undefined;
  if (data?.ownerId === uid) return;

  let memberSnapshot;
  try {
    memberSnapshot = await withAuthorizationTimeout(() => db.collection('rooms').doc(roomId).collection('members').doc(uid).get());
  } catch {
    throw new RoomChatError('AUTHORIZATION_UNAVAILABLE');
  }
  if (!memberSnapshot.exists) {
    throw new RoomChatError('ROOM_ACCESS_DENIED');
  }
}

export async function persistRoomMessage(
  roomId: string,
  uid: string,
  text: string,
): Promise<{ messageId: string; authorId: string; text: string; createdAt: string }> {
  assertValidId(roomId, 'EVENT_FAILED');
  assertValidId(uid, 'EVENT_FAILED');
  const db = getFirestoreDb();
  const ref = db.collection('rooms').doc(roomId).collection('messages').doc();
  const createdAt = Timestamp.now();
  try {
    await ref.create({
      messageId: ref.id,
      roomId,
      senderId: uid,
      text,
      createdAt,
    });
  } catch {
    throw new RoomChatError('EVENT_FAILED');
  }
  return {
    messageId: ref.id,
    authorId: uid,
    text,
    createdAt: createdAt.toDate().toISOString(),
  };
}

