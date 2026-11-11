import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { Firestore } from 'firebase-admin/firestore';
import { assertDeletionTestEnvironment, deletionTestProject } from './deletion-test';
import { AppError } from '../middleware/errors';

export interface DeletionEmulatorClients {
  firestore: Firestore;
  auth: Pick<Auth, 'app' | 'deleteUser'>;
  assertSafe(): void;
}

// Clients are owned and closed by this scope. No default apps, ADC or caller-supplied SDKs.
export async function withDeletionEmulatorClients<T>(operation: (clients: DeletionEmulatorClients) => Promise<T>): Promise<T> {
  assertDeletionTestEnvironment();
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST!;
  const app = initializeApp({
    projectId: deletionTestProject,
    credential: { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) },
  }, `deletion-emulator-${randomUUID()}`);
  let firestore: Firestore | undefined;
  let processingFailed = false;
  let cleanupFailed = false;
  let result: T;
  try {
    // The installed Admin Firestore factory does not support custom local credentials.
    // Use the supported Firestore constructor with an explicit insecure local endpoint.
    firestore = new Firestore({
      projectId: deletionTestProject, host: firestoreHost,
      port: Number(firestoreHost.split(':')[1]), ssl: false,
      credentials: { client_email: 'emulator@example.invalid', private_key: 'emulator-only-not-a-key' },
    });
    const auth = getAuth(app); // Auth fixes its emulator URL at construction, after validation.
    const assertSafe = () => {
      assertDeletionTestEnvironment();
      if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== authHost || process.env.FIRESTORE_EMULATOR_HOST !== firestoreHost) {
        throw new AppError(501, 'NOT_IMPLEMENTED', 'La configuración de emuladores cambió durante el procesamiento.');
      }
    };
    assertSafe();
    result = await operation({ firestore, auth, assertSafe });
  } catch (error) {
    processingFailed = true;
    throw error;
  } finally {
    try { await firestore?.terminate(); } catch { cleanupFailed = true; }
    try { await deleteApp(app); } catch { cleanupFailed = true; }
    if (cleanupFailed && processingFailed) console.error({ event: 'deletion_clients_cleanup_failed', code: 'DELETION_CLIENT_CLEANUP_FAILED' });
  }
  if (cleanupFailed) throw new AppError(500, 'DELETION_CLIENT_CLEANUP_FAILED', 'No se pudieron cerrar los clientes de prueba.');
  return result;
}
