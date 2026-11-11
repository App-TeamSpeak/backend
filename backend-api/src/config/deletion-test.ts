import { AppError } from '../middleware/errors';

export const deletionTestProject = 'demo-teamspeak-tests';
function localEmulator(value: string | undefined): boolean {
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(value ?? '');
  return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535;
}

// Defense in depth: both the HTTP entry point and the service check these gates.
export function assertDeletionTestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test'
    || process.env.TEAMSPEAK_ENABLE_DELETE_TESTS !== 'true'
    || process.env.FIREBASE_PROJECT_ID !== deletionTestProject
    || process.env.GCLOUD_PROJECT !== deletionTestProject
    || process.env.DOTENV_CONFIG_PATH !== '/dev/null'
    || !localEmulator(process.env.FIRESTORE_EMULATOR_HOST)
    || !localEmulator(process.env.FIREBASE_AUTH_EMULATOR_HOST)
    || process.env.FIRESTORE_EMULATOR_HOST === process.env.FIREBASE_AUTH_EMULATOR_HOST
    || ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']
      .some((name) => !!process.env[name])) {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'El inicio de eliminación solo está disponible en pruebas aisladas; la eliminación real no está implementada.');
  }
}
