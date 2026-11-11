import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, getRoomMembersCollection, getRoomMessagesCollection, withFirestore } from './firestore.service';
import type { RoomDocument } from './firestore.documents';

async function memberSnapshot(roomId: string, uid: string, db: Firestore) {
  return getRoomMembersCollection(roomId, db).doc(uid).get();
}
async function requireRoom(roomId: string, uid: string, db: Firestore) {
  const room = await getFirestoreCollections(db).rooms.doc(roomId).get();
  if (!room.exists) throw new AppError(404, 'ROOM_NOT_FOUND', 'La sala no existe.');
  const data = room.data() as RoomDocument;
  const member = await memberSnapshot(roomId, uid, db);
  if (data.ownerId !== uid && !member.exists) throw new AppError(403, 'ROOM_ACCESS_DENIED', 'No tienes acceso a esta sala.');
  return data;
}
async function serialize(room: RoomDocument, db: Firestore) {
  const members = await getRoomMembersCollection(room.roomId, db).get();
  return { ...room, createdAt: room.createdAt.toDate().toISOString(), participants: members.size, connected: members.size };
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
    const rooms = getFirestoreCollections(firestore).rooms;
    const ref = rooms.doc();
    const room: RoomDocument = { roomId: ref.id, ownerId: uid, name, createdAt: Timestamp.now() };
    const member = getRoomMembersCollection(ref.id, firestore).doc(uid);
    await firestore.runTransaction(async transaction => {
      transaction.create(ref, room);
      transaction.create(member, { uid, roomId: ref.id, role: 'host', joinedAt: room.createdAt });
    });
    return serialize(room, firestore);
  }, db);
}
export async function getRoom(uid: string, roomId: string, db?: Firestore) { return withFirestore(async firestore => serialize(await requireRoom(roomId, uid, firestore), firestore), db); }
export async function updateRoom(uid: string, roomId: string, name: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const room = await requireRoom(roomId, uid, firestore);
    if (room.ownerId !== uid) throw new AppError(403, 'ROOM_OWNER_REQUIRED', 'Solo el propietario puede editar la sala.');
    const ref = getFirestoreCollections(firestore).rooms.doc(roomId);
    await ref.update({ name });
    return serialize({ ...room, name }, firestore);
  }, db);
}
export async function deleteRoom(uid: string, roomId: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const room = await requireRoom(roomId, uid, firestore);
    if (room.ownerId !== uid) throw new AppError(403, 'ROOM_OWNER_REQUIRED', 'Solo el propietario puede eliminar la sala.');
    const members = await getRoomMembersCollection(roomId, firestore).get();
    const messages = await getRoomMessagesCollection(roomId, firestore).get();
    const batch = firestore.batch();
    batch.delete(getFirestoreCollections(firestore).rooms.doc(roomId));
    members.docs.forEach(doc => batch.delete(doc.ref));
    messages.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return { roomId };
  }, db);
}
export async function joinRoom(uid: string, roomId: string, db?: Firestore) {
  return withFirestore(async firestore => {
    const room = await getFirestoreCollections(firestore).rooms.doc(roomId).get();
    if (!room.exists) throw new AppError(404, 'ROOM_NOT_FOUND', 'La sala no existe.');
    const data = room.data() as RoomDocument;
    const memberRef = getRoomMembersCollection(roomId, firestore).doc(uid);
    await memberRef.set({ uid, roomId, role: data.ownerId === uid ? 'host' : 'member', joinedAt: Timestamp.now() }, { merge: true });
    return serialize(data, firestore);
  }, db);
}
