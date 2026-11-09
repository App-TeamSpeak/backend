import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createUserProfile, getUserProfile, updateUserProfile } from '../services/users.service';
import { userBodySchema } from '../validators/user.validator';

const project = 'demo-teamspeak-tests';
// setup.integration.ts validates this value before this module is imported.
const origin = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const app = initializeApp({ projectId: project }, 'teamspeak-integration');
const db = getFirestore(app);
const identity = (uid: string) => ({ uid, email: `${uid}@example.com` });
const body = (username = 'Ana-User1') => userBodySchema.parse({ nombre: 'Ana', apellido: 'Pérez', username });
async function documents() {
  const [users, usernames] = await Promise.all([db.collection('users').get(), db.collection('usernames').get()]);
  return {
    users: users.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    usernames: usernames.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}
function failure(results: PromiseSettledResult<unknown>[]) {
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(rejected).toHaveLength(1);
  return (rejected[0] as PromiseRejectedResult).reason;
}
describe('real Firestore Emulator user persistence', () => {
  beforeAll(async () => {
    expect(app.options.projectId).toBe(project);
    // No SDK operation until a bounded local probe succeeds.
    const response = await fetch(`${origin}/v1/projects/${project}/databases/(default)/documents/users?pageSize=1`, { headers: { Authorization: 'Bearer owner' }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Local emulator probe failed: ${response.status}`);
  });
  beforeEach(async () => {
    const response = await fetch(`${origin}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unable to reset demo emulator database.');
  });
  afterAll(async () => { await db.terminate(); await deleteApp(app); });

  it('A: persists the profile and its reservation with server SDK timestamps', async () => {
    const result = await createUserProfile(identity('user-a'), body(), db);
    expect(result.created).toBe(true);
    const user = (await db.doc('users/user-a').get()).data();
    expect(user).toMatchObject({ ...identity('user-a'), ...body(), usernameKey: 'ana-user1', profileStatus: 'complete' });
    expect(user?.createdAt).toBeInstanceOf(Timestamp);
    expect((await db.doc('usernames/ana-user1').get()).data()).toEqual({ uid: 'user-a', usernameKey: 'ana-user1' });
    expect((await getUserProfile(identity('user-a'), db)).profileStatus).toBe('complete');
  });
  it.each([['B: identical username', 'Ana-User1'], ['C: case variant', 'ANA-USER1']])('%s has exactly one winner', async (_label, second) => {
    const results = await Promise.allSettled([
      createUserProfile(identity('user-a'), body(), db),
      createUserProfile(identity('user-b'), body(second), db),
    ]);
    expect(failure(results)).toMatchObject({ statusCode: 409, code: 'USERNAME_TAKEN' });
    const persisted = await documents();
    expect(persisted.users).toHaveLength(1); expect(persisted.usernames).toHaveLength(1);
    expect(persisted.usernames[0]).toMatchObject({ id: 'ana-user1', uid: persisted.users[0].id });
    const loser = persisted.users[0].id === 'user-a' ? 'user-b' : 'user-a';
    expect((await db.doc(`users/${loser}`).get()).exists).toBe(false);
  });
  it('D: concurrent identical operations for one UID are idempotent', async () => {
    const results = await Promise.all([
      createUserProfile(identity('user-a'), body(), db), createUserProfile(identity('user-a'), body(), db),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].data).toEqual(results[1].data);
    const persisted = await documents(); expect(persisted.users).toHaveLength(1); expect(persisted.usernames).toHaveLength(1);
  });
  it('D: concurrent different usernames for one UID leave no orphan', async () => {
    const results = await Promise.allSettled([
      createUserProfile(identity('user-a'), body(), db), createUserProfile(identity('user-a'), body('Other-User1'), db),
    ]);
    expect(failure(results)).toMatchObject({ statusCode: 409, code: 'PROFILE_ALREADY_EXISTS' });
    const persisted = await documents(); expect(persisted.users).toHaveLength(1); expect(persisted.usernames).toHaveLength(1);
    const user = (await db.doc('users/user-a').get()).data();
    expect(persisted.usernames[0]).toMatchObject({ id: user?.usernameKey, uid: 'user-a' });
  });
  it('E: repeat after a lost response preserves dates and document counts', async () => {
    const first = await createUserProfile(identity('user-a'), body(), db);
    const before = await documents();
    const repeat = await createUserProfile(identity('user-a'), body(), db);
    expect(repeat.created).toBe(false); expect(repeat.data).toEqual(first.data);
    expect(await documents()).toEqual(before);
  });
  it('F: real SDK commit precondition failure rolls back all writes', async () => {
    const ref = db.doc('usernames/ana-user1');
    await ref.create({ uid: 'other', usernameKey: 'ana-user1' });
    const before = await documents();
    // Both writes reach the actual SDK transaction. The emulator rejects create-on-existing at commit.
    await expect(db.runTransaction(async (tx) => {
      tx.create(db.doc('users/user-a'), { uid: 'user-a' });
      tx.create(ref, { uid: 'user-a', usernameKey: 'ana-user1' });
    }, { maxAttempts: 1 })).rejects.toMatchObject({ code: 6 });
    expect(await documents()).toEqual(before);
    expect((await db.doc('users/user-a').get()).exists).toBe(false);
  });
  it('F: application conflict rejects before scheduling persistent changes', async () => {
    await db.doc('usernames/ana-user1').create({ uid: 'other', usernameKey: 'ana-user1' });
    const before = await documents();
    await expect(createUserProfile(identity('user-a'), body(), db)).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(await documents()).toEqual(before);
  });
  it.each([false, true])('G: recovers missing fields with existing reservation=%s', async (reserved) => {
    const createdAt = Timestamp.fromMillis(1000);
    const updatedAt = Timestamp.fromMillis(2000);
    await db.doc('users/user-a').create({ uid: 'user-a', nombre: 'Ana', username: 'Ana-User1', profileStatus: 'incomplete', createdAt, updatedAt, extra: 'preserved' });
    if (reserved) await db.doc('usernames/ana-user1').create({ uid: 'user-a', usernameKey: 'ana-user1' });
    const result = await createUserProfile(identity('user-a'), body(), db);
    expect(result.created).toBe(false);
    const user = (await db.doc('users/user-a').get()).data();
    expect(user).toMatchObject({ ...body(), uid: 'user-a', profileStatus: 'complete', extra: 'preserved', createdAt });
    expect(user?.updatedAt.toMillis()).toBeGreaterThan(updatedAt.toMillis());
    expect((await getUserProfile(identity('user-a'), db)).profileStatus).toBe('complete');
    const persisted = await documents(); expect(persisted.usernames).toHaveLength(1);
    expect(persisted.usernames[0]).toMatchObject({ uid: 'user-a', id: 'ana-user1' });
  });
  it('H: contradictory reservation preserves all documents', async () => {
    await db.doc('users/user-a').create({ uid: 'user-a', username: 'Ana-User1' });
    await db.doc('usernames/ana-user1').create({ uid: 'other', usernameKey: 'ana-user1' });
    const before = await documents();
    await expect(createUserProfile(identity('user-a'), body(), db)).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
    expect(await documents()).toEqual(before);
  });

  it('PATCH: updates simple fields, preserves omitted avatar and creation date', async () => {
    const first = await createUserProfile(identity('user-a'), { ...body(), avatarUrl: 'https://example.com/a.png' }, db);
    const updated = await updateUserProfile(identity('user-a'), { nombre: ' Ana María ', apellido: 'García' }, db);
    expect(updated.profile).toMatchObject({ nombre: 'Ana María', apellido: 'García', avatarUrl: first.data.profile.avatarUrl, createdAt: first.data.profile.createdAt });
    expect(updated.profile.updatedAt).not.toBe(first.data.profile.updatedAt);
    expect((await db.doc('usernames/ana-user1').get()).data()).toEqual({ uid: 'user-a', usernameKey: 'ana-user1' });
    await updateUserProfile(identity('user-a'), { avatarUrl: null }, db);
    expect((await db.doc('users/user-a').get()).data()?.avatarUrl).toBeNull();
  });
  it('PATCH: atomically renames and releases the old reservation', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    const result = await updateUserProfile(identity('user-a'), { username: 'Ana-User2' }, db);
    expect(result.profile).toMatchObject({ username: 'Ana-User2', usernameKey: 'ana-user2' });
    expect((await db.doc('usernames/ana-user1').get()).exists).toBe(false);
    expect((await db.doc('usernames/ana-user2').get()).data()).toEqual({ uid: 'user-a', usernameKey: 'ana-user2' });
    expect((await documents()).usernames).toHaveLength(1);
    await createUserProfile(identity('user-b'), body(), db);
    expect((await db.doc('usernames/ana-user1').get()).data()?.uid).toBe('user-b');
  });
  it('PATCH: casing-only update retains the reservation document', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    const before = await db.doc('usernames/ana-user1').get();
    await updateUserProfile(identity('user-a'), { username: 'ANA-USER1' }, db);
    const after = await db.doc('usernames/ana-user1').get();
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect((await db.doc('users/user-a').get()).data()?.username).toBe('ANA-USER1');
    expect((await documents()).usernames).toHaveLength(1);
  });
  it('PATCH: occupied username preserves profile, dates and both reservations', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await createUserProfile(identity('user-b'), body('Other-User1'), db);
    const before = await documents();
    await expect(updateUserProfile(identity('user-a'), { username: 'OTHER-USER1', nombre: 'Nueva' }, db)).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(await documents()).toEqual(before);
  });
  it('PATCH: normalized retry leaves document update times unchanged', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await updateUserProfile(identity('user-a'), { username: 'Ana-User2' }, db);
    const before = await db.doc('users/user-a').get();
    const reservation = await db.doc('usernames/ana-user2').get();
    await updateUserProfile(identity('user-a'), { username: ' Ana-User2 ', nombre: ' Ana ', avatarUrl: null }, db);
    const after = await db.doc('users/user-a').get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect((await db.doc('usernames/ana-user2').get()).updateTime?.isEqual(reservation.updateTime!)).toBe(true);
  });
  it('PATCH: concurrent independent fields on same UID do not lose changes', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await Promise.all([
      updateUserProfile(identity('user-a'), { nombre: 'Ana María' }, db),
      updateUserProfile(identity('user-a'), { apellido: 'García' }, db),
    ]);
    expect((await db.doc('users/user-a').get()).data()).toMatchObject({ nombre: 'Ana María', apellido: 'García' });
    expect((await documents()).usernames).toHaveLength(1);
  });
  it('PATCH: simultaneous renames of same UID leave exactly its final reservation', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await Promise.all([
      updateUserProfile(identity('user-a'), { username: 'Ana-User2' }, db),
      updateUserProfile(identity('user-a'), { username: 'Ana-User3' }, db),
    ]);
    const user = (await db.doc('users/user-a').get()).data();
    expect((await documents()).usernames).toEqual([{ id: user?.usernameKey, uid: 'user-a', usernameKey: user?.usernameKey }]);
  });
  it('PATCH: two UID compete for one new username with a single winner', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await createUserProfile(identity('user-b'), body('Other-User1'), db);
    const results = await Promise.allSettled([
      updateUserProfile(identity('user-a'), { username: 'Shared-User1' }, db),
      updateUserProfile(identity('user-b'), { username: 'SHARED-USER1' }, db),
    ]);
    expect(failure(results)).toMatchObject({ code: 'USERNAME_TAKEN' });
    const users = await db.collection('users').get();
    expect((await documents()).usernames).toHaveLength(2);
    for (const user of users.docs) {
      expect((await db.doc(`usernames/${user.data().usernameKey}`).get()).data()?.uid).toBe(user.id);
    }
  });
  it('PATCH: renaming while another UID claims the old key preserves ownership', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    const results = await Promise.allSettled([
      updateUserProfile(identity('user-a'), { username: 'Ana-User2' }, db),
      createUserProfile(identity('user-b'), body(), db),
    ]);
    expect(results[0].status).toBe('fulfilled');
    if (results[1].status === 'rejected') {
      expect(results[1].reason).toMatchObject({ code: 'USERNAME_TAKEN' });
      await createUserProfile(identity('user-b'), body(), db);
    }
    expect((await db.doc('usernames/ana-user1').get()).data()?.uid).toBe('user-b');
    expect((await db.doc('usernames/ana-user2').get()).data()?.uid).toBe('user-a');
    expect((await documents()).usernames).toHaveLength(2);
  });
  it('PATCH: inconsistent current reservation is never repaired implicitly', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await db.doc('usernames/ana-user1').update({ uid: 'other' });
    const before = await documents();
    await expect(updateUserProfile(identity('user-a'), { nombre: 'Nueva' }, db)).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
    expect(await documents()).toEqual(before);
  });
  it('PATCH atomicity: real SDK commit failure rolls back update and reservation deletion', async () => {
    await createUserProfile(identity('user-a'), body(), db);
    await createUserProfile(identity('user-b'), body('Other-User1'), db);
    const before = await documents();
    await expect(db.runTransaction(async (tx) => {
      tx.update(db.doc('users/user-a'), { username: 'Other-User1', usernameKey: 'other-user1' });
      tx.delete(db.doc('usernames/ana-user1'));
      tx.create(db.doc('usernames/other-user1'), { uid: 'user-a', usernameKey: 'other-user1' });
    }, { maxAttempts: 1 })).rejects.toMatchObject({ code: 6 });
    expect(await documents()).toEqual(before);
  });


  it.each(['pending', 'completed', 'blocked'] as const)('account deletion: %s blocks GET, POST, PATCH without modifying data', async (status) => {
    await createUserProfile(identity('user-a'), body(), db);
    const now = Timestamp.now();
    await db.doc('accountDeletions/user-a').create({ status, phase: status === 'completed' ? 'done' : 'auth', usernameKeys: ['ana-user1'], requestedAt: now, updatedAt: now, attempts: 0 });
    const before = await documents();
    const marker = (await db.doc('accountDeletions/user-a').get()).data();
    await expect(getUserProfile(identity('user-a'), db)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createUserProfile(identity('user-a'), body(), db)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUserProfile(identity('user-a'), { username: 'Ana-User2', nombre: 'Nueva' }, db)).rejects.toMatchObject({ statusCode: 403 });
    expect(await documents()).toEqual(before);
    expect((await db.doc('accountDeletions/user-a').get()).data()).toEqual(marker);
  });
  it('account deletion: marker prevents POST even when profile is absent', async () => {
    await db.doc('accountDeletions/user-a').create({ status: 'completed' });
    await expect(createUserProfile(identity('user-a'), body(), db)).rejects.toMatchObject({ code: 'ACCOUNT_DELETED' });
    expect(await documents()).toEqual({ users: [], usernames: [] });
  });
  it('account deletion: another UID marker does not block an active account', async () => {
    await db.doc('accountDeletions/other').create({ status: 'pending' });
    await createUserProfile(identity('user-a'), body(), db);
    await updateUserProfile(identity('user-a'), { nombre: 'Nueva' }, db);
    expect((await getUserProfile(identity('user-a'), db)).profile?.nombre).toBe('Nueva');
  });
  it.each(['POST', 'PATCH'] as const)('account deletion: concurrent %s and marker serialize without writes after blocking', async (method) => {
    if (method === 'PATCH') await createUserProfile(identity('user-a'), body(), db);
    const refs = [db.doc('users/user-a'), db.doc('usernames/ana-user1'), db.doc('usernames/ana-user2')];
    const markerRef = db.doc('accountDeletions/user-a');
    const mark = () => db.runTransaction(async (tx) => {
      await tx.get(markerRef);
      const snapshots = [];
      for (const ref of refs) snapshots.push(await tx.get(ref));
      const now = Timestamp.now();
      tx.create(markerRef, { status: 'pending', phase: 'auth', usernameKeys: [], requestedAt: now, updatedAt: now, attempts: 0 });
      return snapshots.map((snapshot) => snapshot.exists ? snapshot.data() : null);
    });
    const operation = method === 'POST'
      ? createUserProfile(identity('user-a'), body(), db)
      : updateUserProfile(identity('user-a'), { username: 'Ana-User2' }, db);
    const [operationResult, markerResult] = await Promise.allSettled([operation, mark()]);
    expect(markerResult.status).toBe('fulfilled');
    if (operationResult.status === 'rejected') expect(operationResult.reason).toMatchObject({ statusCode: 403, code: 'ACCOUNT_DELETION_PENDING' });
    if (markerResult.status !== 'fulfilled') throw new Error('Marker transaction failed');
    const after = await Promise.all(refs.map(async (ref) => { const snapshot = await ref.get(); return snapshot.exists ? snapshot.data() : null; }));
    // The final state equals what the marker's serializable transaction observed:
    // the profile operation either committed before it or was rejected on retry.
    expect(after).toEqual(markerResult.value);
    const stable = await documents();
    await expect(createUserProfile(identity('user-a'), body(), db)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUserProfile(identity('user-a'), { nombre: 'Después del bloqueo' }, db)).rejects.toMatchObject({ statusCode: 403 });
    expect(await documents()).toEqual(stable);
  });
  it.each(['POST', 'PATCH'] as const)('account deletion: %s committed before marker remains consistent', async (method) => {
    if (method === 'PATCH') await createUserProfile(identity('user-a'), body(), db);
    if (method === 'POST') await createUserProfile(identity('user-a'), body(), db);
    else await updateUserProfile(identity('user-a'), { username: 'Ana-User2' }, db);
    const before = await documents();
    await db.runTransaction(async (tx) => { const ref = db.doc('accountDeletions/user-a'); await tx.get(ref); tx.create(ref, { status: 'pending' }); });
    await expect(updateUserProfile(identity('user-a'), { nombre: 'Nueva' }, db)).rejects.toMatchObject({ statusCode: 403 });
    expect(await documents()).toEqual(before);
    const user = (await db.doc('users/user-a').get()).data();
    expect(before.usernames).toEqual([{ id: user?.usernameKey, uid: 'user-a', usernameKey: user?.usernameKey }]);
  });

});
