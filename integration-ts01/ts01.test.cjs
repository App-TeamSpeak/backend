const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('./isolation.cjs'); // Must run before any Firebase SDK/service import.
const root = path.resolve(__dirname, '..');
const from = (service, file) => file.startsWith('node_modules/')
  ? require('node:module').createRequire(path.join(root, service, 'package.json'))(file.slice('node_modules/'.length))
  : require(path.join(root, service, file));
const { initializeApp, deleteApp } = from('backend-api', 'node_modules/firebase-admin/app');
const { getAuth } = from('backend-api', 'node_modules/firebase-admin/auth');
const apiFirebase = from('backend-api', 'dist/config/firebase');
const rtFirebase = from('backend-realtime', 'dist/config/firebase');
const { startApiServer } = from('backend-api', 'dist/server');
const { createRealtimeRuntime } = from('backend-realtime', 'dist/server');
const { processAccountDeletion } = from('backend-api', 'dist/services/account-deletion.processor');
const { createAccountDeletionReconciler } = from('backend-api', 'dist/services/account-deletion.reconciler');
const { TestSocketClient } = from('backend-realtime', 'dist/integration/socket-client');
const project = 'demo-teamspeak-tests';
const authOrigin = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreOrigin = 'http://' + process.env.FIRESTORE_EMULATOR_HOST;
const apiOrigin = 'http://127.0.0.1:' + process.env.PORT;
let api, realtime, fixtureApp, auth, db, socketOrigin;
const sockets = [];
const prefix = 'joint-' + require('node:crypto').randomUUID().slice(0, 8);
async function ready(origin, route, deadlineMs = 15000) {
  const start = Date.now(); let last = 'NO_RESPONSE';
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(origin + route, { headers: { Authorization: 'Bearer owner' }, signal: AbortSignal.timeout(Math.min(3000, deadlineMs - (Date.now() - start))) });
      last = 'HTTP_' + response.status;
      if (response.ok) { console.log(JSON.stringify({ event: 'ts01_ready', origin, elapsedMs: Date.now() - start })); return; }
    } catch (error) { last = error.name; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('EMULATOR_NOT_READY ' + origin + ' ' + last);
}
async function http(method, token, body) {
  const response = await fetch(apiOrigin + '/api/users/me', {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: await response.json() };
}
async function identity(suffix) {
  net.assertSafe();
  const uid = prefix + '-' + suffix; const email = uid + '@example.com';
  await auth.createUser({ uid, email, emailVerified: true, password: 'Emulator-Only1!' });
  const response = await fetch(authOrigin + '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Emulator-Only1!', returnSecureToken: true }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const { idToken } = await response.json();
  const decoded = await auth.verifyIdToken(idToken, true);
  assert.equal(decoded.uid, uid); assert.ok(Math.floor(Date.now()/1000) - decoded.auth_time <= 300);
  return { uid, token: idToken, username: uid.replaceAll('-', '_') };
}
async function profile(user) {
  const result = await http('POST', user.token, { nombre: 'Fixture', apellido: 'Integral', username: user.username });
  assert.equal(result.status, 201); assert.equal(result.body.data.uid, user.uid);
  return result;
}
async function connect(user) {
  const client = new TestSocketClient(socketOrigin, { token: user.token, uid: 'forged' });
  sockets.push(client); await client.wait('connect'); return client;
}
async function reconnectDenied(user) {
  const client = new TestSocketClient(socketOrigin, { token: user.token });
  sockets.push(client); return client.wait('connect_error');
}
async function completed(user) {
  const marker = (await db.doc('accountDeletions/' + user.uid).get()).data();
  assert.equal(marker.status, 'completed');
  assert.equal((await db.doc('users/' + user.uid).get()).exists, false);
  assert.equal((await db.doc('usernames/' + user.username.toLowerCase()).get()).exists, false);
  await assert.rejects(auth.getUser(user.uid), { code: 'auth/user-not-found' });
}
before(async () => {
  net.assertSafe();
  await Promise.all([ready(authOrigin, '/emulator/v1/projects/' + project + '/config'),
    ready(firestoreOrigin, '/v1/projects/' + project + '/databases/(default)/documents/users?pageSize=1')]);
  api = startApiServer(); await api.ready;
  realtime = createRealtimeRuntime(); await realtime.start(0);
  socketOrigin = 'http://127.0.0.1:' + realtime.httpServer.address().port; net.allow(socketOrigin);
  fixtureApp = initializeApp({ projectId: project, credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) } }, 'ts01-fixtures');
  auth = getAuth(fixtureApp); db = apiFirebase.getFirestoreDb();
  assert.equal(db.projectId, project);
  assert.equal(rtFirebase.getFirebaseInfo().projectId, project);
  assert.equal(apiFirebase.getFirebaseAuth().app.name, 'teamspeak-api');
  assert.equal(rtFirebase.getFirebaseInfo().appName, 'teamspeak-realtime');
}, { timeout: 25000 });
after(async () => {
  try {
    await Promise.all(sockets.map(client => client.close()));
  } finally {
    const closed = await Promise.allSettled([realtime?.stop(), api?.stop()]);
    if (fixtureApp) await deleteApp(fixtureApp);
    assert.ok(closed.every(result => result.status === 'fulfilled'), 'Service cleanup failed');
  }
});
test('A–D/F/G: HTTP profiles → DELETE intent → idle disconnect → processor; B remains authorized', { timeout: 20000 }, async () => {
  const a = await identity('a'); const b = await identity('b');
  assert.notEqual(a.uid, b.uid);
  await profile(a); await profile(b);
  assert.equal((await http('GET', a.token)).body.data.profile.username, a.username);
  assert.equal((await http('PATCH', a.token, { nombre: 'Actualizado' })).status, 200);
  assert.equal((await http('GET', a.token)).body.data.profile.nombre, 'Actualizado');
  assert.equal((await http('GET', b.token)).body.data.profile.nombre, 'Fixture');
  const sa = await connect(a); const sb = await connect(b);
  await sa.request('room:join', { roomId: 'joint-room' }); await sb.request('room:join', { roomId: 'joint-room' });
  assert.deepEqual(await sa.request('chat:send', { text: 'real HTTP and WebSocket', uid: b.uid }), { ok: true });
  assert.equal((await sb.wait('chat:message')).authorId, a.uid);
  net.assertSafe();
  const deletion = await http('DELETE', a.token);
  assert.equal(deletion.status, 202); assert.deepEqual(deletion.body, { success: true, data: { status: 'pending' } });
  const marker = (await db.doc('accountDeletions/' + a.uid).get()).data();
  assert.equal(marker.status, 'pending'); assert.equal(marker.phase, 'auth');
  assert.deepEqual(marker.usernameKeys, [a.username.toLowerCase()]);
  await sa.wait('disconnect'); // No event from A after DELETE.
  assert.deepEqual(await sb.request('room:join', { roomId: 'joint-room' }), { ok: true });
  assert.equal(realtime.io.sockets.adapter.rooms.get('joint-room').size, 1);
  assert.equal((await reconnectDenied(a)).message, 'ACCOUNT_UNAVAILABLE');
  for (const method of ['GET','POST','PATCH']) {
    const response = await http(method, a.token, method === 'GET' ? undefined : { nombre: 'Denied' });
    assert.equal(response.status, 403); assert.equal(response.body.code, 'ACCOUNT_DELETION_PENDING');
  }
  assert.equal((await http('GET', b.token)).status, 200);
  const result = await processAccountDeletion(a.uid);
  assert.equal(result.status, 'completed'); await completed(a);
  const repeat = await processAccountDeletion(a.uid);
  assert.equal(repeat.attempts, result.attempts);
  assert.equal((await reconnectDenied(a)).message, 'AUTH_INVALID');
  assert.equal((await http('GET', a.token)).status, 401);
  assert.deepEqual(await sb.request('media:state', {}), { ok: true });
});
test('E: two sessions of A disconnect after API DELETE, B remains connected', { timeout: 15000 }, async () => {
  const a = await identity('multi'); const b = await identity('other');
  await profile(a); await profile(b);
  const first = await connect(a); const second = await connect(a); const other = await connect(b);
  for (const socket of [first, second, other]) await socket.request('room:join', { roomId: 'multi-room' });
  assert.equal((await http('DELETE', a.token)).status, 202);
  await Promise.all([first.wait('disconnect'), second.wait('disconnect')]);
  assert.deepEqual(await other.request('room:join', { roomId: 'multi-room' }), { ok: true });
  assert.equal(realtime.io.sockets.adapter.rooms.get('multi-room').size, 1);
  assert.equal((await reconnectDenied(a)).message, 'ACCOUNT_UNAVAILABLE');
  await processAccountDeletion(a.uid); await completed(a);
});
test('F: malformed marker fixture blocks both real backends by existence', { timeout: 15000 }, async () => {
  const user = await identity('malformed'); await profile(user);
  const socket = await connect(user);
  // Independent negative fixture; the principal deletion scenarios above use real HTTP DELETE.
  await db.doc('accountDeletions/' + user.uid).create({ fixture: 'malformed' });
  await socket.wait('disconnect');
  assert.equal((await http('GET', user.token)).status, 403);
  assert.equal((await reconnectDenied(user)).message, 'ACCOUNT_UNAVAILABLE');
});
test('H: real partial processor failure persists backoff, a new reconciler recovers pending/firestore', { timeout: 50000 }, async () => {
  const user = await identity('recover'); await profile(user);
  const socket = await connect(user);
  assert.equal((await http('DELETE', user.token)).status, 202); await socket.wait('disconnect');
  const failed = await processAccountDeletion(user.uid, { beforeCleanupCommit: () => { throw new Error('controlled fixture failure'); } });
  assert.equal(failed.status, 'pending'); assert.equal(failed.phase, 'firestore'); assert.ok(failed.nextAttemptAt.toMillis() > Date.now());
  await assert.rejects(auth.getUser(user.uid), { code: 'auth/user-not-found' });
  process.env.TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS = 'true';
  let first, next;
  try {
    first = createAccountDeletionReconciler();
    await first.runOnce();
    const waiting = (await db.doc('accountDeletions/' + user.uid).get()).data();
    assert.equal(waiting.attempts, 1); assert.equal(waiting.nextAttemptAt.toMillis(), failed.nextAttemptAt.toMillis());
    await first.stop();
    const due = failed.nextAttemptAt.toMillis();
    while (Date.now() < due) await new Promise(resolve => setTimeout(resolve, Math.min(200, due - Date.now())));
    next = createAccountDeletionReconciler(); await next.start(); await next.stop();
    await completed(user);
    assert.equal((await reconnectDenied(user)).message, 'AUTH_INVALID');
    assert.equal((await db.doc('accountDeletions/' + user.uid).get()).data().attempts, 2);
  } finally {
    await first?.stop(); await next?.stop(); delete process.env.TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS;
  }
});
test('controlled failures: invalid token, unavailable Auth transport, bounded readiness and remote rejection', { timeout: 15000 }, async () => {
  assert.equal((await http('GET', 'invalid')).status, 401);
  const user = await identity('outage');
  net.block(authOrigin);
  try {
    const socket = new TestSocketClient(socketOrigin, { token: user.token }); sockets.push(socket);
    assert.ok(['AUTH_INVALID','AUTHORIZATION_UNAVAILABLE'].includes((await socket.wait('connect_error')).message));
  } finally { net.unblock(authOrigin); }
  net.block(firestoreOrigin);
  try { await assert.rejects(ready(firestoreOrigin, '/unavailable', 300), /EMULATOR_NOT_READY/); }
  finally { net.unblock(firestoreOrigin); }
  const savedHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  try {
    assert.throws(() => net.assertSafe(), /UNSAFE_TS01_ENVIRONMENT/);
    await assert.rejects(processAccountDeletion(user.uid), error => error.code === 'NOT_IMPLEMENTED');
  } finally { process.env.FIREBASE_AUTH_EMULATOR_HOST = savedHost; }
  assert.equal((await auth.getUser(user.uid)).uid, user.uid);
  assert.throws(() => fetch('https://www.googleapis.com/'), /TEST_NETWORK_BLOCKED/);
  assert.throws(() => require('node:https').request('https://www.googleapis.com/'), /TEST_NETWORK_BLOCKED/);
});

