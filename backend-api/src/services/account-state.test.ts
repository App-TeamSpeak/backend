import request from 'supertest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ getFirestoreDb: vi.fn(), verifyIdToken: vi.fn(), getFirebaseAuth: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirestoreDb: config.getFirestoreDb, getFirebaseAuth: config.getFirebaseAuth }));
import { app } from '../app';
import { assertNoAccountDeletion, ensureAccountActive } from './account-state.service';
import { createUserProfile, getUserProfile, updateUserProfile } from './users.service';
import { userBodySchema } from '../validators/user.validator';
const uid = 'user-a';
const identity = { uid, email: 'ana@example.com' };
const body = userBodySchema.parse({ nombre: 'Ana', apellido: 'Pérez', username: 'Ana-User1' });
const profile = { ...identity, ...body, usernameKey: 'ana-user1', profileStatus: 'complete', createdAt: Timestamp.fromMillis(1000), updatedAt: Timestamp.fromMillis(2000) };
function database(marker?: unknown) {
  const data = new Map<string, unknown>([['users/user-a', profile], ['usernames/ana-user1', { uid, usernameKey: 'ana-user1' }]]);
  if (marker !== undefined) data.set(`accountDeletions/${uid}`, marker);
  const reads: string[] = [];
  const get = vi.fn(async (path: string) => { reads.push(path); return { exists: data.has(path), data: () => data.get(path) }; });
  const ref = (path: string) => ({ path, get: () => get(path), onSnapshot: (next: (value: unknown) => void, error: (value: unknown) => void) => { let live = true; void get(path).then(value => { if (live) next(value); }, reason => { if (live) error(reason); }); return () => { live = false; }; } });
  const tx = { get: (reference: ReturnType<typeof ref>) => reference.get(), create: vi.fn(), set: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const db = { collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }), runTransaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx) };
  return { db: db as unknown as Firestore, data, reads, get, tx };
}
function noWrites(fake: ReturnType<typeof database>) {
  for (const write of [fake.tx.create, fake.tx.set, fake.tx.update, fake.tx.delete]) expect(write).not.toHaveBeenCalled();
}
const states = [
  ['pending', 'ACCOUNT_DELETION_PENDING'], ['completed', 'ACCOUNT_DELETED'], ['blocked', 'ACCOUNT_DELETION_BLOCKED'],
] as const;
describe('persistent account access controls', () => {
  it('allows an absent marker regardless of profile completeness', async () => {
    const fake = database(); fake.data.delete(`users/${uid}`);
    await expect(ensureAccountActive(uid, fake.db)).resolves.toBeUndefined();
  });
  it.each(states)('rejects %s in GET, POST and PATCH without writes', async (status, code) => {
    const fake = database({ status });
    for (const operation of [() => getUserProfile(identity, fake.db), () => createUserProfile(identity, body, fake.db), () => updateUserProfile(identity, { username: 'Ana-User2' }, fake.db)]) {
      await expect(operation()).rejects.toMatchObject({ statusCode: 403, code });
    }
    expect(fake.reads.every((path) => path === `accountDeletions/${uid}`)).toBe(true);
    noWrites(fake);
  });
  it.each([{}, null, { status: 'unknown' }])('fails closed for malformed markers: %j', (data) => {
    expect(() => assertNoAccountDeletion({ exists: true, data: () => data })).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
  it('reads the marker before any POST write, and preserves active POST behavior', async () => {
    const fake = database(); fake.data.delete(`users/${uid}`); fake.data.delete('usernames/ana-user1');
    expect((await createUserProfile(identity, body, fake.db)).created).toBe(true);
    expect(fake.reads[0]).toBe(`accountDeletions/${uid}`);
    expect(fake.tx.create).toHaveBeenCalledTimes(2);
  });
  it('preserves active PATCH and its reservation behavior', async () => {
    const fake = database();
    await updateUserProfile(identity, { username: 'Ana-User2' }, fake.db);
    expect(fake.reads[0]).toBe(`accountDeletions/${uid}`);
    expect(fake.tx.create).toHaveBeenCalledTimes(1); expect(fake.tx.delete).toHaveBeenCalledTimes(1);
  });
  it('maps known read failure to 503 and never returns authorized', async () => {
    const fake = database(); fake.get.mockRejectedValue({ code: 14 });
    await expect(ensureAccountActive(uid, fake.db)).rejects.toMatchObject({ statusCode: 503, code: 'FIRESTORE_UNAVAILABLE' }); noWrites(fake);
  });
  it('does not hide an unknown read failure as authorized', async () => {
    const fake = database(); fake.get.mockRejectedValue(new TypeError('private'));
    await expect(ensureAccountActive(uid, fake.db)).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });
});
describe('HTTP active-account guard with real middleware and services', () => {
  beforeEach(() => {
    vi.clearAllMocks(); config.verifyIdToken.mockResolvedValue(identity);
    config.getFirebaseAuth.mockReturnValue({ verifyIdToken: config.verifyIdToken });
  });
  it('allows an authenticated active user to consult its profile', async () => {
    config.getFirestoreDb.mockReturnValue(database().db);
    const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer synthetic');
    expect(response.status).toBe(200); expect(response.body.data.profile.uid).toBe(uid);
  });
  it.each(states)('blocks %s on GET, POST, PATCH and other private routes', async (status, code) => {
    const fake = database({ status, lastErrorCode: 'PRIVATE_DIAGNOSTIC' }); config.getFirestoreDb.mockReturnValue(fake.db);
    for (const method of ['get', 'post', 'patch'] as const) {
      const response = await request(app)[method]('/api/users/me').set('Authorization', 'Bearer synthetic').send(method === 'get' ? undefined : { nombre: 'Nueva' });
      expect(response.status).toBe(403); expect(response.body.code).toBe(code);
      expect(response.body).not.toHaveProperty('data'); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DIAGNOSTIC');
    }
    expect((await request(app).get('/api/rooms').set('Authorization', 'Bearer synthetic')).status).toBe(403);
    expect(fake.reads.every((path) => path === `accountDeletions/${uid}`)).toBe(true); noWrites(fake);
  });
  it('derives ownership solely from token and never reads another marker', async () => {
    const fake = database(); fake.data.set('accountDeletions/other', { status: 'pending' }); config.getFirestoreDb.mockReturnValue(fake.db);
    const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer synthetic').query({ uid: 'other' });
    expect(response.status).toBe(200); expect(response.body.data.uid).toBe(uid);
    expect(fake.reads).not.toContain('accountDeletions/other');
  });
  it('fails closed on Firestore unavailability in the private guard', async () => {
    const fake = database(); fake.get.mockRejectedValue({ code: 14 }); config.getFirestoreDb.mockReturnValue(fake.db);
    const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer synthetic');
    expect(response.status).toBe(503); expect(response.body.code).toBe('FIRESTORE_UNAVAILABLE'); noWrites(fake);
  });
  it('authenticates before querying account state', async () => {
    const response = await request(app).get('/api/users/me');
    expect(response.status).toBe(401); expect(config.getFirestoreDb).not.toHaveBeenCalled();
  });
});
