// REST with a Firebase ID token (or no token) is subject to Security Rules.
// Only fixture setup/assertions use Admin; its authorization is deliberately separate.
const { assertSafe } = require('../integration-ts01/isolation.cjs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.join(__dirname, '../backend-api/package.json'));
const { Firestore } = apiRequire('firebase-admin/firestore');
const project = 'demo-teamspeak-tests';
const { tmpdir } = require('node:os');
const directory = process.env.TEAMSPEAK_RULES_RUN_DIRECTORY;
if (!directory || path.dirname(directory) !== tmpdir() || !path.basename(directory).startsWith('teamspeak-rules-')) throw new Error('USE_RULES_LAUNCHER');
const owner = statSync(directory);
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077)
  || manifest.project !== project || manifest.nonce !== process.env.TEAMSPEAK_RULES_RUN_NONCE) throw new Error('INVALID_RULES_RUN');
const host = process.env.FIRESTORE_EMULATOR_HOST;
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
let db, token, uid;
async function request(url, options = {}) {
  assertSafe();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
const fields = { username: { stringValue: 'rules_user' } };
async function denied(method, resource, authenticated, body) {
  const response = await request(base + '/' + resource, { method, headers: {
    'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.equal(response.body.error.status, 'PERMISSION_DENIED');
}
before(async () => {
  assertSafe();
  // This is the real repository file, never an inline replacement rule set.
  assert.match(readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8'), /allow read, write: if false;/);
  db = new Firestore({ projectId: project, host, port: +host.split(':')[1], ssl: false,
    credentials: { client_email: 'emulator@example.invalid', private_key: 'emulator-only-not-a-key' } });
  const signup = await request(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rules@example.invalid', password: 'Fictitious-123!', returnSecureToken: true }) });
  assert.equal(signup.status, 200); token = signup.body.idToken; uid = signup.body.localId;
  assert.ok(token && uid);
  const lookup = await request(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=emulator-only`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  assert.equal(lookup.status, 200); assert.equal(lookup.body.users[0].localId, uid);
  for (const resource of [`users/${uid}`, 'users/other', 'usernames/rules_user', 'accountDeletions/fixture']) {
    await db.doc(resource).set({ fixture: true });
  }
}, { timeout: 15000 });
after(async () => {
  if (db) {
    try {
      for (const resource of [`users/${uid}`, 'users/other', 'users/admin-probe', 'usernames/rules_user', 'accountDeletions/fixture']) await db.doc(resource).delete();
    } finally { await db.terminate(); }
  }
});
for (const authenticated of [false, true]) {
  const label = authenticated ? 'authenticated' : 'anonymous';
  const cases = [
    ['read own profile', 'GET', () => `users/${uid}`],
    ['read other profile', 'GET', () => 'users/other'],
    ['list profiles', 'GET', () => 'users'],
    ['create profile', 'POST', () => 'users?documentId=new-profile', { fields }],
    ['update own profile', 'PATCH', () => `users/${uid}`, { fields }],
    ['update other profile', 'PATCH', () => 'users/other', { fields }],
    ['delete profile', 'DELETE', () => `users/${uid}`],
    ['read reservation', 'GET', () => 'usernames/rules_user'],
    ['list reservations', 'GET', () => 'usernames'],
    ['create reservation', 'POST', () => 'usernames?documentId=new-name', { fields }],
    ['update reservation', 'PATCH', () => 'usernames/rules_user', { fields }],
    ['delete reservation', 'DELETE', () => 'usernames/rules_user'],
    ['read deletion marker', 'GET', () => 'accountDeletions/fixture'],
    ['write deletion marker', 'PATCH', () => 'accountDeletions/fixture', { fields }],
    ['write unmatched nested path', 'PATCH', () => 'rulesProbe/fixture/nested/item', { fields }],
    ['read unmatched path', 'GET', () => 'rulesProbe/fixture'],
  ];
  for (const [name, method, resource, body] of cases) test(`${label}: ${name}`, () => denied(method, resource(), authenticated, body));
}
test('Admin bypasses rules: create, read, list, update and delete remain available', async () => {
  const ref = db.doc('users/admin-probe');
  await ref.set({ fixture: true }); assert.equal((await ref.get()).data().fixture, true);
  await ref.update({ fixture: false }); assert.equal((await ref.get()).data().fixture, false);
  assert.ok((await db.collection('users').get()).size >= 3);
  await ref.delete(); assert.equal((await ref.get()).exists, false);
});
test('emulator reports the exact rules file loaded from the repository', async () => {
  const response = await request(`http://${host}/emulator/v1/projects/${project}:ruleCoverage`);
  assert.equal(response.status, 200);
  const filename = path.join(__dirname, '../firestore.rules');
  const files = response.body.rules.files;
  assert.equal(files.length, 1);
  assert.equal(path.resolve(files[0].name), path.resolve(filename));
  assert.equal(files[0].content, readFileSync(filename, 'utf8'));
});

test('remote transports are blocked before any network request', () => {
  assert.throws(() => fetch('https://firestore.googleapis.com/'), /TEST_NETWORK_BLOCKED/);
  assert.throws(() => require('node:https').request('https://firestore.googleapis.com/'), /TEST_NETWORK_BLOCKED/);
  assert.throws(() => require('node:http2').connect('https://firestore.googleapis.com/'), /TEST_NETWORK_BLOCKED/);
});
