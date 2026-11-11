import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import { createUserProfile, getUserProfile } from './users.service';
import { userBodySchema } from '../validators/user.validator';

const identity = { uid: 'uid-1', email: 'ana@example.com' };
const body = userBodySchema.parse({ nombre: 'Ana', apellido: 'Pérez', username: 'ana_user1' });
const profile = { ...identity, ...body, usernameKey: body.username, profileStatus: 'complete', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
function database(user?: unknown, reservation?: unknown) {
  const create = vi.fn();
  const set = vi.fn();
  const get = vi.fn(async (ref: string) => ({ exists: (ref === 'users' ? user : reservation) !== undefined, data: () => ref === 'users' ? user : reservation }));
  const transaction = { get, create, set };
  const runTransaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(transaction));
  const doc = vi.fn((name: string, id: string) => ({ name, id, get: async () => ({ exists: name !== 'accountDeletions' && user !== undefined, data: () => name === 'accountDeletions' ? undefined : user }), onSnapshot: (next: (value: unknown) => void) => { queueMicrotask(() => next({ exists: name !== 'accountDeletions' && user !== undefined, data: () => name === 'accountDeletions' ? undefined : user })); return () => undefined; } }));
  const db = { collection: (name: string) => ({ doc: (id: string) => doc(name, id) }), runTransaction };
  get.mockImplementation(async (ref) => { const name = (ref as unknown as { name: string }).name; const data = name === 'accountDeletions' ? undefined : name === 'users' ? user : reservation; return { exists: data !== undefined, data: () => data }; });
  return { db: db as unknown as Firestore, create, get, runTransaction, doc, set };
}

