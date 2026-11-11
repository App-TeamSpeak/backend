import request from 'supertest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ getFirebaseAuth: vi.fn(), getFirestoreDb: vi.fn(), verify: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: config.getFirebaseAuth, getFirestoreDb: config.getFirestoreDb }));
import { app } from '../app';
import { beginAccountDeletion } from './account-deletion.service';
const projectId = 'demo-teamspeak-tests';
const uid = 'user-a';
const seconds = 1800000000;
const now = Timestamp.fromMillis(seconds * 1000);
const marker = { status: 'pending', phase: 'auth', usernameKeys: ['ana-user1'], requestedAt: now, updatedAt: now, attempts: 0 };
const profile = { uid, username: 'Ana-User1', usernameKey: 'ana-user1', nombre: 'Ana' };
function database() {
  const data = new Map<string, Record<string, unknown>>([
    [`users/${uid}`, profile], ['usernames/ana-user1', { uid, usernameKey: 'ana-user1' }],
  ]);
  const reads: string[] = [];
  const create = vi.fn((ref: { path: string }, value: Record<string, unknown>) => { data.set(ref.path, value); });
  const get = vi.fn(async (ref: { path?: string; queryUid?: string }) => {
    reads.push(ref.path ?? `query:${ref.queryUid}`);
    if (ref.queryUid !== undefined) return { docs: [...data].filter(([path, value]) => path.startsWith('usernames/') && value.uid === ref.queryUid).map(([path, value]) => ({ id: path.split('/')[1], data: () => value })) };
    return { exists: data.has(ref.path!), data: () => data.get(ref.path!) };
  });
  const db = {
    projectId,
    collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }), where: (_field: string, _operator: string, queryUid: string) => ({ queryUid }) }),
    runTransaction: vi.fn(async (fn: (tx: { get: typeof get; create: typeof create }) => unknown) => fn({ get, create })),
  };
  return { db: db as unknown as Firestore, data, reads, create, get, runTransaction: db.runTransaction };
}
let fake: ReturnType<typeof database>;
beforeEach(() => {
  vi.resetAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000);
  for (const [name, value] of Object.entries({ NODE_ENV: 'test', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, DOTENV_CONFIG_PATH: '/dev/null', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })) vi.stubEnv(name, value);
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(name, '');
  fake = database(); config.getFirestoreDb.mockReturnValue(fake.db);
  config.verify.mockResolvedValue({ uid, auth_time: seconds, iat: seconds });
  config.getFirebaseAuth.mockReturnValue({ app: { options: { projectId } }, verifyIdToken: config.verify });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const remove = () => request(app).delete('/api/users/me').set('Authorization', 'Bearer synthetic');
describe('DELETE authorization and strict test gating', () => {
  it('verifies revocation and creates only a pending marker for authenticated UID', async () => {
    const before = [...fake.data.entries()];
    const response = await remove().query({ uid: 'other' });
    expect(response.status).toBe(202); expect(response.body).toEqual({ success: true, data: { status: 'pending' } });
    expect(config.verify).toHaveBeenCalledExactlyOnceWith('synthetic', true);
    expect(fake.data.get(`accountDeletions/${uid}`)).toEqual(marker);
    expect(fake.data.has('accountDeletions/other')).toBe(false);
    for (const [key, value] of before) expect(fake.data.get(key)).toEqual(value);
    expect(fake.reads[0]).toBe(`accountDeletions/${uid}`);
    expect(fake.create).toHaveBeenCalledTimes(1);
  });
  it('requires a token', async () => {
    const response = await request(app).delete('/api/users/me');
    expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_REQUIRED'); expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    ['auth/invalid-id-token',401,'AUTH_INVALID'], ['auth/id-token-expired',401,'AUTH_EXPIRED'],
    ['auth/id-token-revoked',401,'AUTH_REVOKED'], ['auth/user-disabled',401,'AUTH_USER_DISABLED'],
    ['auth/user-not-found',401,'AUTH_USER_DELETED'], ['app/network-error',503,'AUTH_UNAVAILABLE'],
    ['auth/internal-error',500,'INTERNAL_ERROR'],
  ])('classifies %s without exposing SDK diagnostics', async (code, status, expected) => {
    config.verify.mockRejectedValueOnce({ code, message: 'PRIVATE_SDK_DETAIL' });
    const response = await remove(); expect(response.status).toBe(status); expect(response.body.code).toBe(expected);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_SDK_DETAIL'); expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([undefined, '1800000000', null, NaN, Infinity, seconds + 1, seconds - 301, seconds - 0.5])('rejects invalid or old auth_time %s despite a fresh iat', async (auth_time) => {
    config.verify.mockResolvedValueOnce({ uid, auth_time, iat: seconds });
    const response = await remove(); expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_RECENT_REQUIRED'); expect(fake.create).not.toHaveBeenCalled();
  });
  it('accepts exactly 300 seconds', async () => {
    config.verify.mockResolvedValueOnce({ uid, auth_time: seconds - 300 }); expect((await remove()).status).toBe(202);
  });
  it.each([{}, { uid: 'other' }, { username: 'Other-User1' }, { password: 'synthetic' }])('rejects all JSON bodies %j', async (input) => {
    const response = await remove().send(input); expect(response.status).toBe(400); expect(response.body.code).toBe('VALIDATION_ERROR'); expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    ['NODE_ENV','production'], ['TEAMSPEAK_ENABLE_DELETE_TESTS',''], ['FIREBASE_PROJECT_ID','other'], ['GCLOUD_PROJECT','other'],
    ['FIRESTORE_EMULATOR_HOST',''], ['FIRESTORE_EMULATOR_HOST','example.invalid:8081'], ['FIREBASE_AUTH_EMULATOR_HOST',''],
    ['FIREBASE_AUTH_EMULATOR_HOST','https://127.0.0.1:9099'], ['DOTENV_CONFIG_PATH','other'], ['FIREBASE_PRIVATE_KEY','synthetic'],
  ])('disables DELETE when %s=%s before touching SDKs', async (name, value) => {
    vi.stubEnv(name, value);
    expect((await remove()).status).toBe(501); expect(config.getFirebaseAuth).not.toHaveBeenCalled(); expect(fake.create).not.toHaveBeenCalled();
    await expect(beginAccountDeletion({ uid, authTime: seconds }, fake.db)).rejects.toMatchObject({ statusCode: 501 });
  });
  it('rejects wrong Auth SDK project even with a safe environment', async () => {
    config.getFirebaseAuth.mockReturnValueOnce({ app: { options: { projectId: 'other' } }, verifyIdToken: config.verify });
    expect((await remove()).status).toBe(501); expect(config.verify).not.toHaveBeenCalled();
  });
  it('rejects wrong Firestore SDK project before any transaction', async () => {
    Object.defineProperty(fake.db, 'projectId', { value: 'other' });
    expect((await remove()).status).toBe(501); expect(fake.runTransaction).not.toHaveBeenCalled();
  });
});
describe('initial intent integrity and idempotency', () => {
  it('reuses a valid pending marker without recent-auth or changing progress', async () => {
    const existing = { ...marker, attempts: 4, phase: 'firestore' };
    fake.data.set(`accountDeletions/${uid}`, existing);
    config.verify.mockResolvedValueOnce({ uid, auth_time: seconds - 1000 });
    expect((await remove()).status).toBe(202); expect(fake.data.get(`accountDeletions/${uid}`)).toEqual(existing); expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...marker, status: 'blocked' }, 'ACCOUNT_DELETION_BLOCKED'],
    [{ ...marker, status: 'completed', phase: 'done', completedAt: now }, 'ACCOUNT_DELETED'],
    [{ status: 'pending' }, 'ACCOUNT_DELETION_INCONSISTENT'],
    [{ ...marker, phase: 'done' }, 'ACCOUNT_DELETION_INCONSISTENT'],
    [{ ...marker, status: 'unknown' }, 'ACCOUNT_DELETION_INCONSISTENT'],
  ])('does not restart incompatible marker %j', async (existing, code) => {
    fake.data.set(`accountDeletions/${uid}`, existing);
    const response = await remove(); expect(response.status).toBe(409); expect(response.body.code).toBe(code); expect(fake.create).not.toHaveBeenCalled();
  });
  it('accepts an incomplete profile identified by its authenticated path', async () => {
    fake.data.set(`users/${uid}`, { nombre: 'Ana' });
    expect((await remove()).status).toBe(202); expect(fake.data.get(`accountDeletions/${uid}`)?.usernameKeys).toEqual(['ana-user1']);
  });
  it('does not fabricate a missing profile and records only owned reservations', async () => {
    fake.data.delete(`users/${uid}`); expect((await remove()).status).toBe(202);
    expect(fake.data.has(`users/${uid}`)).toBe(false); expect(fake.data.get(`accountDeletions/${uid}`)?.usernameKeys).toEqual(['ana-user1']);
  });
  it('does not fabricate a missing reservation', async () => {
    fake.data.delete('usernames/ana-user1'); expect((await remove()).status).toBe(202);
    expect(fake.data.get(`accountDeletions/${uid}`)?.usernameKeys).toEqual([]);
  });
  it.each([
    ['users/user-a', { ...profile, uid: 'other' }],
    ['users/user-a', { ...profile, usernameKey: 'other-user1' }],
    ['usernames/ana-user1', { uid: 'other', usernameKey: 'ana-user1' }],
    ['usernames/ana-user1', { uid, usernameKey: 'wrong-key' }],
  ])('rejects contradictory ownership/data at %s', async (path, value) => {
    fake.data.set(path, value); const before = [...fake.data.entries()];
    const response = await remove(); expect(response.status).toBe(409); expect(response.body.code).toBe('PROFILE_INCONSISTENT');
    expect([...fake.data.entries()]).toEqual(before); expect(fake.create).not.toHaveBeenCalled();
  });
  it('classifies Firestore failures without returning accepted', async () => {
    fake.get.mockRejectedValueOnce({ code: 14 });
    const response = await remove(); expect(response.status).toBe(503); expect(response.body.code).toBe('FIRESTORE_UNAVAILABLE'); expect(fake.create).not.toHaveBeenCalled();
  });
  it('does not reuse a pending marker that references a foreign reservation', async () => {
    fake.data.set(`accountDeletions/${uid}`, marker);
    fake.data.set('usernames/ana-user1', { uid: 'other', usernameKey: 'ana-user1' });
    const before = [...fake.data.entries()];
    const response = await remove(); expect(response.status).toBe(409); expect(response.body.code).toBe('PROFILE_INCONSISTENT');
    expect([...fake.data.entries()]).toEqual(before); expect(fake.create).not.toHaveBeenCalled();
  });

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
