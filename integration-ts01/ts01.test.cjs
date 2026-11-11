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
  await auth.createUser({ uid, email, password: 'Emulator-Only1!' });
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
