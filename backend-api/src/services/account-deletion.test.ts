import request from 'supertest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ getFirebaseAuth: vi.fn(), getFirestoreDb: vi.fn(), verify: vi.fn(), deleteUser: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: config.getFirebaseAuth, getFirestoreDb: config.getFirestoreDb }));
import { app } from '../app';
import { beginAccountDeletion, deleteAccountImmediately } from './account-deletion.service';

const projectId = 'demo-teamspeak-tests';
const uid = 'user-a';
const seconds = 1800000000;
const now = Timestamp.fromMillis(seconds * 1000);
const marker = { status: 'pending', phase: 'auth', usernameKeys: ['ana-user1'], requestedAt: now, updatedAt: now, attempts: 0 };
const profile = { uid, username: 'Ana-User1', usernameKey: 'ana-user1', nombre: 'Ana' };

function database() {
  const data = new Map<string, Record<string, unknown>>([
    [`users/${uid}`, profile],
    ['usernames/ana-user1', { uid, usernameKey: 'ana-user1' }],
    ['rooms/room-1', { roomId: 'room-1', ownerId: uid, name: 'Mi sala' }],
    ['rooms/room-1/members/user-a', { uid, roomId: 'room-1', role: 'host' }],
    ['rooms/room-1/messages/msg-1', { messageId: 'msg-1', roomId: 'room-1', senderId: uid, text: 'hola' }],
  ]);
  const reads: string[] = [];
  const create = vi.fn((ref: { path: string }, value: Record<string, unknown>) => { data.set(ref.path, value); });
  const set = vi.fn((ref: { path: string }, value: Record<string, unknown>) => { data.set(ref.path, value); });
  const del = vi.fn((ref: { path: string }) => { data.delete(ref.path); });
  const docRef = (path: string) => ({
    path,
    id: path.split('/').at(-1)!,
    get: async () => get({ path }),
    collection: (sub: string) => collection(`${path}/${sub}`),
  });
  const get = vi.fn(async (ref: { path?: string; queryCollection?: string; queryUid?: string }) => {
    reads.push(ref.path ?? `query:${ref.queryCollection}:${ref.queryUid}`);
    if (ref.queryCollection === 'usernames') {
      return {
        docs: [...data]
          .filter(([path, value]) => path.startsWith('usernames/') && value.uid === ref.queryUid)
          .map(([path, value]) => ({ id: path.split('/')[1], ref: docRef(path), data: () => value })),
      };
    }
    if (ref.queryCollection === 'rooms') {
      return {
        docs: [...data]
          .filter(([path, value]) => path.startsWith('rooms/') && path.split('/').length === 2 && value.ownerId === ref.queryUid)
          .map(([path, value]) => ({ id: path.split('/')[1], ref: docRef(path), data: () => value })),
      };
    }
    return { exists: data.has(ref.path!), data: () => data.get(ref.path!) };
  });
  const collection = (prefix: string) => ({
    doc: (id: string) => docRef(`${prefix}/${id}`),
    where: (_field: string, _operator: string, queryUid: string) => ({
      queryCollection: prefix,
      queryUid,
      get: () => get({ queryCollection: prefix, queryUid }),
    }),
    get: async () => ({
      docs: [...data]
        .filter(([path]) => path.startsWith(`${prefix}/`) && path.split('/').length === prefix.split('/').length + 1)
        .map(([path, value]) => ({ id: path.split('/').at(-1)!, ref: docRef(path), data: () => value })),
    }),
  });
  const batchDelete = vi.fn((ref: { path: string }) => { data.delete(ref.path); });
  const batch = () => ({ delete: batchDelete, commit: vi.fn(async () => undefined) });
  const db = {
    projectId,
    collection,
    batch,
    runTransaction: vi.fn(async (fn: (tx: { get: typeof get; create: typeof create; set: typeof set; delete: typeof del }) => unknown) => fn({ get, create, set, delete: del })),
  };
  return { db: db as unknown as Firestore, data, reads, create, set, del, get, runTransaction: db.runTransaction };
}

