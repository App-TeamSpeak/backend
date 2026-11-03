import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkFirestoreConnection,
  getFirestoreCollections,
  getRoomMembersCollection,
  getRoomMessagesCollection,
  getSprint0DemoDocument,
} from './firestore.service';

const getFirestoreDb = vi.hoisted(() => vi.fn());
vi.mock('../config/firebase', () => ({ getFirestoreDb }));

function makeFirestore() {
  const users = {
    select: vi.fn(),
  };
  const rooms = {
    doc: vi.fn(),
  };
  const firestore = {
    collection: vi.fn((name: string) => name === 'users' ? users : rooms),
  };
  return { firestore, users, rooms };
}

describe('Firestore service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes typed top-level collections', () => {
    const { firestore } = makeFirestore();
    const collections = getFirestoreCollections(firestore as never);

    expect(Object.keys(collections)).toEqual(['users', 'usernames', 'rooms']);
    expect(firestore.collection).toHaveBeenCalledWith('users');
    expect(firestore.collection).toHaveBeenCalledWith('usernames');
    expect(firestore.collection).toHaveBeenCalledWith('rooms');
  });

  it('exposes typed room subcollections', () => {
    const members = { collection: vi.fn() };
    const messages = { collection: vi.fn() };
    const roomDoc = { collection: vi.fn((name: string) => name === 'members' ? members : messages) };
    const rooms = { doc: vi.fn(() => roomDoc) };
    const firestore = { collection: vi.fn(() => rooms) };

    expect(getRoomMembersCollection('room-1', firestore as never)).toBe(members);
    expect(getRoomMessagesCollection('room-1', firestore as never)).toBe(messages);
    expect(rooms.doc).toHaveBeenCalledWith('room-1');
    expect(roomDoc.collection).toHaveBeenCalledWith('members');
    expect(roomDoc.collection).toHaveBeenCalledWith('messages');
  });

  it('checks Firestore without reading document contents', async () => {
    const get = vi.fn().mockResolvedValue({});
    const limit = vi.fn(() => ({ get }));
    const select = vi.fn(() => ({ limit }));
    const firestore = { collection: vi.fn(() => ({ select })) };

    await checkFirestoreConnection(firestore as never);

    expect(select).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('uses the configured Firestore client by default', async () => {
    const get = vi.fn().mockResolvedValue({});
    const firestore = { collection: vi.fn(() => ({ select: vi.fn(() => ({ limit: vi.fn(() => ({ get })) })) })) };
    getFirestoreDb.mockReturnValue(firestore);

    await checkFirestoreConnection();

    expect(getFirestoreDb).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads the Sprint 0 verification document and preserves its fields', async () => {
    const data = { estado: 'ok', evidencia: 'real' };
    const get = vi.fn().mockResolvedValue({ exists: true, data: () => data });
    const doc = vi.fn(() => ({ get }));
    const collection = vi.fn(() => ({ doc }));

    await expect(getSprint0DemoDocument({ collection } as never)).resolves.toEqual(data);
    expect(collection).toHaveBeenCalledWith('sprint_prueba');
    expect(doc).toHaveBeenCalledWith('verificacion_sprint0');
  });

  it('returns null when the Sprint 0 verification document does not exist', async () => {
    const firestore = { collection: vi.fn(() => ({ doc: vi.fn(() => ({ get: vi.fn().mockResolvedValue({ exists: false }) })) })) };

    await expect(getSprint0DemoDocument(firestore as never)).resolves.toBeNull();
  });
});
