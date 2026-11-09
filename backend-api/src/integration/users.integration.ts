import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createUserProfile, getUserProfile } from '../services/users.service';
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
});
