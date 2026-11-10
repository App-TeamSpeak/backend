import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Firestore } from 'firebase-admin/firestore';
import { withDeletionEmulatorClients } from './deletion-emulator-clients';
import { processAccountDeletion } from '../services/account-deletion.processor';
const projectId = 'demo-teamspeak-tests';
function safeEnvironment() {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, DOTENV_CONFIG_PATH: '/dev/null', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })) vi.stubEnv(key, value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','FIREBASE_CONFIG','FIREBASE_TOKEN']) vi.stubEnv(key, '');
}
beforeEach(safeEnvironment);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('destructive processor client provenance (no remote requests)', () => {
  it('rejects Auth constructed before emulator configuration despite its correct project ID', async () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '');
    const app = initializeApp({ projectId, credential: { getAccessToken: async () => { throw new Error('Remote credentials must never be requested'); } } }, 'pre-emulator-regression');
    try {
      const auth = getAuth(app);
      // Diagnostic only: the security implementation never relies on SDK private fields.
      const diagnostic = auth as unknown as { authRequestHandler: { authResourceUrlBuilder: { urlFormat: string } } };
      expect(diagnostic.authRequestHandler.authResourceUrlBuilder.urlFormat).toMatch(/^https:\/\/identitytoolkit.googleapis.com\//);
      const remove = vi.spyOn(auth, 'deleteUser').mockRejectedValue(new Error('Remote operation forbidden'));
      safeEnvironment();
      const options = { auth } as unknown as Parameters<typeof processAccountDeletion>[1];
      await expect(processAccountDeletion('fixture', options)).rejects.toMatchObject({ statusCode: 501 });
      expect(remove).not.toHaveBeenCalled();
    } finally { await deleteApp(app); }
  });
  it('rejects an existing Firestore client with the correct project and a remote endpoint', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const firestore = new Firestore({ projectId, host: 'remote.invalid:443', ssl: false, credentials: { client_email: 'fixture@example.invalid', private_key: 'not-a-key' } });
    try {
      const diagnostic = firestore as unknown as { _settings: { servicePath: string } };
      expect(diagnostic._settings.servicePath).toBe('remote.invalid');
      const transaction = vi.spyOn(firestore, 'runTransaction').mockRejectedValue(new Error('Remote operation forbidden'));
      safeEnvironment();
      await expect(processAccountDeletion('fixture', { firestore } as unknown as Parameters<typeof processAccountDeletion>[1])).rejects.toMatchObject({ statusCode: 501 });
      expect(transaction).not.toHaveBeenCalled();
    } finally { await firestore.terminate(); }
  });
  it('builds fresh dedicated clients with local credentials and closes every scope', async () => {
    const before = getApps().map((app) => app.name);
    let terminate!: ReturnType<typeof vi.spyOn>;
    let firstName = '';
    await withDeletionEmulatorClients(async ({ firestore, auth, assertSafe }) => {
      firstName = auth.app.name;
      expect(firstName).toMatch(/^deletion-emulator-/); expect(auth.app.options.projectId).toBe(projectId);
      expect('projectId' in firestore && firestore.projectId).toBe(projectId); assertSafe();
      expect(await auth.app.options.credential!.getAccessToken()).toEqual({ access_token: 'owner', expires_in: 3600 });
      terminate = vi.spyOn(firestore, 'terminate');
    });
    expect(terminate).toHaveBeenCalledOnce(); expect(getApps().map((app) => app.name)).toEqual(before);
    await withDeletionEmulatorClients(async ({ auth }) => { expect(auth.app.name).not.toBe(firstName); });
    expect(getApps().map((app) => app.name)).toEqual(before);
  });
  it.each(['FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST'])('rejects a later change of %s and still closes its resources', async (key) => {
    const before = getApps().map((app) => app.name);
    let terminate!: ReturnType<typeof vi.spyOn>;
    await expect(withDeletionEmulatorClients(async ({ firestore, assertSafe }) => { terminate = vi.spyOn(firestore, 'terminate'); vi.stubEnv(key, '127.0.0.1:9998'); assertSafe(); })).rejects.toMatchObject({ statusCode: 501 });
    expect(terminate).toHaveBeenCalledOnce();
    expect(getApps().map((app) => app.name)).toEqual(before);
  });
  it.each([
    ['NODE_ENV','production'], ['TEAMSPEAK_ENABLE_DELETE_TESTS',''], ['FIREBASE_PROJECT_ID','real-project'],
    ['GCLOUD_PROJECT','real-project'], ['FIREBASE_AUTH_EMULATOR_HOST',''], ['FIRESTORE_EMULATOR_HOST',''],
    ['FIREBASE_AUTH_EMULATOR_HOST','remote.invalid:9099'], ['FIRESTORE_EMULATOR_HOST','remote.invalid:8081'],
    ['FIRESTORE_EMULATOR_HOST','127.0.0.1:0'], ['FIREBASE_AUTH_EMULATOR_HOST','127.0.0.1:65536'],
    ['GOOGLE_APPLICATION_CREDENTIALS','synthetic-path'], ['FIREBASE_PRIVATE_KEY','synthetic'],
  ])('rejects unsafe %s before construction or direct processing', async (key, value) => {
    vi.stubEnv(key, value); const before = getApps().map((app) => app.name); const operation = vi.fn();
    await expect(withDeletionEmulatorClients(operation)).rejects.toMatchObject({ statusCode: 501 });
    await expect(processAccountDeletion('fixture')).rejects.toMatchObject({ statusCode: 501 });
    expect(operation).not.toHaveBeenCalled(); expect(getApps().map((app) => app.name)).toEqual(before);
  });
  it('preserves the processing error if resource cleanup also fails (P3)', async () => {
    const original = new Error('controlled original');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = getApps().map((app) => app.name);
    await expect(withDeletionEmulatorClients(async ({ firestore }) => {
      vi.spyOn(firestore, 'terminate').mockRejectedValue(new Error('PRIVATE cleanup'));
      throw original;
    })).rejects.toBe(original);
    expect(getApps().map((app) => app.name)).toEqual(before);
    expect(log).toHaveBeenCalledWith({ event: 'deletion_clients_cleanup_failed', code: 'DELETION_CLIENT_CLEANUP_FAILED' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
  });
  it('reports a controlled cleanup error after successful processing', async () => {
    const before = getApps().map((app) => app.name);
    await expect(withDeletionEmulatorClients(async ({ firestore }) => {
      vi.spyOn(firestore, 'terminate').mockRejectedValue(new Error('PRIVATE cleanup'));
    })).rejects.toMatchObject({ code: 'DELETION_CLIENT_CLEANUP_FAILED' });
    expect(getApps().map((app) => app.name)).toEqual(before);
  });

});