test('US-01 verification: native email link, stale token denial, refreshed token HTTP and Socket.IO access', { timeout: 20000 }, async () => {
  const user = await registeredIdentity('verification');
  assert.equal((await auth.verifyIdToken(user.token)).email_verified, false);
  const input = { nombre: 'Ana', apellido: 'Pérez', username: user.username };
  const created = await http('POST', user.token, input);
  assert.equal(created.status, 201); assert.equal(created.body.data.profile.avatarUrl, null);
  assert.equal((await http('GET', user.token)).body.data.profileStatus, 'complete');
  const denied = await http('PATCH', user.token, { nombre: 'Denied', emailVerified: true });
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'EMAIL_NOT_VERIFIED');
  const forged = await http('POST', user.token, { ...input, email_verified: true });
  assert.equal(forged.status, 400);
  assert.equal((await reconnectDenied(user)).message, 'EMAIL_NOT_VERIFIED');
  const sent = await fetch(authOrigin + '/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: user.token }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(sent.status, 200);
  const codes = await fetch(authOrigin + '/emulator/v1/projects/' + project + '/oobCodes', { signal: AbortSignal.timeout(5000) });
  assert.equal(codes.status, 200);
  const code = (await codes.json()).oobCodes.find(item => item.email === user.email && item.requestType === 'VERIFY_EMAIL');
  assert.ok(code);
  const applied = await fetch(authOrigin + '/identitytoolkit.googleapis.com/v1/accounts:update?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oobCode: code.oobCode }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(applied.status, 200); assert.equal((await auth.getUser(user.uid)).emailVerified, true);
  assert.equal((await http('PATCH', user.token, { nombre: 'Stale' })).body.code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await reconnectDenied(user)).message, 'EMAIL_NOT_VERIFIED');
  const refreshed = await fetch(authOrigin + '/securetoken.googleapis.com/v1/token?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: user.refreshToken }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(refreshed.status, 200);
  const updated = { ...user, token: (await refreshed.json()).id_token };
  assert.equal((await auth.verifyIdToken(updated.token, true)).email_verified, true);
  const changed = await http('PATCH', updated.token, { avatarUrl: 'https://example.invalid/custom.png' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.profile.avatarUrl, 'https://example.invalid/custom.png');
  assert.equal((await http('PATCH', updated.token, { avatarUrl: null })).body.data.profile.avatarUrl, null);
  const socket = await connect(updated);
  assert.deepEqual(await socket.request('room:join', { roomId: 'verified-room' }), { ok: true });
  await socket.close();
});

// Synthetic Google credential accepted only by Authentication Emulator; no Google OAuth request.
async function googleIdentity(suffix, verified = true) {
  net.assertSafe();
  const sub = prefix + '-google-' + suffix;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const credential = encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ sub, email: sub + '@example.com', email_verified: verified, name: 'Google Fixture', picture: 'https://example.com/avatar.png' }) + '.';
  const response = await fetch(authOrigin + '/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postBody: new URLSearchParams({ id_token: credential, providerId: 'google.com' }).toString(), requestUri: 'http://localhost', returnSecureToken: true }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const result = await response.json(); const decoded = await auth.verifyIdToken(result.idToken, true);
  assert.equal(decoded.firebase.sign_in_provider, 'google.com');
  assert.equal((await auth.getUser(decoded.uid)).providerData[0].providerId, 'google.com');
  return { uid: decoded.uid, token: result.idToken, username: 'Google_' + suffix + '_' + prefix.slice(-8) };
}
async function privateRooms(user) {
  const response = await fetch(apiOrigin + '/api/rooms', { headers: { Authorization: 'Bearer ' + user.token }, signal: AbortSignal.timeout(8000) });
  return { status: response.status, body: await response.json() };
}
test('US-02 Google: first login requires profile; completion permits HTTP and real WebSocket; recurrent login preserves reservations', { timeout: 20000 }, async () => {
  const user = await googleIdentity('first');
  assert.equal((await http('GET', user.token)).body.data.profileStatus, 'incomplete');
  assert.equal((await privateRooms(user)).body.code, 'PROFILE_INCOMPLETE');
  const patch = await http('PATCH', user.token, { nombre: 'Forged', profileStatus: 'complete' });
  assert.equal(patch.status, 403); assert.equal(patch.body.code, 'PROFILE_INCOMPLETE');
  assert.equal((await reconnectDenied(user)).data.code, 'PROFILE_INCOMPLETE');
  for (const forged of [{ uid: 'other' }, { email: 'other@example.com' }, { profileStatus: 'complete' }]) {
    assert.equal((await http('POST', user.token, { nombre: 'Google', apellido: 'Fixture', username: user.username, ...forged })).status, 400);
  }
  await profile(user);
  assert.equal((await http('GET', user.token)).body.data.profile.avatarUrl, null);
  assert.equal((await http('PATCH', user.token, { nombre: 'Actualizado' })).status, 200);
  assert.equal((await privateRooms(user)).status, 501); // Existing placeholder reached after authorization.
  const socket = await connect(user); assert.equal((await socket.request('room:join', { roomId: 'google-room' })).ok, true);
  const before = await db.doc('users/' + user.uid).get();
  const recurrent = await googleIdentity('first'); assert.equal(recurrent.uid, user.uid);
  assert.equal((await http('GET', recurrent.token)).body.data.profile.username, user.username);
  assert.equal((await db.collection('usernames').where('uid', '==', user.uid).get()).size, 1);
  assert.ok((await db.doc('users/' + user.uid).get()).updateTime.isEqual(before.updateTime));
  await connect(recurrent);
});
test('US-02 Google: interrupted onboarding leaves no reservations and can resume', { timeout: 15000 }, async () => {
  const first = await googleIdentity('resume');
  assert.equal((await db.doc('users/' + first.uid).get()).exists, false);
  assert.equal((await db.collection('usernames').where('uid', '==', first.uid).get()).size, 0);
  const resumed = await googleIdentity('resume'); assert.equal(resumed.uid, first.uid);
  assert.equal((await privateRooms(resumed)).body.code, 'PROFILE_INCOMPLETE');
  await profile(resumed); await connect(resumed);
});
test('US-02 Google: concurrent case-insensitive usernames have one transactional winner', { timeout: 15000 }, async () => {
  const a = await googleIdentity('raceA'); const b = await googleIdentity('raceB');
  const results = await Promise.all([http('POST', a.token, { nombre: 'A', apellido: 'Fixture', username: a.username }), http('POST', b.token, { nombre: 'B', apellido: 'Fixture', username: a.username.toLowerCase() })]);
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.find(r => r.status !== 201).body.code, 'USERNAME_TAKEN');
  const loser = results[0].status === 201 ? b : a;
  assert.equal((await db.doc('users/' + loser.uid).get()).exists, false);
  assert.equal((await db.collection('usernames').where('uid', '==', loser.uid).get()).size, 0);
  assert.equal((await reconnectDenied(loser)).data.code, 'PROFILE_INCOMPLETE');
});
test('US-02 Google: persisted partial and inconsistent profiles are distinct from completed authorization', { timeout: 15000 }, async () => {
  const user = await googleIdentity('partial'); const ref = db.doc('users/' + user.uid);
  await ref.create({ uid: user.uid, profileStatus: 'incomplete' });
  assert.equal((await http('GET', user.token)).body.data.profileStatus, 'incomplete');
  assert.equal((await privateRooms(user)).body.code, 'PROFILE_INCOMPLETE');
  assert.equal((await reconnectDenied(user)).data.code, 'PROFILE_INCOMPLETE');
  await ref.set({ uid: 'other', profileStatus: 'complete' });
  const response = await privateRooms(user); assert.equal(response.status, 409); assert.equal(response.body.code, 'PROFILE_INCONSISTENT');
  assert.equal((await reconnectDenied(user)).data.code, 'PROFILE_INCONSISTENT');
});

