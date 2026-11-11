import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const project = 'demo-teamspeak-tests';
let firebase: typeof import('./firebase') | undefined;
let networkAttempt: ReturnType<typeof vi.fn>;
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function syntheticSignedShape() {
  const now = Math.floor(Date.now() / 1000);
  return `${encoded({ alg: 'RS256', kid: 'offline-fixture' })}.${encoded({ aud: project, iss: `https://securetoken.google.com/${project}`, sub: 'offline-fixture', iat: now, exp: now + 3600, auth_time: now })}.${Buffer.from('offline-signature').toString('base64url')}`;
}
beforeEach(() => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', FIREBASE_PROJECT_ID: project, FIREBASE_EXPECTED_PROJECT_ID: project, GCLOUD_PROJECT: project, DOTENV_CONFIG_PATH: '/dev/null', TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: 'true', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081' })) vi.stubEnv(key, value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(key, '');
  networkAttempt = vi.fn();
  const block = (): never => { networkAttempt(); throw new Error('OFFLINE_NETWORK_BLOCKED'); };
  vi.spyOn(http, 'request').mockImplementation(block);
  vi.spyOn(https, 'request').mockImplementation(block);
  vi.spyOn(http2, 'connect').mockImplementation(block);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => block());
});
afterEach(async () => {
  try { await firebase?.closeFirebase(); }
  finally { firebase = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
async function load() { vi.resetModules(); firebase = await import('./firebase.js'); await firebase.initializeFirebase(); return firebase; }
it('retained verification reference rejects a removed emulator host before any network attempt (P2)', async () => {
  const f = await load(); const retained = f.verifyFirebaseIdToken;
  expect(f).not.toHaveProperty('getFirebaseAuth');
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined);
  await expect(retained(syntheticSignedShape())).rejects.toMatchObject({ code: 'FIREBASE_CONFIGURATION_CHANGED' });
  expect(networkAttempt).not.toHaveBeenCalled();
});
it.each([
  ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9100'],
  ['FIREBASE_PROJECT_ID', 'fixture-wrong-project'],
  ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:8082'],
  ['TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS', 'false'],
])('retained verification revalidates changed %s at call time', async (key, value) => {
  const retained = (await load()).verifyFirebaseIdToken; vi.stubEnv(key, value);
  await expect(retained(syntheticSignedShape())).rejects.toMatchObject({ code: 'FIREBASE_CONFIGURATION_CHANGED' });
  expect(networkAttempt).not.toHaveBeenCalled();
});
it('retained verification cannot use a closed client', async () => {
  const f = await load(); const retained = f.verifyFirebaseIdToken; await f.closeFirebase();
  await expect(retained(syntheticSignedShape())).rejects.toMatchObject({ code: 'FIREBASE_CLIENTS_CLOSED' }); expect(networkAttempt).not.toHaveBeenCalled();
});
it('initialization and diagnostics expose no raw Auth, App or credential references', async () => {
  const f = await load(); expect(await f.initializeFirebase()).toBeUndefined();
  const info = f.getFirebaseInfo(); expect(info).toEqual({ appName: 'teamspeak-realtime', projectId: project });
  expect(Object.keys(info).sort()).toEqual(['appName', 'projectId']); expect(Object.isFrozen(info)).toBe(true);
  expect(f).not.toHaveProperty('getFirebaseAuth'); expect(f).not.toHaveProperty('application'); expect(networkAttempt).not.toHaveBeenCalled();
});

it('a retained marker read operation cannot bypass configuration or closure checks', async () => {
  const f = await load(); const read = f.hasAccountDeletion;
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8082');
  await expect(read('fixture')).rejects.toMatchObject({ code: 'FIREBASE_CONFIGURATION_CHANGED' });
  await f.closeFirebase();
  await expect(read('fixture')).rejects.toMatchObject({ code: 'FIREBASE_CLIENTS_CLOSED' });
  expect(networkAttempt).not.toHaveBeenCalled();
});