let fake: ReturnType<typeof database>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000);
  for (const [name, value] of Object.entries({ NODE_ENV: 'test', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, DOTENV_CONFIG_PATH: '/dev/null', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })) vi.stubEnv(name, value);
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(name, '');
  fake = database();
  config.getFirestoreDb.mockReturnValue(fake.db);
  config.verify.mockResolvedValue({ uid, auth_time: seconds, iat: seconds });
  config.deleteUser.mockResolvedValue(undefined);
  config.getFirebaseAuth.mockReturnValue({ app: { options: { projectId } }, verifyIdToken: config.verify, deleteUser: config.deleteUser });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const remove = () => request(app).delete('/api/users/me').set('Authorization', 'Bearer synthetic');

describe('US-05 complete account deletion', () => {
  it('deletes Auth user, Firestore profile, username reservations, owned rooms/messages, and marks completed', async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { status: 'deleted' } });
    expect(config.deleteUser).toHaveBeenCalledExactlyOnceWith(uid);
    expect(fake.data.has(`users/${uid}`)).toBe(false);
    expect(fake.data.has('usernames/ana-user1')).toBe(false);
    expect(fake.data.has('rooms/room-1')).toBe(false);
    expect(fake.data.has('rooms/room-1/members/user-a')).toBe(false);
    expect(fake.data.has('rooms/room-1/messages/msg-1')).toBe(false);
    expect(fake.data.get(`accountDeletions/${uid}`)).toMatchObject({ status: 'completed', phase: 'done', usernameKeys: [] });
  });

  it('succeeds even if Auth user is already absent (auth/user-not-found)', async () => {
    config.deleteUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
    const result = await deleteAccountImmediately(uid, fake.db, { deleteUser: config.deleteUser } as unknown as Auth);
    expect(result).toEqual({ status: 'deleted' });
    expect(fake.data.has(`users/${uid}`)).toBe(false);
    expect(fake.data.has('usernames/ana-user1')).toBe(false);
  });

  it('rejects already completed or blocked deletion markers', async () => {
    fake.data.set(`accountDeletions/${uid}`, { ...marker, status: 'completed', phase: 'done', completedAt: now });
    await expect(deleteAccountImmediately(uid, fake.db)).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_DELETED' });
    fake.data.set(`accountDeletions/${uid}`, { ...marker, status: 'blocked' });
    await expect(deleteAccountImmediately(uid, fake.db)).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_DELETION_BLOCKED' });
  });

  it('requires authentication and rejects JSON bodies on HTTP DELETE', async () => {
    expect((await request(app).delete('/api/users/me')).status).toBe(401);
    const withBody = await remove().send({ uid: 'other' });
    expect(withBody.status).toBe(400);
    expect(withBody.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('beginAccountDeletion isolation and deterministic ordering', () => {
  it.each([
    ['NODE_ENV', 'production'], ['TEAMSPEAK_ENABLE_DELETE_TESTS', ''], ['FIREBASE_PROJECT_ID', 'other'],
  ])('disables beginAccountDeletion when %s=%s', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(beginAccountDeletion({ uid, authTime: seconds }, fake.db)).rejects.toMatchObject({ statusCode: 501 });
  });

  it('persists all owned keys in deterministic code-unit order regardless of query order', async () => {
    for (const key of ['zzzzzzzz', 'aaaa_aaa', 'aaaa-aaa']) {
      fake.data.set(`usernames/${key}`, { uid, usernameKey: key });
    }
    await beginAccountDeletion({ uid, authTime: seconds }, fake.db);
    expect(fake.data.get(`accountDeletions/${uid}`)?.usernameKeys)
      .toEqual(['aaaa-aaa', 'aaaa_aaa', 'ana-user1', 'zzzzzzzz']);
    expect(fake.create).toHaveBeenCalledOnce();
  });
});