describe('user profiles service (mock transactions, not a concurrency integration test)', () => {
  it('creates both documents after reads and uses authenticated ownership', async () => {
    const fake = database();
    const result = await createUserProfile(identity, body, fake.db);
    expect(result.created).toBe(true);
    expect(result.data.profile).toMatchObject({ uid: identity.uid, email: identity.email, username: 'ana_user1' });
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(fake.create.mock.calls[0][1]).toEqual({ uid: identity.uid, usernameKey: 'ana_user1' });
    expect(fake.get.mock.invocationCallOrder[1]).toBeLessThan(fake.create.mock.invocationCallOrder[0]);
  });
  it('reserves lowercase keys while preserving display spelling', async () => {
    const fake = database();
    const result = await createUserProfile(identity, { ...body, username: 'Ana-User1' }, fake.db);
    expect(fake.doc).toHaveBeenCalledWith('usernames', 'ana-user1');
    expect(result.data.profile).toMatchObject({ username: 'Ana-User1', usernameKey: 'ana-user1' });
  });
  it('rejects case variants owned by another UID', async () => {
    const fake = database(undefined, { uid: 'other', usernameKey: 'ana-user1' });
    await expect(createUserProfile(identity, { ...body, username: 'ANA-USER1' }, fake.db)).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(fake.doc).toHaveBeenCalledWith('usernames', 'ana-user1');
    expect(fake.create).not.toHaveBeenCalled();
  });
  it('returns a complete profile with ISO timestamps and strips extra fields', async () => {
    const result = await getUserProfile(identity, database({ ...profile, secret: 'private' }).db);
    expect(result.profileStatus).toBe('complete');
    expect(result.profile?.createdAt).toBe(profile.createdAt.toDate().toISOString());
    expect(result.profile).not.toHaveProperty('secret');
  });
  it.each([undefined, { uid: 'uid-1', nombre: 'Ana' }])('reports absent or incomplete profile without rejecting identity', async (user) => {
    expect(await getUserProfile(identity, database(user).db)).toEqual({ uid: identity.uid, profileStatus: 'incomplete', profile: null });
  });
  it('rejects an occupied username without scheduling writes', async () => {
    const fake = database(undefined, { uid: 'other', usernameKey: body.username });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ statusCode: 409, code: 'USERNAME_TAKEN' });
    expect(fake.create).not.toHaveBeenCalled();
  });
  it('retries identical data without writes or timestamp changes', async () => {
    const fake = database(profile, { uid: identity.uid, usernameKey: body.username });
    const result = await createUserProfile(identity, body, fake.db);
    expect(result.created).toBe(false);
    expect(result.data.profile.createdAt).toBe(profile.createdAt.toDate().toISOString());
    expect(fake.create).not.toHaveBeenCalled();
  });
  it('does not update a previously registered profile', async () => {
    const fake = database(profile, { uid: identity.uid, usernameKey: body.username });
    await expect(createUserProfile(identity, { ...body, nombre: 'Otra' }, fake.db)).rejects.toMatchObject({ code: 'PROFILE_ALREADY_EXISTS' });
    expect(fake.create).not.toHaveBeenCalled();
  });
  it('requires an authenticated email', async () => {
    await expect(createUserProfile({ uid: 'uid-1' }, body, database().db)).rejects.toMatchObject({ code: 'AUTH_EMAIL_REQUIRED' });
  });
  it('maps transaction failures to a controlled error', async () => {
    const fake = database(); fake.runTransaction.mockRejectedValueOnce(Object.assign(new Error('internal details'), { code: 14 }));
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ statusCode: 503, code: 'FIRESTORE_UNAVAILABLE' });
  });
  it('propagates commit failure without attempting compensating writes', async () => {
    const fake = database();
    fake.runTransaction.mockImplementationOnce(async (callback) => { await callback({ get: fake.get, create: fake.create }); throw Object.assign(new Error('commit failed'), { code: 10 }); });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
    expect(fake.create).toHaveBeenCalledTimes(2);
  });
  it('maps read failures to 503', async () => {
    const db = { collection: () => ({ doc: () => ({ onSnapshot: (_next: unknown, error: (value: unknown) => void) => { queueMicrotask(() => error({ code: 14 })); return () => undefined; } }) }) };
    await expect(getUserProfile(identity, db as unknown as Firestore)).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
  });
  it('completes missing fields and preserves existing creation date and data', async () => {
    const fake = database({ uid: identity.uid, profileStatus: 'incomplete', nombre: body.nombre, createdAt: profile.createdAt, extra: 'preserve' });
    const result = await createUserProfile(identity, body, fake.db);
    expect(result.created).toBe(false);
    expect(result.data.profile.createdAt).toBe(profile.createdAt.toDate().toISOString());
    expect(fake.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nombre: body.nombre, usernameKey: body.username }), { merge: true });
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.get.mock.invocationCallOrder.at(-1)).toBeLessThan(fake.set.mock.invocationCallOrder[0]);
  });
  it('reuses its existing valid reservation during recovery', async () => {
    const fake = database({ uid: identity.uid, username: body.username }, { uid: identity.uid, usernameKey: body.username });
    await createUserProfile(identity, body, fake.db);
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.set).toHaveBeenCalledTimes(1);
  });
  it.each([
    { uid: 'other' }, { avatarUrl: 'not-a-url' }, { createdAt: 'invalid' },
    { username: body.username, usernameKey: 'different1' }, { nombre: 'Different' },
  ])('rejects inconsistent recovery without writes %j', async (partial) => {
    const fake = database(partial);
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.set).not.toHaveBeenCalled();
  });
  it('rejects a contradictory previous reservation', async () => {
    const fake = database({ username: body.username }, { uid: 'other', usernameKey: body.username });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
    expect(fake.set).not.toHaveBeenCalled();
  });
  it('rejects an occupied new username while recovering', async () => {
    const fake = database({ nombre: body.nombre }, { uid: 'other', usernameKey: body.username });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(fake.set).not.toHaveBeenCalled();
  });
  it('classifies malformed stored avatar as inconsistent, not unavailable', async () => {
    await expect(getUserProfile(identity, database({ ...profile, avatarUrl: 'not-a-url' }).db)).rejects.toMatchObject({ statusCode: 409, code: 'PROFILE_INCONSISTENT' });
  });
  it('classifies unexpected programming errors as internal', async () => {
    const fake = database(); fake.runTransaction.mockRejectedValueOnce(new TypeError('private diagnostic'));
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' });
  });
  it('does not classify permission errors as transient availability', async () => {
    const fake = database(); fake.runTransaction.mockRejectedValueOnce({ code: 7 });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('replays a recovered profile idempotently after a lost response', async () => {
    const recovered = { ...profile, profileStatus: 'complete' };
    const fake = database(recovered, { uid: identity.uid, usernameKey: body.username });
    const normalized = userBodySchema.parse({ ...body, nombre: ' Ana ', username: ' ana_user1 ', avatarUrl: undefined });
    const result = await createUserProfile(identity, normalized, fake.db);
    expect(result.created).toBe(false); expect(fake.set).not.toHaveBeenCalled(); expect(fake.create).not.toHaveBeenCalled();
  });
  it('reads the old reservation before rejecting a changed username during recovery', async () => {
    const fake = database({ username: 'old-user1', usernameKey: 'old-user1' });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
    expect(fake.doc).toHaveBeenCalledWith('usernames', 'old-user1');
    expect(fake.set).not.toHaveBeenCalled(); expect(fake.create).not.toHaveBeenCalled();
  });
  it('refuses a reservation without its profile', async () => {
    const fake = database(undefined, { uid: identity.uid, usernameKey: body.username });
    await expect(createUserProfile(identity, body, fake.db)).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
    expect(fake.create).not.toHaveBeenCalled();
  });

});