test('shutdown with an active observed socket is idempotent and leaves API independently usable', { timeout: 15000 }, async () => {
  const user = await identity('shutdown'); await profile(user);
  const socket = await connect(user); await socket.request('room:join', { roomId: 'shutdown-room' });
  const stopping = realtime.stop(); assert.equal(realtime.stop(), stopping);
  await socket.wait('disconnect'); await stopping;
  assert.equal(realtime.io.sockets.sockets.size, 0);
  assert.equal(realtime.io.sockets.adapter.rooms.size, 0);
  assert.equal(realtime.httpServer.listening, false);
  assert.equal((await http('GET', user.token)).status, 200);
});

// US-01 uses the client Authentication endpoint: Admin never creates these identities.
async function manualSignup(email, password = require('node:crypto').randomUUID() + 'aA1!') {
  net.assertSafe();
  const response = await fetch(authOrigin + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
async function registeredIdentity(suffix) {
  const email = prefix + '-' + suffix + '@example.invalid';
  const result = await manualSignup(email);
  assert.equal(result.status, 200);
  const { localId: uid, idToken: token } = result.data;
  const decoded = await auth.verifyIdToken(token, true);
  assert.equal(decoded.uid, uid); assert.equal(decoded.email, email);
  return { uid, token, email, refreshToken: result.data.refreshToken, username: 'Manual_' + require('node:crypto').randomUUID().slice(0, 16).replaceAll('-', '_') };
}
const registrationBody = user => ({ nombre: 'Ana María', apellido: 'Pérez García', username: user.username, avatarUrl: 'https://example.invalid/avatar.png' });

test('US-01: client signup → incomplete identity → HTTP profile → persisted GET and idempotent retry', { timeout: 15000 }, async () => {
  const user = await registeredIdentity('manual');
  const incomplete = await http('GET', user.token);
  assert.equal(incomplete.status, 200);
  assert.deepEqual(incomplete.body.data, { uid: user.uid, profileStatus: 'incomplete', profile: null });
  assert.equal((await auth.getUser(user.uid)).email, user.email);
  const input = registrationBody(user);
  const created = await http('POST', user.token, input);
  assert.equal(created.status, 201); assert.equal(created.body.success, true);
  assert.equal(created.body.data.profileStatus, 'complete');
  const profileRef = db.doc('users/' + user.uid);
  const stored = await profileRef.get();
  assert.equal(stored.data().uid, user.uid); assert.equal(stored.data().email, user.email);
  for (const [key, value] of Object.entries(input)) assert.equal(stored.data()[key], value);
  assert.equal(stored.data().usernameKey, user.username.toLowerCase());
  assert.equal(stored.data().profileStatus, 'complete');
  assert.ok(stored.data().createdAt.toMillis() > 0); assert.ok(stored.data().updatedAt.toMillis() > 0);
  assert.deepEqual((await db.doc('usernames/' + user.username.toLowerCase()).get()).data(), { uid: user.uid, usernameKey: user.username.toLowerCase() });
  assert.equal(Object.hasOwn(stored.data(), 'password'), false);
  const fetched = await http('GET', user.token);
  assert.equal(fetched.status, 200); assert.deepEqual(fetched.body.data, created.body.data);
  const repeated = await http('POST', user.token, input);
  assert.equal(repeated.status, 200); assert.deepEqual(repeated.body, created.body);
  assert.ok((await profileRef.get()).updateTime.isEqual(stored.updateTime));
  assert.equal((await db.collection('users').where('uid', '==', user.uid).get()).size, 1);
  assert.equal((await db.collection('usernames').where('uid', '==', user.uid).get()).size, 1);
});

test('US-01: another identity cannot claim a profile, forge its email or submit a password to profiles', { timeout: 15000 }, async () => {
  const owner = await registeredIdentity('owner'); const other = await registeredIdentity('intruder');
  const input = registrationBody(owner);
  assert.equal((await http('POST', owner.token, input)).status, 201);
  const before = await db.doc('users/' + owner.uid).get();
  for (const forbidden of [{ uid: owner.uid }, { email: owner.email }, { password: require('node:crypto').randomUUID() }]) {
    const response = await http('POST', other.token, { ...registrationBody(other), ...forbidden });
    assert.equal(response.status, 400); assert.equal(response.body.code, 'VALIDATION_ERROR');
  }
  const taken = await http('POST', other.token, { ...registrationBody(other), username: owner.username.toLowerCase() });
  assert.equal(taken.status, 409); assert.equal(taken.body.code, 'USERNAME_TAKEN');
  const query = await fetch(apiOrigin + '/api/users/me?uid=' + encodeURIComponent(owner.uid), { headers: { Authorization: 'Bearer ' + other.token }, signal: AbortSignal.timeout(8000) });
  assert.equal(query.status, 200);
  assert.deepEqual((await query.json()).data, { uid: other.uid, profileStatus: 'incomplete', profile: null });
  assert.ok((await db.doc('users/' + owner.uid).get()).updateTime.isEqual(before.updateTime));
  assert.equal((await db.doc('users/' + other.uid).get()).exists, false);
  assert.equal((await auth.getUser(other.uid)).email, other.email);
});

test('US-01: two HTTP registrations competing for a case-insensitive username have one persisted winner', { timeout: 15000 }, async () => {
  const first = await registeredIdentity('race-a'); const second = await registeredIdentity('race-b');
  const results = await Promise.all([
    http('POST', first.token, registrationBody(first)),
    http('POST', second.token, { ...registrationBody(second), username: first.username.toLowerCase() }),
  ]);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  const rejected = results.find(result => result.status !== 201);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'USERNAME_TAKEN');
  const winner = results[0].status === 201 ? first : second;
  const loser = winner === first ? second : first;
  assert.equal((await db.doc('usernames/' + first.username.toLowerCase()).get()).data().uid, winner.uid);
  assert.equal((await db.doc('users/' + winner.uid).get()).data().usernameKey, first.username.toLowerCase());
  assert.equal((await db.doc('users/' + loser.uid).get()).exists, false);
  assert.equal((await db.collection('usernames').where('uid', '==', loser.uid).get()).size, 0);
  assert.equal((await http('GET', loser.token)).body.data.profileStatus, 'incomplete');
  assert.equal((await auth.getUser(loser.uid)).email, loser.email);
});

test('US-01: Authentication Emulator rejects duplicate email independently of the profile API', { timeout: 15000 }, async () => {
  const user = await registeredIdentity('duplicate-email');
  const duplicate = await manualSignup(user.email);
  assert.equal(duplicate.status, 400); assert.equal(duplicate.data.error.message, 'EMAIL_EXISTS');
  assert.equal((await auth.listUsers()).users.filter(identity => identity.email === user.email).length, 1);
  assert.equal((await db.doc('users/' + user.uid).get()).exists, false);
  assert.equal((await db.collection('usernames').where('uid', '==', user.uid).get()).size, 0);
  const profile = await http('POST', user.token, registrationBody(user));
  assert.equal(profile.status, 201); assert.equal(profile.body.data.profile.email, user.email);
});

for (const domain of ['gmail.com', 'outlook.com', 'university.example']) {
  test('US-01: accepts a valid email domain without an institutional allowlist: ' + domain, { timeout: 15000 }, async () => {
    const email = prefix + '-domain@' + domain;
    const signup = await manualSignup(email); assert.equal(signup.status, 200);
    const user = { uid: signup.data.localId, token: signup.data.idToken, username: 'Domain_' + require('node:crypto').randomUUID().slice(0, 16).replaceAll('-', '_') };
    const response = await http('POST', user.token, { nombre: 'Fixture', apellido: 'Domain', username: user.username });
    assert.equal(response.status, 201); assert.equal(response.body.data.profile.email, email);
    assert.equal(response.body.data.profile.avatarUrl, null);
    assert.equal((await db.doc('users/' + user.uid).get()).data().email, email);
  });
}
test('US-01: emulator password minimum is not evidence of the agreed production complexity policy', { timeout: 15000 }, async () => {
  const weak = require('node:crypto').randomUUID().replaceAll('-', '').slice(0, 6).toLowerCase();
  const accepted = await manualSignup(prefix + '-weak@example.invalid', weak);
  assert.equal(accepted.status, 200); // Installed emulator only enforces its six-character minimum.
  const rejected = await manualSignup(prefix + '-short@example.invalid', weak.slice(0, 1));
  assert.equal(rejected.status, 400); assert.match(rejected.data.error.message, /^WEAK_PASSWORD/);
});
