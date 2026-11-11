import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Firestore } from 'firebase-admin/firestore';
const project = 'demo-teamspeak-tests';
const syntheticKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let firebase: typeof import('./firebase') | undefined;
let foreign: App[];
function safe() {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: project, FIREBASE_EXPECTED_PROJECT_ID: project,
    GCLOUD_PROJECT: project, DOTENV_CONFIG_PATH: '/dev/null', TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: 'true',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081' })) vi.stubEnv(key, value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(key, '');
}
function normal(mode: 'development' | 'production' = 'development') {
  vi.stubEnv('NODE_ENV', mode); vi.stubEnv('TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS', 'false');
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', ''); vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
  vi.stubEnv('FIREBASE_CLIENT_EMAIL', 'fixture@example.invalid'); vi.stubEnv('FIREBASE_PRIVATE_KEY', syntheticKey);
}
async function load() { vi.resetModules(); firebase = await import('./firebase.js'); return firebase; }
function foreignApp(name: string, projectId = project) {
  const app = initializeApp({ projectId, credential: { getAccessToken: async () => { throw new Error('Remote token requests forbidden'); } } }, name);
  foreign.push(app); return app;
}
beforeEach(() => { foreign = []; firebase = undefined; safe(); });
afterEach(async () => {
  try { await firebase?.closeFirebase(); }
  finally {
    for (const app of foreign) if (getApps().includes(app)) await deleteApp(app);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  }
});
describe('realtime Firebase ownership and SDK construction, without remote requests', () => {
  it('creates one stable app and caches its own Auth and Firestore', async () => {
    const f = await load(); await f.initializeFirebase(); const auth = f.getFirebaseInfo(); const db = f.getFirestoreDb();
    expect(auth.appName).toBe('teamspeak-realtime'); expect(auth.projectId).toBe(project);
    expect('projectId' in db && db.projectId).toBe(project);
    await f.initializeFirebase(); expect(f.getFirebaseInfo()).toEqual(auth); expect(f.getFirestoreDb()).toBe(db);
    expect(getApps().filter((app) => app.name === 'teamspeak-realtime')).toHaveLength(1);
  });
  it('does not adopt or close a foreign app, even when registered first', async () => {
    const other = foreignApp('fixture-other'); const f = await load(); const own = f.getFirebaseInfo();
    expect(own.appName).not.toBe(other.name); await f.closeFirebase(); expect(getApps()).toContain(other); expect(other.name).toBe('fixture-other');
  });
  it.each([project, 'fixture-wrong-project'])('rejects a preexisting reserved app for project %s', async (projectId) => {
    const other = foreignApp('teamspeak-realtime', projectId); const f = await load();
    expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_APPLICATION_COLLISION'); await f.closeFirebase(); expect(getApps()).toContain(other);
  });
  it('rejects Auth created before configuring the emulator (original P1 pattern)', async () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', ''); const app = foreignApp('teamspeak-realtime'); const old = getAuth(app);
    const diagnostic = old as unknown as { authRequestHandler: { authResourceUrlBuilder: { urlFormat: string } } };
    expect(diagnostic.authRequestHandler.authResourceUrlBuilder.urlFormat).toMatch(/^https:\/\/identitytoolkit.googleapis.com\//);
    const verify = vi.spyOn(old, 'verifyIdToken').mockRejectedValue(new Error('Remote request forbidden'));
    safe(); const f = await load(); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_APPLICATION_COLLISION'); expect(verify).not.toHaveBeenCalled();
  });
  it('never uses a previously constructed remote Firestore client supplied as an extra argument', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const old = new Firestore({ projectId: project, host: 'remote.invalid:443', ssl: false, credentials: { client_email: 'fixture@example.invalid', private_key: 'not-a-key' } });
    const query = vi.spyOn(old, 'getAll').mockRejectedValue(new Error('Remote request forbidden'));
    try { safe(); const f = await load(); expect(Reflect.apply(f.getFirestoreDb, undefined, [old])).not.toBe(old); expect(query).not.toHaveBeenCalled(); }
    finally { await old.terminate(); }
  });
  it.each(['development', 'production'] as const)('preserves explicit service-account setup in %s', async (mode) => {
    normal(mode); const f = await load(); await f.initializeFirebase(); const auth = f.getFirebaseInfo(); const db = f.getFirestoreDb();
    expect(auth.appName).toBe('teamspeak-realtime'); expect(auth.projectId).toBe(project);
    expect('projectId' in db && db.projectId).toBe(project); expect(f.getFirebaseInfo()).toEqual(auth);
  });
  it('requires an expected deployment project in production', async () => {
    normal('production'); vi.stubEnv('FIREBASE_EXPECTED_PROJECT_ID', '');
    // Empty strings are not configured values; omit rather than pass an invalid env schema value.
    vi.stubEnv('FIREBASE_EXPECTED_PROJECT_ID', undefined);
    const f = await load(); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CONFIGURATION_INVALID');
  });
  it('rejects inherited emulator settings in normal mode', async () => {
    normal(); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099');
    const f = await load(); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CONFIGURATION_INVALID');
  });
  it('rejects a deployment project mismatch before constructing an app', async () => {
    normal(); vi.stubEnv('FIREBASE_EXPECTED_PROJECT_ID', 'fixture-other'); const before = getApps();
    const f = await load(); expect(() => f.getFirestoreDb()).toThrow('FIREBASE_CONFIGURATION_INVALID'); expect(getApps()).toEqual(before);
  });
  it('fails clearly without service-account configuration and never falls back to ADC', async () => {
    normal(); vi.stubEnv('FIREBASE_PRIVATE_KEY', undefined); const before = getApps();
    const f = await load(); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CONFIGURATION_INVALID'); expect(getApps()).toEqual(before);
  });
  it.each([
    ['NODE_ENV', 'production'], ['TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS', 'false'],
    ['FIREBASE_PROJECT_ID', 'fixture-real-project'], ['FIREBASE_EXPECTED_PROJECT_ID', 'fixture-other'], ['GCLOUD_PROJECT', 'fixture-other'],
    ['FIREBASE_AUTH_EMULATOR_HOST', ''], ['FIRESTORE_EMULATOR_HOST', ''],
    ['FIREBASE_AUTH_EMULATOR_HOST', 'remote.invalid:9099'], ['FIRESTORE_EMULATOR_HOST', 'https://127.0.0.1:8081'],
    ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:65536'], ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:0'],
    ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:8081'], ['DOTENV_CONFIG_PATH', 'fixture.env'],
    ['GOOGLE_APPLICATION_CREDENTIALS', 'synthetic-path'], ['FIREBASE_CLIENT_EMAIL', 'fixture@example.invalid'],
    ['FIREBASE_PRIVATE_KEY', 'synthetic-key'], ['FIREBASE_CONFIG', 'synthetic'], ['FIREBASE_TOKEN', 'synthetic'],
  ])('rejects unsafe %s before any SDK client is constructed', async (key, value) => {
    vi.stubEnv(key, value); const before = getApps(); const f = await load();
    expect(() => f.getFirebaseInfo()).toThrow(); expect(() => f.getFirestoreDb()).toThrow(); expect(getApps()).toEqual(before);
  });
  it('rejects changes after constructing clients and still permits owned cleanup', async () => {
    const f = await load(); f.getFirebaseInfo(); const app = getApps().find((value) => value.name === 'teamspeak-realtime')!;
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9100'); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CONFIGURATION_CHANGED');
    await f.closeFirebase(); expect(getApps()).not.toContain(app);
  });
  it('coalesces close calls, terminates Firestore and disallows use after close', async () => {
    const f = await load(); const db = f.getFirestoreDb(); const close = vi.spyOn(db, 'terminate');
    const first = f.closeFirebase(); expect(f.closeFirebase()).toBe(first); await first;
    expect(close).toHaveBeenCalledOnce(); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CLIENTS_CLOSED');
  });
  it('rejects replacement of an owned app without deleting the foreign replacement', async () => {
    const f = await load(); f.getFirebaseInfo(); const app = getApps().find((value) => value.name === 'teamspeak-realtime')!; await deleteApp(app);
    const replacement = foreignApp('teamspeak-realtime'); expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_APPLICATION_COLLISION');
    await expect(f.closeFirebase()).rejects.toThrow('FIREBASE_CLEANUP_FAILED'); expect(getApps()).toContain(replacement);
    // The expected rejected cleanup is idempotent; clear the test's automatic close reference.
    firebase = undefined;
  });
  it('rejects a normal configuration made stale before the first SDK construction', async () => {
    normal('production'); const f = await load(); const before = getApps(); vi.stubEnv('NODE_ENV', 'test');
    expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CONFIGURATION_CHANGED'); expect(getApps()).toEqual(before);
  });
  it('sanitizes invalid service-account configuration without constructing a client', async () => {
    normal(); vi.stubEnv('FIREBASE_PRIVATE_KEY', 'synthetic-invalid-key'); const before = getApps(); const f = await load();
    expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_CONFIGURATION_INVALID'); expect(getApps()).toEqual(before);
  });

});
