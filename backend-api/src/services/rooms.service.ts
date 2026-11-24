import { Timestamp, type Firestore, type DocumentSnapshot } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { assertNoAccountDeletion } from './account-state.service';
import { getFirestoreCollections, getRoomMembersCollection, getRoomMessagesCollection, getRoomPresenceCollection, withFirestore } from './firestore.service';
import type { RoomDocument } from './firestore.documents';

async function memberSnapshot(roomId: string, uid: string, db: Firestore) {
  return getRoomMembersCollection(roomId, db).doc(uid).get();
}
export async function requireRoom(roomId: string, uid: string, db: Firestore) {
  const room = await getFirestoreCollections(db).rooms.doc(roomId).get();
  if (!room.exists) throw new AppError(404, 'ROOM_NOT_FOUND', 'La sala no existe.');
  const data = room.data() as RoomDocument;
  const member = await memberSnapshot(roomId, uid, db);
  if (data.ownerId !== uid && !member.exists) throw new AppError(403, 'ROOM_ACCESS_DENIED', 'No tienes acceso a esta sala.');
  return data;
}
async function serialize(room: RoomDocument, db: Firestore) {
  const [members, presence] = await Promise.all([
    getRoomMembersCollection(room.roomId, db).get(),
    getRoomPresenceCollection(room.roomId, db).get(),
  ]);
  const lastActivityAt = (room.lastActivityAt ?? room.createdAt).toDate().toISOString();
  return {
    ...room,
    createdAt: room.createdAt.toDate().toISOString(),
    lastActivityAt,
    participants: members.size,
    connected: presence.size,
  };
}

export async function listRooms(uid: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const snapshot = await getFirestoreCollections(firestore).rooms.where('ownerId', '==', uid).get();
    const rooms = await Promise.all(snapshot.docs.map(doc => serialize(doc.data(), firestore)));
    return rooms.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, db);
}
export async function createRoom(uid: string, name: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const { rooms, accountDeletions } = getFirestoreCollections(firestore);
    const ref = rooms.doc();
    const now = Timestamp.now();
    const room: RoomDocument = { roomId: ref.id, ownerId: uid, name, createdAt: now, lastActivityAt: now };
    const member = getRoomMembersCollection(ref.id, firestore).doc(uid);
    await firestore.runTransaction(async transaction => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(uid)));
      transaction.create(ref, room);
      transaction.create(member, { uid, roomId: ref.id, role: 'host', joinedAt: room.createdAt });
    });
    return serialize(room, firestore);
  }, db);
}
export async function getRoom(uid: string, roomId: string, db?: Firestore) { return withFirestore(async firestore => serialize(await requireRoom(roomId, uid, firestore), firestore), db); }
function requireOwner(snapshot: DocumentSnapshot<RoomDocument>, uid: string): RoomDocument {
  const room = snapshot.data();
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'La sala no existe.');
  if (room.ownerId !== uid) throw new AppError(403, 'ROOM_OWNER_REQUIRED', 'Solo el propietario puede gestionar la sala.');
  return room;
}

export async function updateRoom(uid: string, roomId: string, name: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const { rooms, accountDeletions } = getFirestoreCollections(firestore);
    const ref = rooms.doc(roomId);
    const room = await firestore.runTransaction(async transaction => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(uid)));
      const current = requireOwner(await transaction.get(ref), uid);
      const lastActivityAt = Timestamp.now();
      transaction.update(ref, { name, lastActivityAt });
      return { ...current, name, lastActivityAt };
    });
    return serialize(room, firestore);
  }, db);
}

export async function deleteRoom(uid: string, roomId: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const { rooms, accountDeletions } = getFirestoreCollections(firestore);
    const ref = rooms.doc(roomId);
    await firestore.runTransaction(async transaction => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(uid)));
      requireOwner(await transaction.get(ref), uid);
      const members = await transaction.get(getRoomMembersCollection(roomId, firestore));
      const messages = await transaction.get(getRoomMessagesCollection(roomId, firestore));
      const presence = await transaction.get(getRoomPresenceCollection(roomId, firestore));
      for (const doc of [...members.docs, ...messages.docs, ...presence.docs]) transaction.delete(doc.ref);
      transaction.delete(ref);
    });
    return { roomId };
  }, db);
}

export async function joinRoom(uid: string, rawRoomId: string, db?: Firestore) {
  const roomId = rawRoomId.trim();
  if (!roomId || roomId.length > 128 || /\/|^\.{1,2}$|^__.*__$/.test(roomId)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Ingresa un identificador de sala válido.');
  }
  return withFirestore(async firestore => {
    const { rooms, accountDeletions } = getFirestoreCollections(firestore);
    const roomRef = rooms.doc(roomId);
    const memberRef = getRoomMembersCollection(roomId, firestore).doc(uid);
    const data = await firestore.runTransaction(async transaction => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(uid)));
      const room = await transaction.get(roomRef);
      if (!room.exists) throw new AppError(404, 'ROOM_NOT_FOUND', 'La sala no existe.');
      const roomData = room.data() as RoomDocument;
      const member = await transaction.get(memberRef);
      if (!member.exists) {
        const joinedAt = Timestamp.now();
        transaction.create(memberRef, {
          uid, roomId, role: roomData.ownerId === uid ? 'host' : 'member', joinedAt,
        });
        transaction.update(roomRef, { lastActivityAt: joinedAt });
        return { ...roomData, lastActivityAt: joinedAt };
      }
      return roomData;
    });
    return serialize(data, firestore);
  }, db);
}
