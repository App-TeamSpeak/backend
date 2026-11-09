import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import { updateUserProfile } from './users.service';
const identity = { uid: 'uid-1', email: 'ana@example.com' };
const profile = { ...identity, nombre: 'Ana', apellido: 'Pérez', username: 'Ana-User1', usernameKey: 'ana-user1', avatarUrl: 'https://example.com/avatar.png', profileStatus: 'complete', createdAt: Timestamp.fromMillis(1000), updatedAt: Timestamp.fromMillis(2000) };
function database(user: unknown = profile, reservations: Record<string, unknown> = { 'ana-user1': { uid: identity.uid, usernameKey: 'ana-user1' } }) {
  const ref = (collection: string, id: string) => ({ collection, id });
  const get = vi.fn(async (reference: ReturnType<typeof ref>) => {
    const value = reference.collection === 'users' ? user : reservations[reference.id];
    return { exists: value !== null && value !== undefined, data: () => value };
  });
  const tx = { get, create: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const runTransaction = vi.fn(async (fn: (transaction: typeof tx) => unknown) => fn(tx));
  const db = { collection: (name: string) => ({ doc: (id: string) => ref(name, id) }), runTransaction };
  return { db: db as unknown as Firestore, tx, runTransaction };
}
function noWrites(tx: ReturnType<typeof database>['tx']) {
  expect(tx.create).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
}
describe('partial profile updates', () => {
  it.each([{ nombre: ' Ana María ' }, { apellido: ' García ' }, { avatarUrl: ' https://example.com/new.png ' }, { avatarUrl: null }])('updates only requested fields: %j', async (patch) => {
    const { db, tx } = database();
    const result = await updateUserProfile(identity, patch, db);
    expect(result.profile.createdAt).toBe(profile.createdAt.toDate().toISOString());
    expect(result.profile.updatedAt).not.toBe(profile.updatedAt.toDate().toISOString());
    expect(result.profile).toMatchObject({ uid: identity.uid, email: profile.email, username: profile.username });
    const changes = tx.update.mock.calls[0][1];
    expect(Object.keys(changes).sort()).toEqual([...Object.keys(patch), 'updatedAt'].sort());
    expect(result.profile.avatarUrl).toBe('avatarUrl' in patch ? patch.avatarUrl?.trim() ?? null : profile.avatarUrl);
    expect(tx.create).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
  });
  it('moves the reservation and changes the profile in one transaction after all reads', async () => {
    const { db, tx } = database();
    const result = await updateUserProfile(identity, { username: ' Ana-User2 ', nombre: 'Ana María' }, db);
    expect(result.profile).toMatchObject({ username: 'Ana-User2', usernameKey: 'ana-user2', nombre: 'Ana María' });
    expect(tx.create).toHaveBeenCalledWith({ collection: 'usernames', id: 'ana-user2' }, { uid: identity.uid, usernameKey: 'ana-user2' });
    expect(tx.delete).toHaveBeenCalledWith({ collection: 'usernames', id: 'ana-user1' });
    expect(tx.get.mock.invocationCallOrder.at(-1)).toBeLessThan(tx.create.mock.invocationCallOrder[0]);
  });
  it('changes visible casing without touching reservations', async () => {
    const { db, tx } = database();
    expect((await updateUserProfile(identity, { username: 'ANA-USER1' }, db)).profile.usernameKey).toBe('ana-user1');
    expect(tx.update.mock.calls[0][1]).toMatchObject({ username: 'ANA-USER1' });
    expect(tx.create).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
  });
  it.each([{ nombre: ' Ana ' }, { username: ' Ana-User1 ' }, { avatarUrl: profile.avatarUrl }])('skips all writes for equivalent values %j', async (patch) => {
    const { db, tx } = database();
    const result = await updateUserProfile(identity, patch, db);
    expect(result.profile.updatedAt).toBe(profile.updatedAt.toDate().toISOString()); noWrites(tx);
  });
  it('preserves persisted email even when identity has another email', async () => {
    const { db } = database();
    expect((await updateUserProfile({ uid: identity.uid, email: 'new@example.com' }, { nombre: 'Nueva' }, db)).profile.email).toBe(profile.email);
  });
  it.each([
    [null, {}, 'PROFILE_NOT_FOUND', 404],
    [{ uid: identity.uid, nombre: 'Ana' }, {}, 'PROFILE_INCOMPLETE', 409],
    [{ ...profile, uid: 'other' }, {}, 'PROFILE_INCONSISTENT', 409],
    [profile, {}, 'PROFILE_INCONSISTENT', 409],
    [profile, { 'ana-user1': { uid: 'other', usernameKey: 'ana-user1' } }, 'PROFILE_INCONSISTENT', 409],
    [profile, { 'ana-user1': { uid: identity.uid, usernameKey: 'wrong-key' } }, 'PROFILE_INCONSISTENT', 409],
  ])('rejects unavailable or inconsistent profiles (%s)', async (user, reservations, code, statusCode) => {
    const { db, tx } = database(user, reservations);
    await expect(updateUserProfile(identity, { nombre: 'Nueva' }, db)).rejects.toMatchObject({ code, statusCode }); noWrites(tx);
  });
  it.each([
    [{ uid: 'other', usernameKey: 'ana-user2' }, 'USERNAME_TAKEN'],
    [{ uid: identity.uid, usernameKey: 'ana-user2' }, 'PROFILE_INCONSISTENT'],
    [{ uid: 'other', usernameKey: 'wrong-key' }, 'PROFILE_INCONSISTENT'],
  ])('rejects conflicting target reservation: %s', async (target, code) => {
    const { db, tx } = database(profile, { 'ana-user1': { uid: identity.uid, usernameKey: 'ana-user1' }, 'ana-user2': target });
    await expect(updateUserProfile(identity, { username: 'Ana-User2' }, db)).rejects.toMatchObject({ code }); noWrites(tx);
  });
  it.each([[14, 503, 'FIRESTORE_UNAVAILABLE'], [undefined, 500, 'INTERNAL_ERROR']] as const)('maps transaction failure safely (%s)', async (code, statusCode, expected) => {
    const { db, runTransaction } = database(); runTransaction.mockRejectedValueOnce(Object.assign(new Error('private diagnostic'), { code }));
    await expect(updateUserProfile(identity, { nombre: 'Nueva' }, db)).rejects.toMatchObject({ statusCode, code: expected });
  });
});
