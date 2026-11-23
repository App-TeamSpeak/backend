import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessage, listMessages } from './messages.service';
import { createRoom, deleteRoom, getRoom, joinRoom, listRooms, updateRoom } from './rooms.service';

type Stored = Record<string, unknown>;

function database(initial: { rooms?: Stored[]; members?: Stored[]; messages?: Stored[]; deletingUid?: string } = {}) {
  const rooms = new Map((initial.rooms ?? []).map(value => [String(value.roomId), value]));
  const members = new Map((initial.members ?? []).map(value => [`${value.roomId}/${value.uid}`, value]));
  const messages = new Map((initial.messages ?? []).map(value => [String(value.messageId), value]));
  let generated = 0;
  const ref = (kind: 'rooms' | 'members' | 'messages', id?: string, roomId?: string): any => {
    const key = id ?? `${kind}-${++generated}`;
    const map = kind === 'rooms' ? rooms : kind === 'members' ? members : messages;
    const mapKey = kind === 'members' ? `${roomId}/${key}` : key;
    return {
      id: key,
      get: vi.fn(async () => ({ exists: map.has(mapKey), data: () => map.get(mapKey) })),
      create: vi.fn(async (value: Stored) => { if (map.has(mapKey)) throw new Error('already exists'); map.set(mapKey, value); }),
      set: vi.fn(async (value: Stored, options?: { merge?: boolean }) => { map.set(mapKey, options?.merge ? { ...map.get(mapKey), ...value } : value); }),
      update: vi.fn(async (value: Stored) => { map.set(mapKey, { ...map.get(mapKey), ...value }); }),
      delete: vi.fn(async () => { map.delete(mapKey); }),
      collection: vi.fn((name: string) => collection(name === 'members' ? 'members' : 'messages', key)),
    };
  };
  const collection = (kind: 'rooms' | 'members' | 'messages' | 'accountDeletions', roomId?: string): any => ({
    doc: vi.fn((id?: string) => kind === 'accountDeletions' ? { id, get: vi.fn(async () => ({ exists: id === initial.deletingUid, data: () => ({ status: 'pending' }) })) } : ref(kind, id, roomId)),
    where: vi.fn((_field: string, _operator: string, value: unknown) => ({ get: vi.fn(async () => ({ docs: [...rooms.values()].filter(room => room.ownerId === value).map(data => ({ data: () => data })) })) })),
    orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ get: vi.fn(async () => ({ docs: [...messages.values()].sort((a, b) => (a.createdAt as Timestamp).toMillis() - (b.createdAt as Timestamp).toMillis()).map(data => ({ data: () => data })) })) })) })),
    get: vi.fn(async () => {
      const values = kind === 'rooms' ? [...rooms.values()] : kind === 'members' ? [...members.entries()].filter(([key]) => key.startsWith(`${roomId}/`)).map(([, value]) => value) : [...messages.values()].filter(message => message.roomId === roomId);
      return { docs: values.map(data => ({ ref: ref(kind === 'accountDeletions' ? 'rooms' : kind, String(data.messageId ?? data.uid ?? data.roomId), roomId), data: () => data })), size: kind === 'rooms' ? rooms.size : kind === 'members' ? [...members.keys()].filter(key => key.startsWith(`${roomId}/`)).length : messages.size };
    }),
  });
  const db = {
    collection: vi.fn((name: string) => collection(name === 'rooms' ? 'rooms' : name === 'members' ? 'members' : name === 'accountDeletions' ? 'accountDeletions' : 'messages')),
    runTransaction: vi.fn(async (callback: (transaction: any) => unknown) => callback({
      get: vi.fn(async (value: any) => value.get()),
      update: vi.fn((value: any, data: Stored) => value.update(data)),
      delete: vi.fn((value: any) => value.delete()),
      create: vi.fn(async (value: any, data: Stored) => value.create(data)),
      set: vi.fn(async (value: any, data: Stored, opts?: { merge?: boolean }) => value.set(data, opts)),
    })),
  } as unknown as Firestore;
  return { db, rooms, members, messages };
}

const room = { roomId: 'room-1', ownerId: 'owner', name: 'Sala', createdAt: Timestamp.fromMillis(1) };

