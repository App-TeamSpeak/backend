import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({
  apps: [] as { name: string; options: { projectId?: string; credential?: unknown } }[],
  initializeApp: vi.fn(), deleteApp: vi.fn(), getAuth: vi.fn(), getFirestore: vi.fn(), cert: vi.fn(),
  terminate: vi.fn(), Firestore: vi.fn(),
}));
vi.mock('firebase-admin/app', () => ({ initializeApp: sdk.initializeApp, deleteApp: sdk.deleteApp, getApps: () => sdk.apps, cert: sdk.cert }));
vi.mock('firebase-admin/auth', () => ({ getAuth: sdk.getAuth }));
vi.mock('firebase-admin/firestore', () => ({ Firestore: sdk.Firestore, getFirestore: sdk.getFirestore }));
const load = async () => { vi.resetModules(); return import('./firebase.js'); };
beforeEach(() => {
  vi.resetAllMocks(); sdk.apps = [];
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: 'demo-teamspeak-tests', FIREBASE_EXPECTED_PROJECT_ID: 'demo-teamspeak-tests', GCLOUD_PROJECT: 'demo-teamspeak-tests', DOTENV_CONFIG_PATH: '/dev/null', TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: 'true', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081' })) vi.stubEnv(key, value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(key, '');
  sdk.initializeApp.mockImplementation((options, name) => { const app = { options, name }; sdk.apps.push(app); return app; });
  sdk.deleteApp.mockImplementation(async (app) => { sdk.apps = sdk.apps.filter((value) => value !== app); });
  sdk.getAuth.mockReturnValue({ verifyIdToken: vi.fn() }); sdk.terminate.mockResolvedValue(undefined);
  sdk.Firestore.mockImplementation(function () { return { terminate: sdk.terminate }; });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('handles failed app construction without trying to delete foreign resources', async () => {
  sdk.apps.push({ name: 'foreign', options: {} }); sdk.initializeApp.mockImplementation(() => { throw new Error('PRIVATE'); });
  const f = await load(); await expect(f.initializeFirebase()).rejects.toMatchObject({ code: 'FIREBASE_INITIALIZATION_FAILED' });
  expect(sdk.deleteApp).not.toHaveBeenCalled(); expect(sdk.apps).toHaveLength(1);
});
it('cleans an app after partial Auth initialization fails', async () => {
  sdk.getAuth.mockImplementation(() => { throw new Error('PRIVATE'); }); const f = await load();
  await expect(f.initializeFirebase()).rejects.toMatchObject({ code: 'FIREBASE_INITIALIZATION_FAILED' });
  expect(sdk.deleteApp).toHaveBeenCalledOnce(); expect(sdk.Firestore).not.toHaveBeenCalled(); expect(sdk.apps).toEqual([]);
});
it('cleans the owned app after partial Firestore initialization fails', async () => {
  sdk.Firestore.mockImplementation(function () { throw new Error('PRIVATE'); }); const f = await load();
  await expect(f.initializeFirebase()).rejects.toMatchObject({ code: 'FIREBASE_INITIALIZATION_FAILED' });
  expect(sdk.deleteApp).toHaveBeenCalledOnce(); expect(sdk.apps).toEqual([]);
});
it('preserves initialization errors and records secondary cleanup failure safely', async () => {
  sdk.Firestore.mockImplementation(function () { throw new Error('PRIVATE initialization'); }); sdk.deleteApp.mockRejectedValue(new Error('PRIVATE cleanup'));
  const f = await load(); await expect(f.initializeFirebase()).rejects.toMatchObject({ code: 'FIREBASE_INITIALIZATION_FAILED' });
  expect(console.error).toHaveBeenCalledWith({ event: 'realtime_firebase_cleanup_failed', code: 'FIREBASE_CLEANUP_FAILED' });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE'); sdk.apps = [];
});
it('attempts app closure even when Firestore termination fails', async () => {
  const f = await load(); await f.initializeFirebase(); sdk.terminate.mockRejectedValue(new Error('PRIVATE'));
  await expect(f.closeFirebase()).rejects.toMatchObject({ code: 'FIREBASE_CLEANUP_FAILED' }); expect(sdk.deleteApp).toHaveBeenCalledOnce(); expect(sdk.apps).toEqual([]);
});
it('waits for termination and shares one shutdown promise', async () => {
  const f = await load(); await f.initializeFirebase(); let release!: () => void;
  sdk.terminate.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = f.closeFirebase(); expect(f.closeFirebase()).toBe(first); expect(sdk.deleteApp).not.toHaveBeenCalled(); release(); await first;
  expect(sdk.terminate).toHaveBeenCalledOnce(); expect(sdk.deleteApp).toHaveBeenCalledOnce();
});
it('rejects loss of its registered app instead of silently recreating clients', async () => {
  const f = await load(); f.getFirebaseInfo(); sdk.apps = [];
  expect(() => f.getFirebaseInfo()).toThrow('FIREBASE_APPLICATION_OWNERSHIP_LOST'); await f.closeFirebase(); expect(sdk.initializeApp).toHaveBeenCalledOnce();
});

it('verifies with the private owned SDK client and preserves the default revocation contract', async () => {
  const verify = vi.fn().mockResolvedValue({ uid: 'fixture-user' }); sdk.getAuth.mockReturnValue({ verifyIdToken: verify });
  const f = await load(); expect(await f.verifyFirebaseIdToken('fixture-token')).toEqual({ uid: 'fixture-user' });
  expect(verify).toHaveBeenCalledExactlyOnceWith('fixture-token'); await f.closeFirebase();
});

it('passes the explicit revocation option to the private client', async () => {
  const verify = vi.fn().mockResolvedValue({ uid: 'fixture-user' }); sdk.getAuth.mockReturnValue({ verifyIdToken: verify });
  const f = await load(); await f.verifyFirebaseIdToken('fixture-token', true);
  expect(verify).toHaveBeenCalledExactlyOnceWith('fixture-token', true); await f.closeFirebase();
});
it('rejects an authentication result completed after configuration changed', async () => {
  let complete!: (value: { uid: string }) => void;
  sdk.getAuth.mockReturnValue({ verifyIdToken: vi.fn(() => new Promise((resolve) => { complete = resolve; })) });
  const f = await load(); const verification = f.verifyFirebaseIdToken('fixture-token', true);
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8082'); complete({ uid: 'fixture' });
  await expect(verification).rejects.toMatchObject({ code: 'FIREBASE_CONFIGURATION_CHANGED' });
  await f.closeFirebase();
});
it('reads only marker existence and rejects a read completed after closure', async () => {
  const get = vi.fn().mockResolvedValue({ exists: true, data: () => { throw new Error('Must not read content'); } });
  const doc = vi.fn(() => ({ get })); const collection = vi.fn(() => ({ doc }));
  sdk.Firestore.mockImplementation(function () { return { terminate: sdk.terminate, collection }; });
  const f = await load(); expect(await f.hasAccountDeletion('fixture')).toBe(true);
  expect(collection).toHaveBeenCalledExactlyOnceWith('accountDeletions'); expect(doc).toHaveBeenCalledExactlyOnceWith('fixture');
  get.mockResolvedValueOnce({ exists: false }); expect(await f.hasAccountDeletion('fixture')).toBe(false);
  let complete!: (value: { exists: boolean }) => void;
  get.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const reading = f.hasAccountDeletion('fixture'); await f.closeFirebase(); complete({ exists: false });
  await expect(reading).rejects.toMatchObject({ code: 'FIREBASE_CLIENTS_CLOSED' });
});
it('owns marker subscriptions, suppresses late callbacks and closes them before Firestore', async () => {
  let changed!: (snapshot: { exists: boolean }) => void; const stop = vi.fn();
  sdk.Firestore.mockImplementation(function () { return { terminate: sdk.terminate, collection: () => ({ doc: () => ({
    onSnapshot: (next: typeof changed) => { changed = next; return stop; },
  }) }) }; });
  const f = await load(); const next = vi.fn(); const failed = vi.fn();
  const cancel = f.watchAccountDeletion('fixture', next, failed);
  changed({ exists: false }); expect(next).toHaveBeenCalledExactlyOnceWith(false);
  cancel(); cancel(); changed({ exists: true }); expect(next).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledOnce();
  f.watchAccountDeletion('fixture', next, failed);
  sdk.terminate.mockImplementation(async () => { expect(stop).toHaveBeenCalledTimes(2); });
  await f.closeFirebase(); expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'FIREBASE_CLIENTS_CLOSED' }));
});
it('rejects subscription callbacks after environment changes without revealing snapshot contents', async () => {
  let changed!: (snapshot: { exists: boolean }) => void; const stop = vi.fn();
  sdk.Firestore.mockImplementation(function () { return { terminate: sdk.terminate, collection: () => ({ doc: () => ({
    onSnapshot: (next: typeof changed) => { changed = next; return stop; },
  }) }) }; });
  const f = await load(); const next = vi.fn(); const failed = vi.fn();
  f.watchAccountDeletion('fixture', next, failed);
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8082'); changed({ exists: false });
  expect(next).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'FIREBASE_CONFIGURATION_CHANGED' }));
  expect(stop).toHaveBeenCalledOnce(); await f.closeFirebase();
});
it('sanitizes a subscription construction failure and leaves no owned registration behind', async () => {
  sdk.Firestore.mockImplementation(function () { return { terminate: sdk.terminate, collection: () => ({ doc: () => ({
    onSnapshot: () => { throw new Error('PRIVATE'); },
  }) }) }; });
  const f = await load(); const failed = vi.fn();
  const cancel = f.watchAccountDeletion('fixture', vi.fn(), failed); cancel();
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'FIREBASE_OBSERVER_FAILED' }));
  await f.closeFirebase(); expect(failed).toHaveBeenCalledOnce();
});
it('reads only the requested profile and rejects results settled after configuration drift', async () => {
  const value = { uid: 'fixture', profileStatus: 'incomplete' };
  const get = vi.fn().mockResolvedValue({ exists: true, data: () => value });
  const doc = vi.fn(() => ({ get })); const collection = vi.fn(() => ({ doc }));
  sdk.Firestore.mockImplementation(function () { return { terminate: sdk.terminate, collection }; });
  const f = await load();
  expect(await f.readUserProfile('fixture')).toEqual(value);
  expect(collection).toHaveBeenCalledExactlyOnceWith('users'); expect(doc).toHaveBeenCalledExactlyOnceWith('fixture');
  get.mockResolvedValueOnce({ exists: false }); expect(await f.readUserProfile('fixture')).toBeUndefined();
  let release!: (value: { exists: boolean }) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const reading = f.readUserProfile('fixture');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8082'); release({ exists: false });
  await expect(reading).rejects.toMatchObject({ code: 'FIREBASE_CONFIGURATION_CHANGED' });
  await f.closeFirebase();
});
