const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const net = require('../integration-ts01/isolation.cjs'); // Before SDK imports; loopback-only allowlist.
const root = path.resolve(__dirname, '..');
const from = (service, file) => require(path.join(root, service, file));
const apiRequire = require('node:module').createRequire(path.join(root, 'backend-api/package.json'));
const { initializeApp, deleteApp } = apiRequire('firebase-admin/app');
const { getAuth } = apiRequire('firebase-admin/auth');
const { startApiServer } = from('backend-api', 'dist/server');
const { createRealtimeRuntime } = from('backend-realtime', 'dist/server');
const { TestSocketClient } = from('backend-realtime', 'dist/integration/socket-client');
const { getFirestoreDb } = from('backend-api', 'dist/config/firebase');
const authOrigin = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreOrigin = 'http://' + process.env.FIRESTORE_EMULATOR_HOST;
const apiOrigin = 'http://127.0.0.1:' + process.env.PORT;
const project = 'demo-teamspeak-tests';
const prefix = 'session-' + randomUUID().slice(0, 8);
const password = 'Emulator-Only1!';
let api, realtime, fixtureApp, auth, db, socketOrigin;
const sockets = [];
// This suite never deletes identities/documents or invokes DELETE/processor/reconciler.
const isolatedFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') throw new Error('US03_DESTRUCTIVE_REQUEST_FORBIDDEN');
  return isolatedFetch(input, init);
};
async function until(condition, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('US03_WAIT_TIMEOUT: ' + label);
}
async function available(origin, resource) {
  await until(async () => {
    try { return (await fetch(origin + resource, { headers: { Authorization: 'Bearer owner' }, signal: AbortSignal.timeout(3000) })).ok; }
    catch { return false; }
  }, 'emulator readiness', 15000);
}
async function authRequest(operation, body) {
  const response = await fetch(authOrigin + '/identitytoolkit.googleapis.com/v1/accounts:' + operation + '?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
async function login(email) {
  const result = await authRequest('signInWithPassword', { email, password, returnSecureToken: true });
  assert.equal(result.status, 200);
  return { uid: result.data.localId, token: result.data.idToken, refreshToken: result.data.refreshToken, email };
}
async function identity(suffix, verified = true) {
  net.assertSafe();
  const uid = prefix + '-' + suffix; const email = uid + '@example.invalid';
  await auth.createUser({ uid, email, emailVerified: verified, password });
  return { ...await login(email), username: 'Session_' + randomUUID().slice(0, 16).replaceAll('-', '_') };
}
async function refresh(user) {
  const response = await fetch(authOrigin + '/securetoken.googleapis.com/v1/token?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: user.refreshToken }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const result = await response.json(); return { ...user, token: result.id_token, refreshToken: result.refresh_token };
}
async function http(user, method = 'GET', endpoint = '/api/users/me', body) {
  const response = await fetch(apiOrigin + endpoint, {
    method, headers: { ...(user?.token ? { Authorization: 'Bearer ' + user.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: await response.json() };
}
async function profile(user) {
  const result = await http(user, 'POST', '/api/users/me', { nombre: 'Session', apellido: 'Fixture', username: user.username });
  assert.equal(result.status, 201); return result.body.data;
}
async function connect(user, deniedCode) {
  const socket = new TestSocketClient(socketOrigin, user ? { token: user.token } : {}); sockets.push(socket);
  if (deniedCode) { assert.equal((await socket.wait('connect_error')).data.code, deniedCode); return socket; }
  await socket.wait('connect'); return socket;
}
function changedToken(token, patch) {
  // Emulator-only adversarial tokens; not signatures or a custom session implementation.
  const parts = token.split('.');
  const claims = { ...JSON.parse(Buffer.from(parts[1], 'base64url')), ...patch };
  return parts[0] + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + parts[2];
}
before(async () => {
  net.assertSafe();
  await Promise.all([available(authOrigin, '/emulator/v1/projects/' + project + '/config'), available(firestoreOrigin, '/v1/projects/' + project + '/databases/(default)/documents/users?pageSize=1')]);
  api = startApiServer(); await api.ready; realtime = createRealtimeRuntime(); await realtime.start(0);
  socketOrigin = 'http://127.0.0.1:' + realtime.httpServer.address().port; net.allow(socketOrigin);
  fixtureApp = initializeApp({ projectId: project, credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, 'us03-fixtures');
  auth = getAuth(fixtureApp); db = getFirestoreDb(); assert.equal(db.projectId, project);
}, { timeout: 25000 });
after(async () => {
  try { await Promise.all(sockets.map(socket => socket.close())); }
  finally {
    const closed = await Promise.allSettled([realtime?.stop(), api?.stop()]);
    if (fixtureApp) await deleteApp(fixtureApp); // Close local resources, not Firebase identities.
    globalThis.fetch = isolatedFetch;
    assert.ok(closed.every(result => result.status === 'fulfilled'));
  }
});
test('US-03 Email/Password: login, refresh and repeated login reuse a persisted profile without POST', { timeout: 15000 }, async () => {
  const first = await identity('email'); await profile(first);
  const snapshot = await db.doc('users/' + first.uid).get();
  const renewed = await refresh(first); assert.equal((await auth.verifyIdToken(renewed.token, true)).uid, first.uid);
  const repeated = { ...first, ...await login(first.email) };
  for (const user of [renewed, repeated]) {
    const result = await http(user); assert.equal(result.status, 200); assert.equal(result.body.data.profile.username, first.username);
    assert.equal((await http(user, 'GET', '/api/rooms')).status, 501);
    const socket = await connect(user); assert.deepEqual(await socket.request('room:join', { roomId: 'session-email' }), { ok: true }); await socket.close();
  }
  assert.ok((await db.doc('users/' + first.uid).get()).updateTime.isEqual(snapshot.updateTime));
  assert.equal((await db.collection('usernames').where('uid', '==', first.uid).get()).size, 1);
});
test('US-03 Google emulator: recurrent provider login and refresh preserve identity and complete profile', { timeout: 15000 }, async () => {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const credential = encoded({ alg: 'none', typ: 'JWT' }) + '.' + encoded({ sub: prefix + '-google', email: prefix + '-google@example.invalid', email_verified: true }) + '.';
  const signIn = () => authRequest('signInWithIdp', { postBody: new URLSearchParams({ id_token: credential, providerId: 'google.com' }).toString(), requestUri: 'http://localhost', returnSecureToken: true });
  const first = await signIn(); assert.equal(first.status, 200);
  const user = { uid: first.data.localId, token: first.data.idToken, refreshToken: first.data.refreshToken, username: 'Google_' + prefix.slice(-8) };
  assert.equal((await auth.verifyIdToken(user.token, true)).firebase.sign_in_provider, 'google.com');
  assert.equal((await http(user)).body.data.profileStatus, 'incomplete'); await connect(user, 'PROFILE_INCOMPLETE');
  await profile(user); const snapshot = await db.doc('users/' + user.uid).get();
  const second = await signIn(); assert.equal(second.status, 200); assert.equal(second.data.localId, user.uid);
  const updated = await refresh({ ...user, token: second.data.idToken, refreshToken: second.data.refreshToken });
  assert.equal((await http(updated)).body.data.profile.username, user.username);
  const socket = await connect(updated); assert.deepEqual(await socket.request('room:join', { roomId: 'session-google' }), { ok: true });
  assert.ok((await db.doc('users/' + user.uid).get()).updateTime.isEqual(snapshot.updateTime));
  assert.equal((await db.collection('usernames').where('uid', '==', user.uid).get()).size, 1);
});
test('US-03 invalid/missing credentials are rejected over HTTP and real WebSocket', { timeout: 15000 }, async () => {
  for (const authorization of [undefined, 'Bearer', 'Basic fixture', 'Bearer invalid']) {
    const response = await fetch(apiOrigin + '/api/users/me', { headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 401);
  }
  await connect(undefined, 'AUTH_REQUIRED'); await connect({ token: 'invalid' }, 'AUTH_INVALID');
});
for (const [label, patch] of [['expired', { exp: 1 }], ['wrong audience', { aud: 'another-project' }], ['wrong issuer', { iss: 'https://securetoken.google.com/another-project' }]]) {
  test('US-03 installed SDK rejects ' + label + ' Firebase ID token', { timeout: 15000 }, async () => {
    const user = await identity(label.replaceAll(' ', '-'));
    const changed = { ...user, token: changedToken(user.token, patch) };
    const result = await http(changed); assert.equal(result.status, 401); assert.equal(result.body.code, 'AUTH_INVALID');
    await connect(changed, 'AUTH_INVALID');
  });
}
test('US-03 onboarding exceptions retain email and complete-profile gates', { timeout: 15000 }, async () => {
  const user = await identity('onboarding', false);
  assert.equal((await http(user)).body.data.profileStatus, 'incomplete'); await profile(user);
  assert.equal((await http(user, 'PATCH', '/api/users/me', { nombre: 'Denied' })).body.code, 'EMAIL_NOT_VERIFIED');
  await connect(user, 'EMAIL_NOT_VERIFIED');
  await auth.updateUser(user.uid, { emailVerified: true }); const updated = await refresh(user);
  assert.equal((await auth.verifyIdToken(updated.token)).email_verified, true);
  assert.equal((await http(updated, 'PATCH', '/api/users/me', { nombre: 'Verified' })).status, 200);
  await connect(updated);
  const partial = await identity('partial'); await db.doc('users/' + partial.uid).create({ uid: partial.uid, profileStatus: 'incomplete' });
  assert.equal((await http(partial)).body.data.profileStatus, 'incomplete');
  assert.equal((await http(partial, 'GET', '/api/rooms')).body.code, 'PROFILE_INCOMPLETE'); await connect(partial, 'PROFILE_INCOMPLETE');
});
test('US-03 voluntary disconnect cleans rooms/observers and permits a new session without modifying profile', { timeout: 15000 }, async () => {
  const user = await identity('logout'); await profile(user); const snapshot = await db.doc('users/' + user.uid).get();
  const socket = await connect(user); const room = prefix + '-logout';
  await socket.request('room:join', { roomId: room }); assert.equal(realtime.io.sockets.adapter.rooms.get(room).size, 1);
  await socket.close(); await until(() => !realtime.io.sockets.adapter.rooms.has(room), 'voluntary room cleanup');
  // Backend-observable disconnect only: Firebase Client SDK signOut is not installed/executed here.
  const session = { ...user, ...await login(user.email) }; const next = await connect(session);
  assert.deepEqual(await next.request('room:join', { roomId: room }), { ok: true });
  assert.ok((await db.doc('users/' + user.uid).get()).updateTime.isEqual(snapshot.updateTime));
});
test('US-03 forgetting a local token alone does not disconnect an already authorized socket', { timeout: 15000 }, async () => {
  let localCredential = await identity('left-connected'); await profile(localCredential);
  const socket = await connect(localCredential); await socket.request('room:join', { roomId: 'still-connected' });
  localCredential = undefined; // Model absence of further credential use, not Firebase Client SDK signOut.
  assert.deepEqual(await socket.request('chat:send', { text: 'Existing session still needs explicit disconnect' }), { ok: true });
  await socket.close();
});
for (const state of ['disabled', 'revoked']) {
  test('US-03 emulator ' + state + ': handshake rejection; emulator REST state checks are not production revocation evidence', { timeout: 15000 }, async () => {
    const user = await identity(state); await profile(user);
    if (state === 'disabled') await auth.updateUser(user.uid, { disabled: true });
    else {
      const decoded = await auth.verifyIdToken(user.token);
      await until(() => Math.floor(Date.now() / 1000) > decoded.auth_time, 'revocation second boundary');
      await auth.revokeRefreshTokens(user.uid);
      assert.ok(new Date((await auth.getUser(user.uid)).tokensValidAfterTime).getTime() / 1000 > decoded.auth_time);
    }
    await connect(user, 'AUTH_INVALID'); const result = await http(user);
    assert.equal(result.status, 401); assert.equal(result.body.code, 'AUTH_INVALID');
    // Admin SDK checks user status automatically in emulator mode even with no checkRevoked argument.
  });
}
test('US-03 account marker blocks HTTP and proactively disconnects idle sessions without processing deletion', { timeout: 15000 }, async () => {
  const user = await identity('marker'); await profile(user); const socket = await connect(user);
  await db.doc('accountDeletions/' + user.uid).create({ fixture: 'malformed-no-deletion-request' });
  await socket.wait('disconnect'); assert.equal((await http(user)).status, 403); await connect(user, 'ACCOUNT_UNAVAILABLE');
  assert.equal((await auth.getUser(user.uid)).uid, user.uid); assert.equal((await db.doc('users/' + user.uid).get()).exists, true);
});
test('US-03 Authentication transport outage rejects HTTP and handshake without granting access', { timeout: 15000 }, async () => {
  const user = await identity('outage'); await profile(user);
  net.block(authOrigin);
  try {
    const result = await http(user); assert.equal(result.status, 503); assert.equal(result.body.code, 'AUTH_UNAVAILABLE');
    console.log(JSON.stringify({ event: 'us03_auth_outage', httpStatus: result.status }));
    const socket = new TestSocketClient(socketOrigin, { token: user.token }); sockets.push(socket);
    assert.ok(['AUTH_INVALID', 'AUTHORIZATION_UNAVAILABLE'].includes((await socket.wait('connect_error')).data.code));
  } finally { net.unblock(authOrigin); }
  assert.equal((await http(user)).status, 200);
});
test('US-03 refuses destructive or remote test requests before transmission', () => {
  assert.throws(() => fetch(apiOrigin + '/api/users/me', { method: 'DELETE' }), /US03_DESTRUCTIVE_REQUEST_FORBIDDEN/);
  assert.throws(() => fetch('https://www.googleapis.com/'), /TEST_NETWORK_BLOCKED/);
});
test('P2: real SDK cancels a stalled authorization watch and releases its client', { timeout: 15000 }, async () => {
  const http2 = require('node:http2');
  const { Firestore } = apiRequire('firebase-admin/firestore');
  const { readAuthorizationDocument } = from('backend-api', 'dist/services/authorization-read.service');
  // Run-private loopback gRPC transport fixture, not a natural Firestore outage.
  const endpoint = http2.createServer(); const sessions = new Set(); const streams = new Set(); let observed = false;
  endpoint.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); session.on('error', () => undefined); });
  endpoint.on('stream', stream => {
    streams.add(stream); stream.on('close', () => streams.delete(stream)); stream.on('error', () => undefined);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    stream.on('data', () => { observed = true; });
    // Honor the client's unsubscribe/half-close; never send a document snapshot.
    stream.on('end', () => stream.close(http2.constants.NGHTTP2_CANCEL));
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const port = endpoint.address().port; net.allow('http://127.0.0.1:' + port);
  const local = new Firestore({ projectId: project, host: '127.0.0.1', port, ssl: false, credentials: { client_email: 'emulator@example.invalid', private_key: 'emulator-only-not-a-key' } });
  let timeout;
  try {
    await assert.rejects(readAuthorizationDocument(local.doc('accountDeletions/stalled-fixture')), error => error.code === 'FIRESTORE_UNAVAILABLE');
    assert.equal(observed, true);
    await until(() => streams.size === 0, 'unsubscribe closes stalled RPC');
    await Promise.race([local.terminate(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SDK_CLOSE_TIMEOUT')), 3000); })]);
  } finally {
    clearTimeout(timeout);
    for (const stream of streams) stream.destroy(); for (const session of sessions) session.destroy();
    await new Promise(resolve => endpoint.close(resolve));
    await local.terminate();
  }
  assert.equal((await http(await identity('p2-recovered'))).status, 200);
});

test('US-03 stopping Realtime with a live session releases transport without changing API profile', { timeout: 15000 }, async () => {
  const user = await identity('shutdown'); await profile(user); const socket = await connect(user);
  const gone = socket.wait('disconnect'); await realtime.stop(); await gone; await realtime.stop();
  assert.equal(realtime.io.sockets.sockets.size, 0); assert.equal((await http(user)).body.data.profileStatus, 'complete');
});
