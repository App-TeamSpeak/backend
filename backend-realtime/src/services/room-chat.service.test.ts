import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getFirestoreDb: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirestoreDb: mocks.getFirestoreDb }));

import { ensureRoomAccessible, persistRoomMessage, RoomChatError, syncRoomPresence, watchRoomAccess } from './room-chat.service';

function makeDb(options: {
  room?: { exists: boolean; data?: () => Record<string, unknown> };
  member?: { exists: boolean };
  create?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  set?: ReturnType<typeof vi.fn>;
  del?: ReturnType<typeof vi.fn>;
  roomError?: unknown;
  memberError?: unknown;
} = {}) {
  const create = options.create ?? vi.fn().mockResolvedValue(undefined);
  const update = options.update ?? vi.fn().mockResolvedValue(undefined);
  const set = options.set ?? vi.fn().mockResolvedValue(undefined);
  const del = options.del ?? vi.fn().mockResolvedValue(undefined);
  const room: NonNullable<typeof options.room> = options.room ?? { exists: true, data: () => ({ ownerId: 'owner-1' }) };
  const roomRef = {
    id: 'room-1',
    get: options.roomError
      ? vi.fn().mockRejectedValue(options.roomError)
      : vi.fn().mockResolvedValue({ ...room, get: (field: string) => room.data?.()?.[field] }),
    update,
    collection: (sub: string) => {
      if (sub === 'members') {
        return {
          doc: () => ({
            get: options.memberError
              ? vi.fn().mockRejectedValue(options.memberError)
              : vi.fn().mockResolvedValue(options.member ?? { exists: true }),
          }),
        };
      }
      if (sub === 'messages') {
        return {
          doc: () => ({ id: 'msg-123', create }),
        };
      }
      if (sub === 'presence') {
        return {
          doc: (uid: string) => ({ id: uid, set, delete: del }),
        };
      }
      throw new Error(`Unexpected subcollection: ${sub}`);
    },
  };
  const db = {
    runTransaction: async (operation: (transaction: {
      get: (ref: { get: () => unknown }) => unknown;
      create: typeof create;
      update: typeof update;
      set: typeof set;
    }) => Promise<void>) => {
      await operation({ get: ref => ref.get(), create, update, set });
      await create.mock.results.at(-1)?.value;
    },
    collection: (name: string) => {
      if (name !== 'rooms') throw new Error(`Unexpected collection: ${name}`);
      return {
        doc: () => roomRef,
      };
    },
  };
  mocks.getFirestoreDb.mockReturnValue(db);
  return { db, create, update, set, del, roomRef };
}

beforeEach(() => vi.resetAllMocks());

it('allows room owner without requiring member doc', async () => {
  makeDb({ room: { exists: true, data: () => ({ ownerId: 'user-1' }) }, member: { exists: false } });
  await expect(ensureRoomAccessible('room-1', 'user-1')).resolves.toBeUndefined();
});

it('allows joined member who is not the owner', async () => {
  makeDb({ room: { exists: true, data: () => ({ ownerId: 'owner-1' }) }, member: { exists: true } });
  await expect(ensureRoomAccessible('room-1', 'user-2')).resolves.toBeUndefined();
});

it('rejects missing room with ROOM_NOT_FOUND', async () => {
  makeDb({ room: { exists: false } });
  await expect(ensureRoomAccessible('missing', 'user-1')).rejects.toEqual(new RoomChatError('ROOM_NOT_FOUND'));
});

it('rejects non-member with ROOM_ACCESS_DENIED', async () => {
  makeDb({ room: { exists: true, data: () => ({ ownerId: 'owner-1' }) }, member: { exists: false } });
  await expect(ensureRoomAccessible('room-1', 'stranger')).rejects.toEqual(new RoomChatError('ROOM_ACCESS_DENIED'));
});

it('rejects invalid roomId containing slash', async () => {
  await expect(ensureRoomAccessible('room/1', 'user-1')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
});

it('maps Firestore read errors to AUTHORIZATION_UNAVAILABLE', async () => {
  makeDb({ roomError: new Error('private sdk failure') });
  await expect(ensureRoomAccessible('room-1', 'user-1')).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
});

it('persists message in rooms/{roomId}/messages and updates room lastActivityAt', async () => {
  const { create, update, roomRef } = makeDb();
  const saved = await persistRoomMessage('room-1', 'user-1', 'Hola equipo');
  expect(saved.messageId).toBe('msg-123');
  expect(saved.authorId).toBe('user-1');
  expect(saved.text).toBe('Hola equipo');
  expect(Date.parse(saved.createdAt)).not.toBeNaN();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-123' }), expect.objectContaining({
    messageId: 'msg-123',
    roomId: 'room-1',
    senderId: 'user-1',
    text: 'Hola equipo',
    createdAt: expect.any(Timestamp),
  }));
  expect(update).toHaveBeenCalledWith(roomRef, { lastActivityAt: expect.any(Timestamp) });
});

