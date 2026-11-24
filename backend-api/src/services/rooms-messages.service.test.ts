import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messageHistoryQuerySchema } from '../validators/message.validator';
import { createMessage, listMessages } from './messages.service';
import { createRoom, deleteRoom, getRoom, joinRoom, listRooms, updateRoom } from './rooms.service';

type Stored = Record<string, unknown>;

function database(initial: { rooms?: Stored[]; members?: Stored[]; messages?: Stored[]; presence?: Stored[]; users?: Stored[]; deletingUid?: string } = {}) {
  const rooms = new Map((initial.rooms ?? []).map(value => [String(value.roomId), value]));
  const members = new Map((initial.members ?? []).map(value => [`${value.roomId}/${value.uid}`, value]));
  const messages = new Map((initial.messages ?? []).map(value => [String(value.messageId), value]));
  const presence = new Map((initial.presence ?? []).map(value => [`${value.roomId}/${value.uid}`, value]));
  const users = new Map((initial.users ?? []).map(value => [String(value.uid), value]));
  let generated = 0;
  const ref = (kind: 'rooms' | 'members' | 'messages' | 'presence', id?: string, roomId?: string): any => {
    const key = id ?? `${kind}-${++generated}`;
    const map = kind === 'rooms' ? rooms : kind === 'members' ? members : kind === 'presence' ? presence : messages;
    const mapKey = kind === 'members' || kind === 'presence' ? `${roomId}/${key}` : key;
    return {
      id: key,
      get: vi.fn(async () => ({ exists: map.has(mapKey), data: () => map.get(mapKey) })),
      create: vi.fn(async (value: Stored) => { if (map.has(mapKey)) throw new Error('already exists'); map.set(mapKey, value); }),
      set: vi.fn(async (value: Stored, options?: { merge?: boolean }) => { map.set(mapKey, options?.merge ? { ...map.get(mapKey), ...value } : value); }),
      update: vi.fn(async (value: Stored) => { map.set(mapKey, { ...map.get(mapKey), ...value }); }),
      delete: vi.fn(async () => { map.delete(mapKey); }),
      collection: vi.fn((name: string) => collection(name === 'members' ? 'members' : name === 'presence' ? 'presence' : 'messages', key)),
    };
  };
  const collection = (kind: 'rooms' | 'members' | 'messages' | 'presence' | 'accountDeletions' | 'users', roomId?: string): any => ({
    doc: vi.fn((id?: string) => kind === 'accountDeletions'
      ? { id, get: vi.fn(async () => ({ exists: id === initial.deletingUid, data: () => ({ status: 'pending' }) })) }
      : kind === 'users'
        ? { id, get: vi.fn(async () => ({ exists: id !== undefined && users.has(id), data: () => (id !== undefined ? users.get(id) : undefined) })) }
        : ref(kind, id, roomId)),
    where: vi.fn((_field: string, _operator: string, value: unknown) => ({ get: vi.fn(async () => ({ docs: [...rooms.values()].filter(room => room.ownerId === value).map(data => ({ data: () => data })) })) })),
    orderBy: vi.fn(() => ({
      orderBy: vi.fn(() => messageQuery(roomId)),
    })),
    get: vi.fn(async () => {
      const values = kind === 'rooms'
        ? [...rooms.values()]
        : kind === 'members'
          ? [...members.entries()].filter(([key]) => key.startsWith(`${roomId}/`)).map(([, value]) => value)
          : kind === 'presence'
            ? [...presence.entries()].filter(([key]) => key.startsWith(`${roomId}/`)).map(([, value]) => value)
            : [...messages.values()].filter(message => message.roomId === roomId);
      return { docs: values.map(data => ({ ref: ref(kind === 'accountDeletions' || kind === 'users' ? 'rooms' : kind, String(data.messageId ?? data.uid ?? data.roomId), roomId), data: () => data })), size: values.length };
    }),
  });
  const messageQuery = (roomId?: string, cursor?: { timestamp: Timestamp; id: string }, limit = 50) => {
    const compare = (a: Timestamp, aId: string, b: Timestamp, bId: string) =>
      b.seconds - a.seconds || b.nanoseconds - a.nanoseconds || bId.localeCompare(aId);
    return {
      startAfter: (timestamp: Timestamp, id: string) => messageQuery(roomId, { timestamp, id }, limit),
      limit: (size: number) => messageQuery(roomId, cursor, size),
      get: async () => ({
        docs: [...messages.entries()]
          .filter(([id, data]) => data.roomId === roomId &&
            (!cursor || compare(data.createdAt as Timestamp, id, cursor.timestamp, cursor.id) > 0))
          .sort(([aId, a], [bId, b]) => compare(a.createdAt as Timestamp, aId, b.createdAt as Timestamp, bId))
          .slice(0, limit)
          .map(([id, data]) => ({ id, data: () => data })),
      }),
    };
  };
  const db = {
    collection: vi.fn((name: string) => collection(name === 'rooms' ? 'rooms' : name === 'members' ? 'members' : name === 'presence' ? 'presence' : name === 'accountDeletions' ? 'accountDeletions' : name === 'users' ? 'users' : 'messages')),
    getAll: vi.fn(async (...refs: any[]) => Promise.all(refs.map(item => item.get()))),
    runTransaction: vi.fn(async (callback: (transaction: any) => unknown) => callback({
      get: vi.fn(async (value: any) => value.get()),
      update: vi.fn((value: any, data: Stored) => value.update(data)),
      delete: vi.fn((value: any) => value.delete()),
      create: vi.fn(async (value: any, data: Stored) => value.create(data)),
      set: vi.fn(async (value: any, data: Stored, opts?: { merge?: boolean }) => value.set(data, opts)),
    })),
  } as unknown as Firestore;
  return { db, rooms, members, messages, presence };
}

