import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { withDeletionEmulatorClients } from './deletion-emulator-clients';
const projectId = 'demo-teamspeak-tests';
let primaryDb: { terminate(): Promise<void> } | undefined;
async function load() {
  vi.resetModules(); vi.doMock('./env', () => ({ env: { NODE_ENV: 'test', FIREBASE_PROJECT_ID: projectId } }));
  return import('./firebase.js');
}
beforeEach(() => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, DOTENV_CONFIG_PATH: '/dev/null', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })) vi.stubEnv(key, value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(key, '');
});
afterEach(async () => {
  await primaryDb?.terminate(); primaryDb = undefined;
  await Promise.all(getApps().map((app) => deleteApp(app))); vi.unstubAllEnvs();
});
it('never adopts a temporary deletion app and retains usable main Auth after its scope closes (P2)', async () => {
  const api = await load(); let mainName = '';
  await withDeletionEmulatorClients(async ({ auth }) => {
    const primary = api.getFirebaseAuth(); mainName = primary.app.name;
    expect(mainName).toBe('teamspeak-api'); expect(primary.app).not.toBe(auth.app);
    primaryDb = api.getFirestoreDb(); expect(primaryDb).toBe(api.getFirestoreDb());
  });
  const primary = api.getFirebaseAuth(); expect(primary.app.name).toBe(mainName);
  expect(() => getAuth(primary.app)).not.toThrow(); expect(getApps().map((app) => app.name)).toEqual(['teamspeak-api']);
});
it('reuses only its own app and rejects a name collision with mismatched configuration', async () => {
  const api = await load(); const first = api.getFirebaseAuth(); expect(api.getFirebaseAuth()).toBe(first);
  await deleteApp(first.app);
  initializeApp({ projectId: 'other', credential: { getAccessToken: async () => { throw new Error('No network'); } } }, 'teamspeak-api');
  expect(() => api.getFirebaseAuth()).toThrow('no coincide');
});
it('rejects a same-project collision with a different credential owner', async () => {
  initializeApp({ projectId, credential: { getAccessToken: async () => ({ access_token: 'untrusted', expires_in: 1 }) } }, 'teamspeak-api');
  const api = await load(); expect(() => api.getFirebaseAuth()).toThrow('no coincide');
});
it('ignores an arbitrary registered app and creates the main app independently', async () => {
  const other = initializeApp({ projectId, credential: { getAccessToken: async () => ({ access_token: 'fixture', expires_in: 1 }) } }, 'other-owner');
  const api = await load(); expect(api.getFirebaseAuth().app).not.toBe(other); expect(api.getFirebaseAuth().app.name).toBe('teamspeak-api');
});

it('closes only main-owned resources and leaves a temporary scope usable', async () => {
  const api = await load(); api.getFirebaseAuth(); primaryDb = api.getFirestoreDb();
  await withDeletionEmulatorClients(async ({ auth }) => {
    const name = auth.app.name; await api.closeFirebase(); primaryDb = undefined;
    expect(auth.app.name).toBe(name); expect(getApps().map((app) => app.name)).toEqual([name]);
  });
  await api.closeFirebase(); expect(getApps()).toEqual([]);
});
