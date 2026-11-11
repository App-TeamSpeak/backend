import { createServer, type Server as HttpServer } from 'node:http';
import { TestSocketClient } from './socket-client';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
let fixtureApp: App | undefined;
let transport: import('socket.io').Server | undefined;
let httpServer: HttpServer | undefined;
let socketOrigin: string;
let socketClients: TestSocketClient[] = [];
const project = 'demo-teamspeak-tests';
const firestoreOrigin = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const authOrigin = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
let firebase: typeof import('../config/firebase');
beforeAll(async () => {
  const probe = async (name: string, url: string, headers?: Record<string, string>) => {
    const started = performance.now();
    console.log(JSON.stringify({ event: 'emulator_probe_start', emulator: name, time: new Date().toISOString() }));
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      console.log(JSON.stringify({ event: 'emulator_probe_response', emulator: name, status: response.status, elapsedMs: Math.round(performance.now() - started), time: new Date().toISOString() }));
      return response;
    } catch (error) {
      console.log(JSON.stringify({ event: 'emulator_probe_error', emulator: name, code: error instanceof Error ? error.name : 'UNKNOWN', elapsedMs: Math.round(performance.now() - started), time: new Date().toISOString() }));
      throw error;
    }
  };
  const probes = await Promise.all([
    probe('firestore', `${firestoreOrigin}/v1/projects/${project}/databases/(default)/documents/infrastructureTests?pageSize=1`, { Authorization: 'Bearer owner' }),
    probe('auth', `${authOrigin}/emulator/v1/projects/${project}/config`),
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
  try {
    await Promise.all(socketClients.map((client) => client.close())); socketClients = [];
    if (transport) await new Promise<void>((resolve) => transport!.close(() => resolve()));
    transport = undefined; httpServer = undefined;
    await firebase?.closeFirebase();
  }
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

async function fixtureToken(uid: string): Promise<string> {
  const email = `${uid}@example.com`;
  await getAuth(fixtureApp!).createUser({ uid, email, password: 'Emulator-Only1!' });
  const response = await fetch(`${authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Emulator-Only1!', returnSecureToken: true }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Unable to sign in local fixture');
  return (await response.json() as { idToken: string }).idToken;
}
async function startTransport() {
  const { createRealtimeServer } = await import('../realtime/socket.js');
  httpServer = createServer(); transport = createRealtimeServer(httpServer);
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  socketOrigin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}
function socketClient(token: string) {
  const client = new TestSocketClient(socketOrigin, { token, uid: 'forged' });
  socketClients.push(client); return client;
}
it('authorizes real Socket.IO events for an active fixture and isolates another user', async () => {
  const firstToken = await fixtureToken('rt-first'); const secondToken = await fixtureToken('rt-second');
  await startTransport();
  const first = socketClient(firstToken); const second = socketClient(secondToken);
  await Promise.all([first.wait('connect'), second.wait('connect')]);
  await first.request('room:join', { roomId: 'room' }); await second.request('room:join', { roomId: 'room' });
  await first.request('chat:send', { text: 'fixture', uid: 'forged' });
  expect(await second.wait('chat:message')).toMatchObject({ authorId: 'rt-first', text: 'fixture' });
  await firebase.getFirestoreDb().doc('accountDeletions/rt-first').create({ status: 'pending' });
  // Supervision now disconnects the idle session without requiring another event.
  await first.wait('disconnect');
  expect(await second.request('chat:send', { text: 'second still active' })).toEqual({ ok: true });
  expect(await socketClient(firstToken).wait('connect_error')).toMatchObject({ message: 'ACCOUNT_UNAVAILABLE' });
  expect((await firebase.getFirestoreDb().doc('accountDeletions/rt-second').get()).exists).toBe(false);
  expect(second.received.filter(([event, data]) => event === 'chat:message' && (data as { text: string }).text === 'forbidden')).toEqual([]);
});
it.each([{ status: 'pending' }, { status: 'blocked' }, { status: 'completed' }, {}, { status: 'unknown' }])('denies an existing marker regardless of its contents: %j', async (marker) => {
  const token = await fixtureToken('rt-marker');
  await firebase.getFirestoreDb().doc('accountDeletions/rt-marker').create(marker);
  await startTransport();
  expect(await socketClient(token).wait('connect_error')).toMatchObject({ message: 'ACCOUNT_UNAVAILABLE' });
  expect(transport!.sockets.sockets.size).toBe(0);
});
it('rejects a revoked real emulator token on a new connection', async () => {
  const token = await fixtureToken('rt-revoked');
  // Admin compares second-resolution auth_time strictly against tokensValidAfterTime.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await getAuth(fixtureApp!).revokeRefreshTokens('rt-revoked'); await startTransport();
  expect(await socketClient(token).wait('connect_error')).toMatchObject({ message: 'AUTH_INVALID' });
});
it.each(['disabled', 'deleted'])('rejects %s Authentication identities on a real handshake', async (state) => {
  const token = await fixtureToken('rt-auth');
  if (state === 'disabled') await getAuth(fixtureApp!).updateUser('rt-auth', { disabled: true });
  else await getAuth(fixtureApp!).deleteUser('rt-auth');
  await startTransport();
  expect(await socketClient(token).wait('connect_error')).toMatchObject({ message: 'AUTH_INVALID' });
});
it('fails closed with a controlled error after Firebase configuration becomes stale', async () => {
  const token = await fixtureToken('rt-stale'); await startTransport();
  const client = socketClient(token); await client.wait('connect');
  const previous = process.env.FIRESTORE_EMULATOR_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:65534';
  try { expect(await client.request('room:join', { roomId: 'forbidden' })).toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE' } }); }
  finally { process.env.FIRESTORE_EMULATOR_HOST = previous; }
  expect(transport!.sockets.adapter.rooms.has('forbidden')).toBe(false);
});

it('real snapshots disconnect two idle sessions of the UID, preserve another UID and clean memberships', async () => {
  const token = await fixtureToken('rt-observed'); const otherToken = await fixtureToken('rt-unaffected');
  await startTransport();
  const first = socketClient(token); const second = socketClient(token); const other = socketClient(otherToken);
  await Promise.all([first.wait('connect'), second.wait('connect'), other.wait('connect')]);
  for (const client of [first, second, other]) await client.request('room:join', { roomId: 'observed-room' });
  await firebase.getFirestoreDb().doc('accountDeletions/rt-observed').create({});
  await Promise.all([first.wait('disconnect'), second.wait('disconnect')]);
  expect(await other.request('room:join', { roomId: 'observed-room' })).toEqual({ ok: true });
  expect(transport!.sockets.adapter.rooms.get('observed-room')?.size).toBe(1);
  expect((await firebase.getFirestoreDb().doc('accountDeletions/rt-observed').get()).exists).toBe(true);
  expect(await socketClient(token).wait('connect_error')).toMatchObject({ message: 'ACCOUNT_UNAVAILABLE' });
});
it('cancels a real observer after the last socket and creates a fresh one on reconnect', async () => {
  const token = await fixtureToken('rt-generation'); await startTransport();
  const first = socketClient(token); await first.wait('connect'); await first.close();
  const next = socketClient(token); await next.wait('connect');
  await firebase.getFirestoreDb().doc('accountDeletions/rt-generation').create({ status: 'completed' });
  await next.wait('disconnect');
  expect(transport!.sockets.sockets.size).toBe(0);
});
