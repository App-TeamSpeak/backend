import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessage, listMessages } from './messages.service';
import { createRoom, deleteRoom, getRoom, joinRoom, listRooms, updateRoom } from './rooms.service';

type Stored = Record<string, unknown>;

function database(initial: { rooms?: Stored[]; members?: Stored[]; messages?: Stored[] } = {}) {
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
  const collection = (kind: 'rooms' | 'members' | 'messages', roomId?: string): any => ({
    doc: vi.fn((id?: string) => ref(kind, id, roomId)),
    where: vi.fn((_field: string, _operator: string, value: unknown) => ({ get: vi.fn(async () => ({ docs: [...rooms.values()].filter(room => room.ownerId === value).map(data => ({ data: () => data })) })) })),
    orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ get: vi.fn(async () => ({ docs: [...messages.values()].sort((a, b) => (a.createdAt as Timestamp).toMillis() - (b.createdAt as Timestamp).toMillis()).map(data => ({ data: () => data })) })) })) })),
    get: vi.fn(async () => {
      const values = kind === 'rooms' ? [...rooms.values()] : kind === 'members' ? [...members.entries()].filter(([key]) => key.startsWith(`${roomId}/`)).map(([, value]) => value) : [...messages.values()];
      return { docs: values.map(data => ({ ref: ref(kind, String(data.messageId ?? data.uid ?? data.roomId), roomId), data: () => data })), size: kind === 'rooms' ? rooms.size : kind === 'members' ? [...members.keys()].filter(key => key.startsWith(`${roomId}/`)).length : messages.size };
    }),
  });
  const batch = {
    delete: vi.fn((value: { id?: string }) => {
      if (value.id) { rooms.delete(value.id); messages.delete(value.id); }
    }),
    commit: vi.fn(async () => undefined),
  };
  const db = {
    collection: vi.fn((name: string) => collection(name === 'rooms' ? 'rooms' : name === 'members' ? 'members' : 'messages')),
    runTransaction: vi.fn(async (callback: (transaction: any) => unknown) => callback({ create: vi.fn(async (value: any, data: Stored) => value.create(data)) })),
    batch: vi.fn(() => batch),
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
  });

  it('lists messages chronologically and creates messages only for members', async () => {
    const fake = database({ rooms: [room], members: [{ roomId: 'room-1', uid: 'member' }] });
    await expect(createMessage('stranger', 'room-1', 'No permitido', fake.db)).rejects.toMatchObject({ code: 'ROOM_ACCESS_DENIED' });
    const created = await createMessage('member', 'room-1', 'Hola', fake.db);
    expect(created).toMatchObject({ roomId: 'room-1', senderId: 'member', text: 'Hola' });
    await expect(listMessages('member', 'room-1', fake.db)).resolves.toEqual([expect.objectContaining({ text: 'Hola' })]);
  });
});
