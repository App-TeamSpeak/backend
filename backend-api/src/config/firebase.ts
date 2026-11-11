import { applicationDefault, cert, getApps, initializeApp, deleteApp, type App, type AppOptions } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { env } from './env';
import { assertDeletionTestEnvironment, deletionTestProject } from './deletion-test';

export const apiFirebaseAppName = 'teamspeak-api';
class LocalApiCredential {
  async getAccessToken() { return { access_token: 'owner', expires_in: 3600 }; }
}
let configuration: { options: AppOptions; emulator: boolean } | undefined;
let apiFirestore: { app: App; db: Firestore; host?: string } | undefined;
function getConfiguration() {
  if (configuration) return configuration;
  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = env;
  if (projectId && clientEmail && privateKey) {
    configuration = { options: { projectId, credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) }, emulator: false };
  } else if (env.NODE_ENV === 'production') {
    configuration = { options: { ...(projectId ? { projectId } : {}), credential: applicationDefault() }, emulator: false };
  } else if (env.NODE_ENV === 'test' && projectId === deletionTestProject) {
    assertDeletionTestEnvironment();
    configuration = { options: { projectId, credential: new LocalApiCredential() }, emulator: true };
  } else {
    throw new Error('Firebase Admin no está configurado. Define las credenciales Firebase en el entorno.');
  }
  return configuration;
}
function getFirebaseApp(): App {
  const config = getConfiguration();
  if (config.emulator) assertDeletionTestEnvironment();
  const existing = getApps().find((app) => app.name === apiFirebaseAppName);
  if (existing) {
    if (existing.options.projectId !== config.options.projectId || existing.options.credential !== config.options.credential) {
      throw new Error('La aplicación teamspeak-api existente no coincide con la configuración principal.');
    }
    return existing;
  }
  return initializeApp(config.options, apiFirebaseAppName);
}
export function getFirebaseAuth(): Auth { return getAuth(getFirebaseApp()); }
export function getFirestoreDb(): Firestore {
  const app = getFirebaseApp();
  if (!getConfiguration().emulator) {
    const db = getFirestore(app); apiFirestore = { app, db }; return db;
  }
  // Custom local credentials are not supported by Admin's Firestore factory.
  const host = process.env.FIRESTORE_EMULATOR_HOST!;
  if (apiFirestore?.app === app) {
    if (apiFirestore.host !== host) throw new Error('La configuración Firestore principal cambió.');
    return apiFirestore.db;
  }
  const db = new Firestore({ projectId: deletionTestProject, host, port: Number(host.split(':')[1]), ssl: false,
    credentials: { client_email: 'emulator@example.invalid', private_key: 'emulator-only-not-a-key' } });
  apiFirestore = { app, db, host };
  return db;
}

// Only the HTTP owner calls this after closing HTTP; temporary factories never do.
export async function closeFirebase(): Promise<void> {
  if (!configuration) return;
  const app = getApps().find((candidate) => candidate.name === apiFirebaseAppName);
  if (!app) return;
  if (app.options.projectId !== configuration.options.projectId || app.options.credential !== configuration.options.credential) {
    throw new Error('No se puede cerrar una aplicación Firebase de otro propietario.');
  }
  try { if (apiFirestore?.app === app) await apiFirestore.db.terminate(); }
  finally { await deleteApp(app); apiFirestore = undefined; }
}
