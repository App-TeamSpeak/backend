import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
let fixtureApp: App | undefined;
const project = 'demo-teamspeak-tests';
const firestoreOrigin = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const authOrigin = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
let firebase: typeof import('../config/firebase');
beforeAll(async () => {
  const probes = await Promise.all([
    fetch(`${firestoreOrigin}/v1/projects/${project}/databases/(default)/documents/infrastructureTests?pageSize=1`, { headers: { Authorization: 'Bearer owner' }, signal: AbortSignal.timeout(3000) }),
    fetch(`${authOrigin}/emulator/v1/projects/${project}/config`, { signal: AbortSignal.timeout(3000) }),
  ]);
  if (probes.some((response) => !response.ok)) throw new Error('Both local emulators must be available before SDK operations.');
});
beforeEach(async () => {
  for (const [origin, suffix] of [[firestoreOrigin, '/databases/(default)/documents'], [authOrigin, '/accounts']]) {
    const response = await fetch(`${origin}/emulator/v1/projects/${project}${suffix}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unable to reset isolated realtime fixtures.');
  }
  vi.resetModules(); firebase = await import('../config/firebase.js'); await firebase.initializeFirebase();
  fixtureApp = initializeApp({ projectId: project, credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, 'rt-identity-fixtures');
});
afterEach(async () => {
  try { await firebase?.closeFirebase(); }
  finally { if (fixtureApp) { await deleteApp(fixtureApp); fixtureApp = undefined; } }
});
it('builds stable owned clients for the exact demo project', () => {
  const auth = firebase.getFirebaseInfo(); const db = firebase.getFirestoreDb();
  expect(auth.appName).toBe('teamspeak-realtime'); expect(auth.projectId).toBe(project);
  expect('projectId' in db && db.projectId).toBe(project); expect(firebase.getFirebaseInfo()).toEqual(auth); expect(firebase.getFirestoreDb()).toBe(db);
});
it('verifies an emitted fixture ID token through the unchanged auth service', async () => {
  await getAuth(fixtureApp!).createUser({ uid: 'rt-fixture', email: 'rt-fixture@example.com', password: 'Emulator-Only1!' });
  const response = await fetch(`${authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rt-fixture@example.com', password: 'Emulator-Only1!', returnSecureToken: true }), signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true); const data = await response.json() as { idToken: string };
  const { verifyToken } = await import('../services/firebase-auth.service.js'); expect((await verifyToken(data.idToken)).uid).toBe('rt-fixture');
});
it('reads absence of an account deletion marker without creating one', async () => {
  const marker = await firebase.getFirestoreDb().doc('accountDeletions/rt-fixture').get(); expect(marker.exists).toBe(false);
});
it('reads a persisted account deletion marker without implementing authorization', async () => {
  const ref = firebase.getFirestoreDb().doc('accountDeletions/rt-fixture'); await ref.create({ status: 'pending', phase: 'auth' });
  const marker = await ref.get(); expect(marker.exists).toBe(true); expect(marker.data()).toEqual({ status: 'pending', phase: 'auth' });
});
it('reads a real fixture document through Firestore Emulator', async () => {
  const ref = firebase.getFirestoreDb().doc('infrastructureTests/roundtrip'); await ref.create({ fixture: true });
  expect((await ref.get()).data()).toEqual({ fixture: true });
});
it('closes owned clients while preserving another fixture application', async () => {
  const other = initializeApp({ projectId: project, credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, 'rt-foreign-fixture');
  try { await firebase.closeFirebase(); expect(getApps()).toContain(other); expect(getAuth(other).app.name).toBe('rt-foreign-fixture'); expect(getApps().some((app) => app.name === 'teamspeak-realtime')).toBe(false); }
  finally { await deleteApp(other); }
});
it('rejects a malformed token locally in the Auth Emulator configuration', async () => {
  const { verifyToken } = await import('../services/firebase-auth.service.js'); await expect(verifyToken('not-a-token')).rejects.toHaveProperty('code');
});

it('rejects a retained verification operation after emulator configuration changes (P2)', async () => {
  const retained = firebase.verifyFirebaseIdToken;
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  try {
    await expect(retained('fixture-token')).rejects.toMatchObject({ code: 'FIREBASE_CONFIGURATION_CHANGED' });
    expect(firebase).not.toHaveProperty('getFirebaseAuth');
  } finally { process.env.FIREBASE_AUTH_EMULATOR_HOST = host; }
});

it('blocks remote test transports locally before transmission', () => {
  expect(() => https.request('https://www.googleapis.com/')).toThrow('REMOTE_TEST_NETWORK_BLOCKED');
  expect(() => http.request('http://www.googleapis.com/')).toThrow('REMOTE_TEST_NETWORK_BLOCKED');
  expect(() => http2.connect('https://www.googleapis.com')).toThrow('REMOTE_TEST_NETWORK_BLOCKED');
  expect(() => fetch('https://www.googleapis.com/')).toThrow('REMOTE_TEST_NETWORK_BLOCKED');
});