const room = { roomId: 'room-1', ownerId: 'owner', name: 'Sala', createdAt: Timestamp.fromMillis(1) };

describe('rooms and messages services', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a room with its owner as host and returns participant count and initial activity', async () => {
    const fake = database();
    const result = await createRoom('owner', 'Sala', fake.db);
    expect(result).toMatchObject({ name: 'Sala', participants: 1, connected: 0, lastActivityAt: result.createdAt });
    expect([...fake.rooms.values()]).toHaveLength(1);
    expect([...fake.members.values()][0]).toMatchObject({ uid: 'owner', role: 'host' });
  });

  it('counts active presence documents separately from total members and cleans presence on delete', async () => {
    const fake = database({
      rooms: [room],
      members: [
        { roomId: 'room-1', uid: 'owner', role: 'host' },
        { roomId: 'room-1', uid: 'member-1', role: 'member' },
        { roomId: 'room-1', uid: 'member-2', role: 'member' },
      ],
      presence: [
        { roomId: 'room-1', uid: 'owner' },
        { roomId: 'room-1', uid: 'member-1' },
      ],
    });

    await expect(getRoom('owner', 'room-1', fake.db)).resolves.toMatchObject({
      participants: 3,
      connected: 2,
      lastActivityAt: room.createdAt.toDate().toISOString(),
    });
    await expect(listRooms('owner', fake.db)).resolves.toEqual([
      expect.objectContaining({ roomId: 'room-1', participants: 3, connected: 2 }),
    ]);

    await deleteRoom('owner', 'room-1', fake.db);
    expect(fake.presence.size).toBe(0);
  });

  it('updates lastActivityAt on rename, new member join, and message creation while keeping createdAt unchanged', async () => {
    const legacyCreatedAt = Timestamp.fromMillis(1_000);
    const fake = database({
      rooms: [{ roomId: 'room-1', ownerId: 'owner', name: 'Sala', createdAt: legacyCreatedAt }],
      members: [{ roomId: 'room-1', uid: 'owner', role: 'host' }],
    });

    const spy = vi.spyOn(Timestamp, 'now');
    spy.mockReturnValueOnce(Timestamp.fromMillis(2_000));
    const joined = await joinRoom('guest', 'room-1', fake.db);
    expect(joined.createdAt).toBe(legacyCreatedAt.toDate().toISOString());
    expect(joined.lastActivityAt).toBe(Timestamp.fromMillis(2_000).toDate().toISOString());

    // Idempotent re-join does not rewrite room activity.
    const rejoined = await joinRoom('guest', 'room-1', fake.db);
    expect(rejoined.lastActivityAt).toBe(Timestamp.fromMillis(2_000).toDate().toISOString());

    spy.mockReturnValueOnce(Timestamp.fromMillis(3_000));
    const renamed = await updateRoom('owner', 'room-1', 'Sala editada', fake.db);
    expect(renamed.lastActivityAt).toBe(Timestamp.fromMillis(3_000).toDate().toISOString());

    spy.mockReturnValueOnce(Timestamp.fromMillis(4_000));
    await createMessage('guest', 'room-1', 'Hola equipo', fake.db);
    const afterMsg = await getRoom('owner', 'room-1', fake.db);
    expect(afterMsg.lastActivityAt).toBe(Timestamp.fromMillis(4_000).toDate().toISOString());
    expect(afterMsg.createdAt).toBe(legacyCreatedAt.toDate().toISOString());
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
    await expect(listMessages('member', 'room-1', fake.db)).resolves.toEqual({
      data: [expect.objectContaining({ text: 'Hola' })],
      pagination: { nextCursor: null },
    });
  });

  it('loads the latest page and visits older messages once, including equal timestamps and deleted cursor documents', async () => {
    const messages = ['a', 'b', 'c', 'd', 'e'].map((messageId, index) => ({
      messageId, roomId: room.roomId, senderId: 'owner', text: messageId,
      createdAt: new Timestamp(1, index < 3 ? 1 : 0),
    }));
    const fake = database({ rooms: [room], messages: [
      ...messages,
      { ...messages[0], messageId: 'other', roomId: 'other-room' },
    ] });

    const first = await listMessages('owner', room.roomId, fake.db, { limit: 2 });
    expect(first.data.map(message => message.messageId)).toEqual(['b', 'c']);
    expect(first.pagination.nextCursor).toEqual(expect.any(String));
    fake.messages.delete('b');

    const next = await listMessages('owner', room.roomId, fake.db,
      messageHistoryQuerySchema.parse({ limit: '2', cursor: first.pagination.nextCursor }));
    expect(next.data.map(message => message.messageId)).toEqual(['e', 'a']);

    const last = await listMessages('owner', room.roomId, fake.db,
      messageHistoryQuerySchema.parse({ limit: '2', cursor: next.pagination.nextCursor }));
    expect(last.data.map(message => message.messageId)).toEqual(['d']);
    expect(last.pagination.nextCursor).toBeNull();
  });

  it('returns an empty page to the owner and denies the same history to other users', async () => {
    const fake = database({ rooms: [room] });
    await expect(listMessages('owner', room.roomId, fake.db)).resolves.toEqual({
      data: [], pagination: { nextCursor: null },
    });
    await expect(listMessages('stranger', room.roomId, fake.db)).rejects.toMatchObject({
      statusCode: 403, code: 'ROOM_ACCESS_DENIED',
    });
  });

  it.each([
    { limit: '0' }, { limit: '101' }, { limit: ['1', '2'] },
    { cursor: 'invalid' }, { cursor: '' },
    { cursor: Buffer.from(JSON.stringify([1, 1e9, 'id'])).toString('base64url') },
  ])('rejects invalid history query %j', query => {
    expect(messageHistoryQuerySchema.safeParse(query).success).toBe(false);
  });

  it('resolves unique authorName per page without exposing private fields or deleted users', async () => {
    const fake = database({
      rooms: [room],
      users: [
        { uid: 'owner', nombre: 'Ana', apellido: 'Pérez', email: 'ana@test.edu', username: 'ana_perez' },
        { uid: 'member', nombre: 'Luis', apellido: 'Gómez', email: 'luis@test.edu', username: 'luis_gomez' },
        { uid: 'deleting', nombre: 'Carlos', apellido: 'Ruiz', email: 'carlos@test.edu', username: 'carlos_ruiz' },
      ],
      deletingUid: 'deleting',
      messages: [
        { messageId: 'm1', roomId: room.roomId, senderId: 'owner', text: 'Uno', createdAt: new Timestamp(1, 0) },
        { messageId: 'm2', roomId: room.roomId, senderId: 'owner', text: 'Dos', createdAt: new Timestamp(2, 0) },
        { messageId: 'm3', roomId: room.roomId, senderId: 'member', text: 'Tres', createdAt: new Timestamp(3, 0) },
        { messageId: 'm4', roomId: room.roomId, senderId: null, authorDeleted: true, text: 'Anónimo', createdAt: new Timestamp(4, 0) },
        { messageId: 'm5', roomId: room.roomId, senderId: 'deleting', text: 'En eliminación', createdAt: new Timestamp(5, 0) },
      ],
    });

    const result = await listMessages('owner', room.roomId, fake.db);
    expect(result.data).toEqual([
      expect.objectContaining({ messageId: 'm1', senderId: 'owner', authorName: 'Ana Pérez' }),
      expect.objectContaining({ messageId: 'm2', senderId: 'owner', authorName: 'Ana Pérez' }),
      expect.objectContaining({ messageId: 'm3', senderId: 'member', authorName: 'Luis Gómez' }),
      expect.objectContaining({ messageId: 'm4', senderId: null, authorDeleted: true, authorName: null }),
      expect.objectContaining({ messageId: 'm5', senderId: 'deleting', authorName: null }),
    ]);
    for (const item of result.data) {
      expect(item).not.toHaveProperty('email');
      expect(item).not.toHaveProperty('username');
    }
    expect((fake.db as unknown as { getAll: ReturnType<typeof vi.fn> }).getAll).toHaveBeenCalledOnce();
  });

});
