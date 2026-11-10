import { cert, deleteApp, getApps, initializeApp, type App, type AppOptions } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { env } from './env';

export const realtimeFirebaseAppName = 'teamspeak-realtime';
export const realtimeTestProject = 'demo-teamspeak-tests';
export class FirebaseConfigurationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'FirebaseConfigurationError'; }
}
const reject = (code = 'FIREBASE_CONFIGURATION_INVALID'): never => { throw new FirebaseConfigurationError(code); };
const flag = 'TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS';
const signatureKeys = ['NODE_ENV', 'FIREBASE_PROJECT_ID', 'FIREBASE_EXPECTED_PROJECT_ID', flag,
  'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'GCLOUD_PROJECT', 'DOTENV_CONFIG_PATH',
  'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN'];
function localPort(host: string | undefined): number | undefined {
  const match = /^127\.0\.0\.1:([1-9][0-9]*)$/.exec(host ?? '');
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}
class EmulatorCredential {
  async getAccessToken() { return { access_token: 'owner', expires_in: 3600 }; }
}
let config: { options: AppOptions; emulator: boolean; firestoreHost?: string; signature: (string | undefined)[] } | undefined;
let ownedApp: App | undefined;
let auth: Auth | undefined;
let firestore: Firestore | undefined;
let closing: Promise<void> | undefined;
let closed = false;
function configuration() {
  if (closed) return reject('FIREBASE_CLIENTS_CLOSED');
  const optional = (value: string | undefined) => value && value.trim() ? value : undefined;
  if ((process.env.NODE_ENV ?? 'development') !== env.NODE_ENV
    || optional(process.env.FIREBASE_PROJECT_ID) !== env.FIREBASE_PROJECT_ID
    || optional(process.env.FIREBASE_EXPECTED_PROJECT_ID) !== env.FIREBASE_EXPECTED_PROJECT_ID
    || optional(process.env[flag]) !== env.TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS
    || optional(process.env.FIREBASE_CLIENT_EMAIL) !== env.FIREBASE_CLIENT_EMAIL
    || optional(process.env.FIREBASE_PRIVATE_KEY) !== env.FIREBASE_PRIVATE_KEY) return reject('FIREBASE_CONFIGURATION_CHANGED');
  if (config) {
    if (signatureKeys.some((key, i) => process.env[key] !== config!.signature[i])) return reject('FIREBASE_CONFIGURATION_CHANGED');
    return config;
  }
  const emulator = env.TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS === 'true';
  const projectId = env.FIREBASE_PROJECT_ID;
  const expected = env.FIREBASE_EXPECTED_PROJECT_ID;
  let options: AppOptions;
  if (emulator) {
    const authPort = localPort(process.env.FIREBASE_AUTH_EMULATOR_HOST);
    const firestorePort = localPort(process.env.FIRESTORE_EMULATOR_HOST);
    if (env.NODE_ENV !== 'test' || process.env.NODE_ENV !== 'test' || process.env[flag] !== 'true'
      || projectId !== realtimeTestProject || process.env.FIREBASE_PROJECT_ID !== realtimeTestProject
      || expected !== realtimeTestProject || process.env.GCLOUD_PROJECT !== realtimeTestProject
      || process.env.DOTENV_CONFIG_PATH !== '/dev/null' || !authPort || !firestorePort || authPort === firestorePort
      || [env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY, ...['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN'].map((key) => process.env[key])].some(Boolean)) return reject('FIREBASE_EMULATOR_CONFIGURATION_INVALID');
    options = { projectId, credential: new EmulatorCredential() };
  } else {
    if (env.NODE_ENV === 'test' || process.env[flag] === 'true' || process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST
      || !projectId || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY
      || (expected && expected !== projectId) || (env.NODE_ENV === 'production' && !expected)) return reject();
    try { options = { projectId, credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) }; }
    catch { return reject(); }
  }
  config = { options, emulator, firestoreHost: emulator ? process.env.FIRESTORE_EMULATOR_HOST : undefined,
    signature: signatureKeys.map((key) => process.env[key]) };
  return config;
}
function application(): App {
  const current = configuration();
  const registered = getApps().find((app) => app.name === realtimeFirebaseAppName);
  // Project ID alone never establishes provenance, including in emulator mode.
  if (registered && registered !== ownedApp) return reject('FIREBASE_APPLICATION_COLLISION');
  if (ownedApp && registered !== ownedApp) return reject('FIREBASE_APPLICATION_OWNERSHIP_LOST');
  if (!ownedApp) {
    try { ownedApp = initializeApp(current.options, realtimeFirebaseAppName); }
    catch { return reject('FIREBASE_INITIALIZATION_FAILED'); }
  }
  if (ownedApp.options.projectId !== current.options.projectId || ownedApp.options.credential !== current.options.credential) return reject('FIREBASE_APPLICATION_COLLISION');
  return ownedApp;
}
function getFirebaseAuth(): Auth {
  const app = application();
  try { return auth ??= getAuth(app); }
  catch { return reject('FIREBASE_INITIALIZATION_FAILED'); }
}
// No raw Auth or App references cross this module's operational boundary.
export async function verifyFirebaseIdToken(token: string, checkRevoked?: boolean): Promise<DecodedIdToken> {
  // Keep validation and SDK invocation synchronous: no await between these calls.
  const client = getFirebaseAuth();
  const identity = await (checkRevoked === undefined ? client.verifyIdToken(token) : client.verifyIdToken(token, checkRevoked));
  configuration();
  return identity;
}
export function getFirebaseInfo(): Readonly<{ appName: string; projectId: string | undefined }> {
  const app = application();
  return Object.freeze({ appName: app.name, projectId: app.options.projectId });
}
export function getFirestoreDb(): Firestore {
  const app = application();
  const current = configuration();
  try {
    return firestore ??= current.emulator
      ? new Firestore({ projectId: realtimeTestProject, host: current.firestoreHost!, port: localPort(current.firestoreHost)!, ssl: false,
        credentials: { client_email: 'emulator@example.invalid', private_key: 'emulator-only-not-a-key' } })
      : getFirestore(app);
  } catch { return reject('FIREBASE_INITIALIZATION_FAILED'); }
}

// Narrow read operation: no retained Firestore handle in authorization services.
export async function hasAccountDeletion(uid: string): Promise<boolean> {
  if (!uid || uid.length > 128 || uid.includes('/')) throw new Error('INVALID_UID');
  const snapshot = await getFirestoreDb().collection('accountDeletions').doc(uid).get();
  configuration(); // Do not authorize a read completed after configuration changed or closure.
  return snapshot.exists;
}

export async function initializeFirebase(): Promise<void> {
  try { getFirebaseAuth(); getFirestoreDb(); }
  catch (error) {
    try { await closeFirebase(); }
    catch { console.error({ event: 'realtime_firebase_cleanup_failed', code: 'FIREBASE_CLEANUP_FAILED' }); }
    throw error;
  }
}
export function closeFirebase(): Promise<void> {
  if (closing) return closing;
  closed = true;
  closing = (async () => {
    let failed = false;
    try { await firestore?.terminate(); } catch { failed = true; }
    try {
      const registered = getApps().find((app) => app.name === realtimeFirebaseAppName);
      if (ownedApp && registered === ownedApp) await deleteApp(ownedApp);
      else if (ownedApp && registered) failed = true; // Never close a replacement owned by another component.
    } catch { failed = true; }
    if (failed) return reject('FIREBASE_CLEANUP_FAILED');
  })();
  return closing;
}