it('syncs active presence and updates lastActivityAt only while the room exists', async () => {
  const { set, del, update, roomRef } = makeDb();
  await syncRoomPresence('room-1', 'user-1', true);
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'user-1' }),
    expect.objectContaining({ uid: 'user-1', roomId: 'room-1', updatedAt: expect.any(Timestamp) }),
  );
  expect(update).toHaveBeenCalledWith(roomRef, { lastActivityAt: expect.any(Timestamp) });

  await syncRoomPresence('room-1', 'user-1', false);
  expect(del).toHaveBeenCalledTimes(1);

  const missing = makeDb({ room: { exists: false } });
  await syncRoomPresence('room-1', 'user-1', true);
  expect(missing.set).not.toHaveBeenCalled();
  expect(missing.update).not.toHaveBeenCalled();
});

it('does not persist a message if the room has already been deleted', async () => {
  const { create } = makeDb({ room: { exists: false } });
  await expect(persistRoomMessage('room-1', 'user-1', 'Hola')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
  expect(create).not.toHaveBeenCalled();
});

it('does not persist a message if membership has already been revoked', async () => {
  const { create } = makeDb({ member: { exists: false } });
  await expect(persistRoomMessage('room-1', 'user-1', 'Hola')).rejects.toMatchObject({ code: 'ROOM_ACCESS_DENIED' });
  expect(create).not.toHaveBeenCalled();
});

it('maps message persistence errors to EVENT_FAILED', async () => {
  makeDb({ create: vi.fn().mockRejectedValue(new Error('firestore down')) });
  await expect(persistRoomMessage('room-1', 'user-1', 'Hola')).rejects.toMatchObject({ code: 'EVENT_FAILED' });
});

describe('watchRoomAccess', () => {
  function setupSnapshots(roomExists = true) {
    let roomCb!: (snap: { exists: boolean; data?: () => Record<string, unknown> }) => void;
    let memberCb!: (snap: { exists: boolean }) => void;
    const stopRoom = vi.fn();
    const stopMember = vi.fn();
    const db = {
      collection: () => ({
        doc: () => ({
          get: vi.fn(async () => ({ exists: roomExists })),
          onSnapshot: (cb: typeof roomCb) => { roomCb = cb; return stopRoom; },
          collection: () => ({
            doc: () => ({
              onSnapshot: (cb: typeof memberCb) => { memberCb = cb; return stopMember; },
            }),
          }),
        }),
      }),
    };
    mocks.getFirestoreDb.mockReturnValue(db);
    return { emitRoom: (v: { exists: boolean; data?: () => Record<string, unknown> }) => roomCb(v), emitMember: (v: { exists: boolean }) => memberCb(v), stopRoom, stopMember };
  }

  it('triggers ROOM_NOT_FOUND when room is deleted and unsubscribes both listeners', () => {
    const s = setupSnapshots();
    const onRevoked = vi.fn();
    watchRoomAccess('room-1', 'user-1', onRevoked, vi.fn());
    s.emitRoom({ exists: false });
    expect(onRevoked).toHaveBeenCalledExactlyOnceWith('ROOM_NOT_FOUND');
    expect(s.stopRoom).toHaveBeenCalled();
    expect(s.stopMember).toHaveBeenCalled();
  });

  it('triggers ROOM_ACCESS_DENIED when non-owner membership is revoked', async () => {
    const s = setupSnapshots();
    const onRevoked = vi.fn();
    watchRoomAccess('room-1', 'user-2', onRevoked, vi.fn());
    s.emitRoom({ exists: true, data: () => ({ ownerId: 'owner-1' }) });
    s.emitMember({ exists: false });
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledExactlyOnceWith('ROOM_ACCESS_DENIED'));
    expect(s.stopRoom).toHaveBeenCalled();
    expect(s.stopMember).toHaveBeenCalled();
  });

  it('reports the room deletion when the member snapshot arrives first', async () => {
    const s = setupSnapshots(false);
    const onRevoked = vi.fn();
    watchRoomAccess('room-1', 'member', onRevoked, vi.fn());
    s.emitRoom({ exists: true, data: () => ({ ownerId: 'host' }) });
    s.emitMember({ exists: false });
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledExactlyOnceWith('ROOM_NOT_FOUND'));
    s.emitRoom({ exists: false });
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('preserves owner access even when member document is absent', () => {
    const s = setupSnapshots();
    const onRevoked = vi.fn();
    const stop = watchRoomAccess('room-1', 'owner-1', onRevoked, vi.fn());
    s.emitRoom({ exists: true, data: () => ({ ownerId: 'owner-1' }) });
    s.emitMember({ exists: false });
    expect(onRevoked).not.toHaveBeenCalled();
    stop();
    expect(s.stopRoom).toHaveBeenCalled();
    expect(s.stopMember).toHaveBeenCalled();
  });
});