describe('rooms and messages services', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a room with its owner as host and returns participant count', async () => {
    const fake = database();
    const result = await createRoom('owner', 'Sala', fake.db);
    expect(result).toMatchObject({ name: 'Sala', participants: 1, connected: 1 });
    expect([...fake.rooms.values()]).toHaveLength(1);
    expect([...fake.members.values()][0]).toMatchObject({ uid: 'owner', role: 'host' });
  });

  it('authorizes members and rejects unrelated users', async () => {
    const fake = database({ rooms: [room], members: [{ roomId: 'room-1', uid: 'member' }] });
    await expect(getRoom('member', 'room-1', fake.db)).resolves.toMatchObject({ roomId: 'room-1' });
    await expect(getRoom('stranger', 'room-1', fake.db)).rejects.toMatchObject({ code: 'ROOM_ACCESS_DENIED' });
  });

  it('joins, updates, lists, and deletes a room with its nested data', async () => {
    const fake = database({ rooms: [room], members: [{ roomId: 'room-1', uid: 'owner' }], messages: [{ messageId: 'message-1', roomId: 'room-1' }] });
    await joinRoom('member', 'room-1', fake.db);
    await expect(updateRoom('owner', 'room-1', 'Nueva sala', fake.db)).resolves.toMatchObject({ name: 'Nueva sala' });
    await expect(listRooms('owner', fake.db)).resolves.toHaveLength(1);
    await expect(deleteRoom('owner', 'room-1', fake.db)).resolves.toEqual({ roomId: 'room-1' });
    expect(fake.rooms.has('room-1')).toBe(false);
    expect(fake.members.size).toBe(0);
    expect(fake.messages.size).toBe(0);
    await expect(listRooms('owner', fake.db)).resolves.toEqual([]);
    await expect(deleteRoom('owner', 'room-1', fake.db)).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    await expect(updateRoom('owner', 'room-1', 'Otra sala', fake.db)).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
  });

  it.each(['member', 'stranger'])('returns 403 and preserves room data for %s', async (uid) => {
    const member = { roomId: room.roomId, uid: 'member' };
    const message = { messageId: 'message-1', roomId: room.roomId };
    const fake = database({ rooms: [room], members: [member], messages: [message] });
    const forbidden = { statusCode: 403, code: 'ROOM_OWNER_REQUIRED' };

    await expect(updateRoom(uid, room.roomId, 'No permitido', fake.db)).rejects.toMatchObject(forbidden);
    await expect(deleteRoom(uid, room.roomId, fake.db)).rejects.toMatchObject(forbidden);
    expect([...fake.rooms.values()]).toEqual([room]);
    expect([...fake.members.values()]).toEqual([member]);
    expect([...fake.messages.values()]).toEqual([message]);
  });

  it('joins a room by its trimmed ID and preserves the original membership on retries', async () => {
    const fake = database({ rooms: [room] });
    await expect(joinRoom('guest', '  room-1  ', fake.db)).resolves.toMatchObject({ roomId: 'room-1' });
    const membership = fake.members.get('room-1/guest');
    expect(membership).toMatchObject({ uid: 'guest', role: 'member' });

    await joinRoom('guest', 'room-1', fake.db);
    expect(fake.members.get('room-1/guest')).toBe(membership);
  });

  it.each(['', '   ', 'nested/room', '.', '..', '__reserved__', 'a'.repeat(129)])(
    'rejects an invalid room ID before opening a transaction (%j)',
    async (id) => {
      const fake = database();
      await expect(joinRoom('guest', id, fake.db)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(fake.db.runTransaction).not.toHaveBeenCalled();
    },
  );

  it('returns 404 for a valid but unknown ID and does not create membership', async () => {
    const fake = database();
    await expect(joinRoom('guest', 'missing', fake.db)).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    expect(fake.members.size).toBe(0);
  });

  it('does not admit a guest with a pending account deletion', async () => {
    const fake = database({ rooms: [room], deletingUid: 'guest' });
    await expect(joinRoom('guest', room.roomId, fake.db)).rejects.toMatchObject({
      statusCode: 403, code: 'ACCOUNT_DELETION_PENDING',
    });
    expect(fake.members.size).toBe(0);
  });

  it('lists messages chronologically and creates messages only for members', async () => {
    const fake = database({ rooms: [room], members: [{ roomId: 'room-1', uid: 'member' }] });
    await expect(createMessage('stranger', 'room-1', 'No permitido', fake.db)).rejects.toMatchObject({ code: 'ROOM_ACCESS_DENIED' });
    const created = await createMessage('member', 'room-1', 'Hola', fake.db);
    expect(created).toMatchObject({ roomId: 'room-1', senderId: 'member', text: 'Hola' });
    await expect(listMessages('member', 'room-1', fake.db)).resolves.toEqual([expect.objectContaining({ text: 'Hola' })]);
  });
});
