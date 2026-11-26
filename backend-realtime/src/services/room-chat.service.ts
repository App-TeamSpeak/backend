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
  const roomRef = db.collection('rooms').doc(roomId);
  const ref = roomRef.collection('messages').doc();
  const createdAt = Timestamp.now();
  try {
    await db.runTransaction(async transaction => {
      const room = await transaction.get(roomRef);
      if (!room.exists) throw new RoomChatError('ROOM_NOT_FOUND');
      const ownerId: unknown = room.get('ownerId');
      if (ownerId !== uid) {
        const member = await transaction.get(roomRef.collection('members').doc(uid));
        if (!member.exists) throw new RoomChatError('ROOM_ACCESS_DENIED');
      }
      transaction.create(ref, {
        messageId: ref.id,
        roomId,
        senderId: uid,
        text,
        createdAt,
      });
      transaction.update(roomRef, { lastActivityAt: createdAt });
    });
  } catch (error) {
    if (error instanceof RoomChatError) throw error;
    throw new RoomChatError('EVENT_FAILED');
  }
  return {
    messageId: ref.id,
    authorId: uid,
    text,
    createdAt: createdAt.toDate().toISOString(),
  };
}

export async function syncRoomPresence(roomId: string, uid: string, present: boolean): Promise<void> {
  if (!roomId || roomId.length > 128 || roomId.includes('/') || !uid || uid.length > 128 || uid.includes('/')) {
    return;
  }
  try {
    const db = getFirestoreDb();
    const roomRef = db.collection('rooms').doc(roomId);
    const presenceRef = roomRef.collection('presence').doc(uid);
    if (!present) {
      await presenceRef.delete();
      return;
    }
    const updatedAt = Timestamp.now();
    await db.runTransaction(async transaction => {
      const room = await transaction.get(roomRef);
      if (!room.exists) return;
      transaction.set(presenceRef, { uid, roomId, updatedAt });
      transaction.update(roomRef, { lastActivityAt: updatedAt });
    });
  } catch {
    // Best-effort presence sync; failures must not disrupt socket signaling or disconnect cleanup.
  }
}

export function watchRoomAccess(
  roomId: string,
  uid: string,
  onRevoked: (code: 'ROOM_NOT_FOUND' | 'ROOM_ACCESS_DENIED') => void,
  onError: () => void,
  onUpdated?: (room: { name: string }) => void,
): () => void {
  if (!roomId || roomId.length > 128 || roomId.includes('/') || !uid || uid.length > 128 || uid.includes('/')) {
    onRevoked('ROOM_ACCESS_DENIED');
    return () => undefined;
  }
  const roomRef = getFirestoreDb().collection('rooms').doc(roomId);
  let checkingRoom = false;
  let active = true;
  let roomExists: boolean | undefined;
  let ownerId: unknown;
  let roomName: string | undefined;
  let memberExists: boolean | undefined;
  let stopRoom: (() => void) | undefined;
  let stopMember: (() => void) | undefined;

  const stop = () => {
    if (!active) return;
    active = false;
    try { stopRoom?.(); } catch { /* ignore cleanup error */ }
    try { stopMember?.(); } catch { /* ignore cleanup error */ }
  };

  const evaluate = () => {
    if (!active) return;
    if (roomExists === false) {
      stop();
      onRevoked('ROOM_NOT_FOUND');
      return;
    }
    if (roomExists === true && ownerId !== uid && memberExists === false && !checkingRoom) {
      // Firestore may notify the member listener before the room listener for the same deletion.
      checkingRoom = true;
      void withAuthorizationTimeout(() => roomRef.get()).then(snapshot => {
        checkingRoom = false;
        if (!active || memberExists !== false || ownerId === uid) return;
        stop();
        onRevoked(snapshot.exists ? 'ROOM_ACCESS_DENIED' : 'ROOM_NOT_FOUND');
      }, () => {
        checkingRoom = false;
        if (!active || memberExists !== false || ownerId === uid) return;
        stop();
        onError();
      });
    }
  };

  try {
    stopRoom = roomRef.onSnapshot((snapshot) => {
      if (!active) return;
      roomExists = snapshot.exists;
      const data = snapshot.exists ? snapshot.data() as { ownerId?: unknown; name?: unknown } | undefined : undefined;
      ownerId = data?.ownerId;
      const nextName = typeof data?.name === 'string' ? data.name : undefined;
      if (roomName !== undefined && nextName !== undefined && nextName !== roomName) onUpdated?.({ name: nextName });
      roomName = nextName;
      evaluate();
    }, () => {
      if (!active) return;
      stop();
      onError();
    });

    stopMember = roomRef.collection('members').doc(uid).onSnapshot((snapshot) => {
      if (!active) return;
      memberExists = snapshot.exists;
      evaluate();
    }, () => {
      if (!active) return;
      stop();
      onError();
    });
  } catch {
    stop();
    onError();
  }

  return stop;
}

