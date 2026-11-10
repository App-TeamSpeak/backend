import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { app } from '../app';
import { createUserProfile, updateUserProfile } from '../services/users.service';
import { processAccountDeletion } from '../services/account-deletion.processor';
import { userBodySchema } from '../validators/user.validator';

const project = 'demo-teamspeak-tests';
const firebase = initializeApp({ projectId: project }, 'deletion-integration');
const auth = getAuth(firebase);
const db = getFirestore(firebase);
const firestoreOrigin = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const authOrigin = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const body = userBodySchema.parse({ nombre: 'Ana', apellido: 'Pérez', username: 'Ana-User1' });
const identity = { uid: 'user-a', email: 'user-a@example.com' };
async function snapshot() {
  const [users, usernames, markers] = await Promise.all(['users','usernames','accountDeletions'].map((name) => db.collection(name).get()));
  return { users: users.docs.map((doc) => ({ id: doc.id, ...doc.data() })), usernames: usernames.docs.map((doc) => ({ id: doc.id, ...doc.data() })), markers: markers.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
}
async function token(uid = identity.uid) {
  const email = `${uid}@example.com`;
  await auth.createUser({ uid, email, password: 'Emulator-Only1!' });
  const response = await fetch(`${authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Emulator-Only1!', returnSecureToken: true }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Unable to obtain an emulator token.');
  const data = await response.json() as { idToken: string };
  return data.idToken;
}
function remove(idToken: string) { return request(app).delete('/api/users/me').set('Authorization', `Bearer ${idToken}`); }
describe('DELETE intent with real Authentication and Firestore emulators', () => {
  beforeAll(async () => {
    const firestore = await fetch(`${firestoreOrigin}/v1/projects/${project}/databases/(default)/documents/users?pageSize=1`, { headers: { Authorization: 'Bearer owner' }, signal: AbortSignal.timeout(3000) });
    const authentication = await fetch(`${authOrigin}/emulator/v1/projects/${project}/config`, { signal: AbortSignal.timeout(3000) });
    if (!firestore.ok || !authentication.ok) throw new Error('Both local emulators must be available before SDK operations.');
  });
  beforeEach(async () => {
    for (const [origin, path] of [[firestoreOrigin, `/emulator/v1/projects/${project}/databases/(default)/documents`], [authOrigin, `/emulator/v1/projects/${project}/accounts`]]) {
      const response = await fetch(`${origin}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Unable to clear demo emulator fixtures.');
    }
  });
  afterAll(async () => { await db.terminate(); await deleteApp(firebase); });
  it('uses an emitted token, real revocation verification and creates only the marker', async () => {
    const idToken = await token();
    expect((await auth.verifyIdToken(idToken, true)).uid).toBe(identity.uid);
    await createUserProfile(identity, body, db);
    const before = await snapshot();
    const response = await remove(idToken).query({ uid: 'other' });
    expect(response.status).toBe(202); expect(response.body).toEqual({ success: true, data: { status: 'pending' } });
    const after = await snapshot(); expect(after.users).toEqual(before.users); expect(after.usernames).toEqual(before.usernames);
    expect(after.markers).toHaveLength(1);
    expect(after.markers[0]).toMatchObject({ id: identity.uid, status: 'pending', phase: 'auth', usernameKeys: ['ana-user1'], attempts: 0 });
    expect(Object.keys(after.markers[0]).sort()).toEqual(['id','status','phase','usernameKeys','attempts','requestedAt','updatedAt'].sort());
    expect((await db.doc(`accountDeletions/${identity.uid}`).get()).data()?.requestedAt).toBeInstanceOf(Timestamp);
    expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
    expect((await request(app).get('/api/users/me').set('Authorization', `Bearer ${idToken}`)).status).toBe(403);
  });
  it('repeats without changing progress or document updateTime', async () => {
    const idToken = await token(); await createUserProfile(identity, body, db);
    expect((await remove(idToken)).status).toBe(202);
    const ref = db.doc(`accountDeletions/${identity.uid}`); const before = await ref.get();
    expect((await remove(idToken)).status).toBe(202);
    const after = await ref.get(); expect(after.data()).toEqual(before.data()); expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });
  it('two simultaneous DELETE persist one unchanged intent', async () => {
    const idToken = await token(); await createUserProfile(identity, body, db);
    const before = await snapshot();
    const responses = await Promise.all([remove(idToken), remove(idToken)]);
    expect(responses.map((response) => response.status)).toEqual([202,202]);
    const after = await snapshot(); expect(after.markers).toHaveLength(1); expect(after.users).toEqual(before.users); expect(after.usernames).toEqual(before.usernames);
  });
  it.each(['POST','PATCH','RENAME'] as const)('concurrent DELETE and %s capture the committed reservations', async (operation) => {
    const idToken = await token(); if (operation !== 'POST') await createUserProfile(identity, body, db);
    const mutation = operation === 'POST' ? createUserProfile(identity, body, db)
      : updateUserProfile(identity, operation === 'PATCH' ? { nombre: 'Nueva' } : { username: 'Ana-User2' }, db);
    const [change, deletion] = await Promise.allSettled([mutation, remove(idToken)]);
    expect(deletion.status).toBe('fulfilled');
    if (deletion.status !== 'fulfilled') throw new Error('DELETE failed');
    expect(deletion.value.status).toBe(202);
    if (change.status === 'rejected') expect(change.reason).toMatchObject({ statusCode: 403, code: 'ACCOUNT_DELETION_PENDING' });
    const owned = await db.collection('usernames').where('uid','==',identity.uid).get();
    const marker = (await db.doc(`accountDeletions/${identity.uid}`).get()).data();
    expect(marker?.usernameKeys).toEqual(owned.docs.map((doc) => doc.id).sort());
    const stable = await snapshot();
    await expect(updateUserProfile(identity, { nombre: 'No permitido' }, db)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createUserProfile(identity, body, db)).rejects.toMatchObject({ statusCode: 403 });
    expect(await snapshot()).toEqual(stable); expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });
  it('accepts an incomplete profile without fabricating or changing its fields', async () => {
    const idToken = await token(); await db.doc(`users/${identity.uid}`).create({ uid: identity.uid, nombre: 'Ana' });
    const before = await snapshot(); expect((await remove(idToken)).status).toBe(202);
    expect((await snapshot()).users).toEqual(before.users);
  });
  it('accepts absent profile and discovers an owned orphan reservation', async () => {
    const idToken = await token(); await db.doc('usernames/ana-user1').create({ uid: identity.uid, usernameKey: 'ana-user1' });
    expect((await remove(idToken)).status).toBe(202);
    const after = await snapshot(); expect(after.users).toEqual([]); expect(after.usernames).toHaveLength(1);
    expect((await db.doc(`accountDeletions/${identity.uid}`).get()).data()?.usernameKeys).toEqual(['ana-user1']);
  });
  it('rejects other-owner reservation with no marker or resource modifications', async () => {
    const idToken = await token(); await createUserProfile(identity, body, db); await db.doc('usernames/ana-user1').update({ uid: 'other' });
    const before = await snapshot(); const response = await remove(idToken);
    expect(response.status).toBe(409); expect(response.body.code).toBe('PROFILE_INCONSISTENT'); expect(await snapshot()).toEqual(before);
    expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });
  it('rejects an invalid token without writing', async () => {
    const before = await snapshot(); expect((await remove('invalid-token')).status).toBe(401); expect(await snapshot()).toEqual(before);
  });
  it('rejects disabled identity using real checkRevoked', async () => {
    const idToken = await token(); await auth.updateUser(identity.uid, { disabled: true });
    const before = await snapshot(); const response = await remove(idToken);
    expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_USER_DISABLED'); expect(await snapshot()).toEqual(before);
  });
  it('stays disabled when explicit activation is absent', async () => {
    const idToken = await token(); const before = await snapshot(); const saved = process.env.TEAMSPEAK_ENABLE_DELETE_TESTS;
    try { delete process.env.TEAMSPEAK_ENABLE_DELETE_TESTS; expect((await remove(idToken)).status).toBe(501); }
    finally { process.env.TEAMSPEAK_ENABLE_DELETE_TESTS = saved; }
    expect(await snapshot()).toEqual(before); expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });

  async function intent() {
    const idToken = await token();
    await createUserProfile(identity, body, db);
    expect((await remove(idToken)).status).toBe(202);
    return idToken;
  }
  const processing = {};
  it('processor: removes only fixture resources, completes, and permits username reuse safely', async () => {
    await intent();
    const original = (await db.doc(`accountDeletions/${identity.uid}`).get()).data();
    await token('user-b');
    await expect(createUserProfile({ uid: 'user-b', email: 'user-b@example.com' }, body, db)).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    const result = await processAccountDeletion(identity.uid, processing);
    expect(result).toMatchObject({ status: 'completed', phase: 'done', usernameKeys: [], attempts: 1, requestedAt: original?.requestedAt });
    await expect(auth.getUser(identity.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    const after = await snapshot(); expect(after.users).toEqual([]); expect(after.usernames).toEqual([]); expect(after.markers).toHaveLength(1);
    expect(result.completedAt).toBeInstanceOf(Timestamp); expect(result).not.toHaveProperty('nextAttemptAt'); expect(result).not.toHaveProperty('lastErrorCode');
    const completedSnapshot = await db.doc(`accountDeletions/${identity.uid}`).get();
    await createUserProfile({ uid: 'user-b', email: 'user-b@example.com' }, body, db);
    const stable = await snapshot();
    expect(await processAccountDeletion(identity.uid, processing)).toEqual(result);
    expect(await snapshot()).toEqual(stable); expect((await auth.getUser('user-b')).uid).toBe('user-b');
    expect((await db.doc(`accountDeletions/${identity.uid}`).get()).updateTime?.isEqual(completedSnapshot.updateTime!)).toBe(true);
  });
  it('processor: recognizes Auth already absent after a previous interrupted execution', async () => {
    await intent(); await auth.deleteUser(identity.uid); // Fixture-only simulation of a completed external step.
    expect((await processAccountDeletion(identity.uid, processing)).status).toBe('completed');
    expect((await snapshot()).users).toEqual([]); expect((await snapshot()).usernames).toEqual([]);
  });
  it.each(['profile','reservation'] as const)('processor: tolerates %s already absent', async (resource) => {
    await intent(); await db.doc(resource === 'profile' ? `users/${identity.uid}` : 'usernames/ana-user1').delete();
    expect((await processAccountDeletion(identity.uid, processing)).status).toBe('completed');
    await expect(auth.getUser(identity.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    const after = await snapshot(); expect(after.users).toEqual([]); expect(after.usernames).toEqual([]);
  });
  it('processor: deletes a safely owned incomplete fixture profile', async () => {
    const idToken = await token(); await db.doc(`users/${identity.uid}`).create({ uid: identity.uid, nombre: 'Ana' });
    expect((await remove(idToken)).status).toBe(202);
    expect((await processAccountDeletion(identity.uid, processing)).status).toBe('completed');
    expect((await snapshot()).users).toEqual([]); await expect(auth.getUser(identity.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
  it('processor: cleans multiple reservations only when recorded and still owned', async () => {
    const idToken = await token(); await createUserProfile(identity, body, db);
    await db.doc('usernames/extra-user1').create({ uid: identity.uid, usernameKey: 'extra-user1' });
    expect((await remove(idToken)).status).toBe(202);
    expect((await db.doc(`accountDeletions/${identity.uid}`).get()).data()?.usernameKeys).toEqual(['ana-user1','extra-user1']);
    expect((await processAccountDeletion(identity.uid, processing)).status).toBe('completed'); expect((await snapshot()).usernames).toEqual([]);
  });
  it('processor: two admitted executors preserve attempts and converge with real SDK calls', async () => {
    await intent(); let calls = 0; let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const beforeAuthDelete = async () => { calls++; if (calls === 2) release(); await barrier; };
    const results = await Promise.all([
      processAccountDeletion(identity.uid, { ...processing, beforeAuthDelete }),
      processAccountDeletion(identity.uid, { ...processing, beforeAuthDelete }),
    ]);
    expect(results.every((value) => value.status === 'completed')).toBe(true); expect(calls).toBe(2);
    const marker = (await db.doc(`accountDeletions/${identity.uid}`).get()).data(); expect(marker).toMatchObject({ status: 'completed', phase: 'done', attempts: 2 });
    expect((await snapshot()).users).toEqual([]); expect((await snapshot()).usernames).toEqual([]);
    await expect(auth.getUser(identity.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
  it('processor: refuses a foreign reservation before deleting either fixture identity', async () => {
    await intent(); await token('user-b'); await db.doc('usernames/ana-user1').update({ uid: 'user-b' });
    const before = await snapshot(); const result = await processAccountDeletion(identity.uid, processing);
    expect(result).toMatchObject({ status: 'blocked', phase: 'auth', lastErrorCode: 'PROFILE_INCONSISTENT' });
    const after = await snapshot(); expect(after.users).toEqual(before.users); expect(after.usernames).toEqual(before.usernames);
    expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid); expect((await auth.getUser('user-b')).uid).toBe('user-b');
    const stable = await snapshot(); expect((await processAccountDeletion(identity.uid, processing)).status).toBe('blocked'); expect(await snapshot()).toEqual(stable);
  });
  it('processor: unexpected owned reservation blocks without silently adding it to the plan', async () => {
    await intent(); await db.doc('usernames/unexpected1').create({ uid: identity.uid, usernameKey: 'unexpected1' });
    const before = await snapshot(); expect((await processAccountDeletion(identity.uid, processing)).status).toBe('blocked');
    const after = await snapshot(); expect(after.users).toEqual(before.users); expect(after.usernames).toEqual(before.usernames);
    expect(after.markers[0]).toMatchObject({ usernameKeys: ['ana-user1'] }); expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });
  it('processor: rechecks cleanup ownership after the Auth step', async () => {
    await intent(); await token('user-b');
    const result = await processAccountDeletion(identity.uid, { ...processing, afterAuthDeleted: async () => { await db.doc('usernames/ana-user1').update({ uid: 'user-b' }); } });
    expect(result).toMatchObject({ status: 'blocked', phase: 'firestore' });
    expect((await db.doc(`users/${identity.uid}`).get()).exists).toBe(true);
    expect((await db.doc('usernames/ana-user1').get()).data()?.uid).toBe('user-b'); expect((await auth.getUser('user-b')).uid).toBe('user-b');
  });
  it('processor: recovers real Auth deletion after an aborted phase transaction', async () => {
    await intent(); const before = await snapshot();
    const pending = await processAccountDeletion(identity.uid, { ...processing, beforePhaseCommit: () => { throw { code: 14 }; } });
    expect(pending).toMatchObject({ status: 'pending', phase: 'auth', attempts: 1, lastErrorCode: 'FIRESTORE_UNAVAILABLE' });
    await expect(auth.getUser(identity.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    expect((await snapshot()).users).toEqual(before.users); expect((await snapshot()).usernames).toEqual(before.usernames);
    const stable = await snapshot(); expect((await processAccountDeletion(identity.uid, processing)).attempts).toBe(1); expect(await snapshot()).toEqual(stable);
    await expect(createUserProfile(identity, body, db)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUserProfile(identity, { nombre: 'No permitido' }, db)).rejects.toMatchObject({ statusCode: 403 });
    const recovered = await processAccountDeletion(identity.uid, { ...processing, now: () => Timestamp.fromMillis(pending.nextAttemptAt!.toMillis() + 1) });
    expect(recovered).toMatchObject({ status: 'completed', attempts: 2 }); expect((await snapshot()).users).toEqual([]);
  });
  it('processor: actual SDK abort discards queued cleanup writes and resumes only firestore', async () => {
    await intent(); const before = await snapshot(); let calls = 0;
    const beforeAuthDelete = async () => { calls++; };
    const pending = await processAccountDeletion(identity.uid, { ...processing, beforeAuthDelete, beforeCleanupCommit: () => { throw { code: 10 }; } });
    expect(pending).toMatchObject({ status: 'pending', phase: 'firestore', attempts: 1 });
    const after = await snapshot(); expect(after.users).toEqual(before.users); expect(after.usernames).toEqual(before.usernames);
    await expect(auth.getUser(identity.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    expect(await processAccountDeletion(identity.uid, { ...processing, beforeAuthDelete, now: () => Timestamp.fromMillis(pending.nextAttemptAt!.toMillis() + 1) })).toMatchObject({ status: 'completed', attempts: 2 });
    expect(calls).toBe(1); expect((await snapshot()).users).toEqual([]); expect((await snapshot()).usernames).toEqual([]);
  });
  it('processor: a lost completion result is recognized from persisted completed state', async () => {
    await intent();
    const completed = await processAccountDeletion(identity.uid, { ...processing, afterCleanupCommitted: async () => { throw { code: 14 }; } });
    expect(completed.status).toBe('completed'); const stable = await snapshot();
    expect(await processAccountDeletion(identity.uid, processing)).toEqual(completed); expect(await snapshot()).toEqual(stable);
  });
  it('processor: missing or malformed authorization never deletes fixture identities', async () => {
    await token();
    await expect(processAccountDeletion(identity.uid, processing)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_FOUND' });
    await db.doc(`accountDeletions/${identity.uid}`).create({ status: 'pending', phase: 'done' });
    const before = await snapshot();
    await expect(processAccountDeletion(identity.uid, processing)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_INCONSISTENT' });
    expect(await snapshot()).toEqual(before); expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });
  it('processor: test gating is enforced on direct invocation too', async () => {
    await intent(); const before = await snapshot(); const saved = process.env.TEAMSPEAK_ENABLE_DELETE_TESTS;
    try {
      delete process.env.TEAMSPEAK_ENABLE_DELETE_TESTS;
      await expect(processAccountDeletion(identity.uid, processing)).rejects.toMatchObject({ statusCode: 501 });
    } finally { process.env.TEAMSPEAK_ENABLE_DELETE_TESTS = saved; }
    expect(await snapshot()).toEqual(before); expect((await auth.getUser(identity.uid)).uid).toBe(identity.uid);
  });

});
