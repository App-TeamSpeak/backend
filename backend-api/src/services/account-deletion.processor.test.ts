import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const clients = vi.hoisted(() => ({ withDeletionEmulatorClients: vi.fn() }));
vi.mock('../config/deletion-emulator-clients', () => clients);
import { processAccountDeletion } from './account-deletion.processor';
const projectId = 'demo-teamspeak-tests';
const uid = 'fixture-user';
const markerPath = `accountDeletions/${uid}`;
const stamp = Timestamp.fromMillis(1000);
const marker = { status: 'pending', phase: 'auth', usernameKeys: ['ana-user1'], requestedAt: stamp, updatedAt: stamp, attempts: 0 };
const profile = { uid, nombre: 'Ana', username: 'Ana-User1', usernameKey: 'ana-user1' };
function fixture() {
  const data = new Map<string, any>([[markerPath, marker], [`users/${uid}`, profile], ['usernames/ana-user1', { uid, usernameKey: 'ana-user1' }]]);
  const accounts = new Set([uid]);
  const history: any[] = [];
  const ref = (path: string) => ({ path });
  let queue = Promise.resolve();
  const runTransaction = vi.fn((callback: (tx: any) => unknown) => {
    const result = queue.then(async () => {
      const writes: (() => void)[] = [];
      const tx = {
        get: async (reference: { path?: string; queryUid?: string }) => {
          if (reference.queryUid !== undefined) return { docs: [...data].filter(([path, value]) => path.startsWith('usernames/') && value.uid === reference.queryUid).map(([path, value]) => ({ id: path.split('/')[1], data: () => value })) };
          return { exists: data.has(reference.path!), data: () => data.get(reference.path!) };
        },
        set: (reference: { path: string }, value: unknown) => writes.push(() => { data.set(reference.path, value); history.push(value); }),
        delete: (reference: { path: string }) => writes.push(() => { data.delete(reference.path); }),
      };
      const value = await callback(tx); for (const write of writes) write(); return value;
    });
    queue = result.then(() => undefined, () => undefined); return result;
  });
  const db = { projectId, collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`), where: (_field: string, _op: string, queryUid: string) => ({ queryUid }) }), runTransaction };
  const deleteUser = vi.fn(async (id: string) => { if (!accounts.delete(id)) throw { code: 'auth/user-not-found' }; });
  const auth = { app: { options: { projectId } }, deleteUser };
  let time = Timestamp.fromMillis(2000);
  const firestore = db as unknown as Firestore;
  clients.withDeletionEmulatorClients.mockImplementation(async (operation) => operation({ firestore, auth, assertSafe: () => undefined }));
  const options = { now: () => time };
  return { data, accounts, history, runTransaction, deleteUser, auth, firestore, options, later: (value: Timestamp) => { time = Timestamp.fromMillis(value.toMillis() + 1); } };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, DOTENV_CONFIG_PATH: '/dev/null', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })) vi.stubEnv(key, value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','FIREBASE_CONFIG','FIREBASE_TOKEN']) vi.stubEnv(key, '');
});
afterEach(() => vi.unstubAllEnvs());
describe('internal processor (mock SDKs for controlled partial failures)', () => {
  it('advances auth -> firestore -> completed and minimizes final metadata', async () => {
    const f = fixture(); const result = await processAccountDeletion(uid, f.options);
    expect(result).toMatchObject({ status: 'completed', phase: 'done', attempts: 1, usernameKeys: [], requestedAt: stamp });
    expect(result.completedAt).toBeInstanceOf(Timestamp); expect(result).not.toHaveProperty('nextAttemptAt'); expect(result).not.toHaveProperty('lastErrorCode');
    expect(f.history.map((value) => value.phase)).toEqual(['auth','firestore','done']);
    expect(f.deleteUser).toHaveBeenCalledExactlyOnceWith(uid); expect(f.accounts.size).toBe(0);
    expect([...f.data.keys()]).toEqual([markerPath]);
  });
  it('refuses an absent marker without creating one or deleting anything', async () => {
    const f = fixture(); f.data.delete(markerPath); const before = [...f.data];
    await expect(processAccountDeletion(uid, f.options)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_FOUND' });
    expect([...f.data]).toEqual(before); expect(f.deleteUser).not.toHaveBeenCalled();
  });
  it.each([{ status: 'pending' }, { ...marker, phase: 'done' }, { ...marker, status: 'completed' }, { ...marker, attempts: -1 }])('refuses malformed marker %j before destructive calls', async (value) => {
    const f = fixture(); f.data.set(markerPath, value);
    await expect(processAccountDeletion(uid, f.options)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_INCONSISTENT' });
    expect(f.deleteUser).not.toHaveBeenCalled(); expect(f.history).toEqual([]);
  });
  it.each(['completed','blocked'] as const)('does not restart %s', async (status) => {
    const f = fixture(); const value = { ...marker, status, attempts: 4, ...(status === 'completed' ? { phase: 'done', completedAt: stamp } : {}) }; f.data.set(markerPath, value);
    expect(await processAccountDeletion(uid, f.options)).toEqual(value); expect(f.deleteUser).not.toHaveBeenCalled(); expect(f.history).toEqual([]);
  });
  it('accepts user-not-found after an earlier deletion', async () => {
    const f = fixture(); f.accounts.delete(uid);
    expect((await processAccountDeletion(uid, f.options)).status).toBe('completed'); expect(f.data.has(`users/${uid}`)).toBe(false);
  });
  it('resumes firestore without repeating Authentication', async () => {
    const f = fixture(); f.data.set(markerPath, { ...marker, phase: 'firestore', attempts: 3 }); f.accounts.delete(uid);
    expect((await processAccountDeletion(uid, f.options)).attempts).toBe(4); expect(f.deleteUser).not.toHaveBeenCalled();
  });
  it.each([`users/${uid}`, 'usernames/ana-user1'])('tolerates an already absent resource: %s', async (path) => {
    const f = fixture(); f.data.delete(path);
    expect((await processAccountDeletion(uid, f.options)).status).toBe('completed');
  });
  it('accepts a safely owned incomplete profile', async () => {
    const f = fixture(); f.data.set(`users/${uid}`, { nombre: 'Ana' });
    expect((await processAccountDeletion(uid, f.options)).status).toBe('completed');
  });
  it.each([
    [`users/${uid}`, { uid: 'other' }],
    ['usernames/ana-user1', { uid: 'other', usernameKey: 'ana-user1' }],
    ['usernames/unexpected1', { uid, usernameKey: 'unexpected1' }],
  ])('blocks contradictory resources before deleting Auth: %s', async (path, value) => {
    const f = fixture(); f.data.set(path, value); const original = f.data.get(path);
    const result = await processAccountDeletion(uid, f.options);
    expect(result).toMatchObject({ status: 'blocked', lastErrorCode: 'PROFILE_INCONSISTENT', attempts: 1 });
    expect(f.deleteUser).not.toHaveBeenCalled(); expect(f.data.get(path)).toEqual(original); expect(result).not.toHaveProperty('nextAttemptAt');
  });
  it('rechecks ownership during cleanup even after Authentication is deleted', async () => {
    const f = fixture();
    const result = await processAccountDeletion(uid, { ...f.options, afterAuthDeleted: async () => { f.data.set('usernames/ana-user1', { uid: 'other', usernameKey: 'ana-user1' }); } });
    expect(result).toMatchObject({ status: 'blocked', phase: 'firestore' });
    expect(f.data.has(`users/${uid}`)).toBe(true); expect(f.data.get('usernames/ana-user1').uid).toBe('other');
  });
  it.each(['app/network-timeout','auth/internal-error'])('keeps uncertain Authentication failure retryable: %s', async (code) => {
    const f = fixture(); f.deleteUser.mockRejectedValueOnce({ code, message: 'PRIVATE' });
    const result = await processAccountDeletion(uid, f.options);
    expect(result).toMatchObject({ status: 'pending', phase: 'auth', attempts: 1 }); expect(result.nextAttemptAt!.toMillis()).toBe(32000);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(f.data.has(`users/${uid}`)).toBe(true);
    expect(await processAccountDeletion(uid, f.options)).toEqual(result); expect(f.deleteUser).toHaveBeenCalledTimes(1);
    f.later(result.nextAttemptAt!); expect((await processAccountDeletion(uid, f.options)).status).toBe('completed');
  });
  it('recovers when Auth succeeded but phase persistence failed', async () => {
    const f = fixture(); let fail = true;
    const options = { ...f.options, beforePhaseCommit: () => { if (fail) { fail = false; throw { code: 14 }; } } };
    const pending = await processAccountDeletion(uid, options);
    expect(pending).toMatchObject({ status: 'pending', phase: 'auth', lastErrorCode: 'FIRESTORE_UNAVAILABLE' });
    expect(f.accounts.size).toBe(0); expect(f.data.has(`users/${uid}`)).toBe(true);
    f.later(pending.nextAttemptAt!); const completed = await processAccountDeletion(uid, options);
    expect(completed).toMatchObject({ status: 'completed', attempts: 2 }); expect(f.deleteUser).toHaveBeenCalledTimes(2);
  });
  it('aborts cleanup atomically and retries only firestore', async () => {
    const f = fixture(); let fail = true;
    const options = { ...f.options, beforeCleanupCommit: () => { if (fail) { fail = false; throw { code: 10 }; } } };
    const pending = await processAccountDeletion(uid, options);
    expect(pending).toMatchObject({ status: 'pending', phase: 'firestore' });
    expect(f.data.has(`users/${uid}`)).toBe(true); expect(f.data.has('usernames/ana-user1')).toBe(true);
    f.later(pending.nextAttemptAt!); expect((await processAccountDeletion(uid, options)).status).toBe('completed'); expect(f.deleteUser).toHaveBeenCalledTimes(1);
  });
  it('recognizes completion after a lost result without rewriting it', async () => {
    const f = fixture();
    const completed = await processAccountDeletion(uid, { ...f.options, afterCleanupCommitted: async () => { throw { code: 14 }; } });
    const history = [...f.history]; expect(completed.status).toBe('completed');
    expect(await processAccountDeletion(uid, f.options)).toEqual(completed); expect(f.history).toEqual(history); expect(f.deleteUser).toHaveBeenCalledTimes(1);
  });
  it('blocks known permanent Auth configuration failures without deleting resources', async () => {
    const f = fixture(); f.deleteUser.mockRejectedValueOnce({ code: 'auth/insufficient-permission' });
    expect(await processAccountDeletion(uid, f.options)).toMatchObject({ status: 'blocked', lastErrorCode: 'AUTH_CONFIGURATION_ERROR' }); expect(f.data.has(`users/${uid}`)).toBe(true);
  });
  it('fails safely if Firestore is unavailable before admission', async () => {
    const f = fixture(); f.runTransaction.mockRejectedValueOnce({ code: 14 });
    await expect(processAccountDeletion(uid, f.options)).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
    expect(f.deleteUser).not.toHaveBeenCalled(); expect(f.data.get(markerPath).attempts).toBe(0);
  });
  it('persists a permanent Firestore permission error after admission', async () => {
    const f = fixture();
    const result = await processAccountDeletion(uid, { ...f.options, beforeCleanupCommit: () => { throw { code: 7 }; } });
    expect(result).toMatchObject({ status: 'blocked', phase: 'firestore', lastErrorCode: 'FIRESTORE_PERMISSION_DENIED' });
    expect(result).not.toHaveProperty('nextAttemptAt');
    expect(f.data.has(`users/${uid}`)).toBe(true); expect(f.data.has('usernames/ana-user1')).toBe(true);
  });
  it('does not overwrite a newer completion with an older failing executor', async () => {
    const f = fixture(); let started!: () => void; let reject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.deleteUser.mockImplementationOnce(async () => { started(); await new Promise((_resolve, fail) => { reject = fail; }); });
    const first = processAccountDeletion(uid, f.options); await ready;
    const second = await processAccountDeletion(uid, f.options); expect(second).toMatchObject({ status: 'completed', attempts: 2 });
    reject({ code: 'app/network-timeout' }); expect(await first).toEqual(second); expect(f.data.get(markerPath)).toEqual(second);
  });
  it.each([['NODE_ENV','production'], ['TEAMSPEAK_ENABLE_DELETE_TESTS',''], ['FIREBASE_AUTH_EMULATOR_HOST','remote.invalid:9099'], ['FIRESTORE_EMULATOR_HOST',''], ['FIREBASE_PROJECT_ID','other'], ['FIREBASE_PRIVATE_KEY','synthetic']])('rejects unsafe %s before any SDK operation', async (key, value) => {
    const f = fixture(); vi.stubEnv(key, value);
    await expect(processAccountDeletion(uid, f.options)).rejects.toMatchObject({ statusCode: 501 });
    expect(f.deleteUser).not.toHaveBeenCalled(); expect(f.runTransaction).not.toHaveBeenCalled();
  });
  it.each(['auth','firestore'])('rejects a mismatched %s SDK project', async (client) => {
    const f = fixture(); if (client === 'auth') f.auth.app.options.projectId = 'other'; else Object.defineProperty(f.firestore, 'projectId', { value: 'other' });
    await expect(processAccountDeletion(uid, f.options)).rejects.toMatchObject({ statusCode: 501 }); expect(f.deleteUser).not.toHaveBeenCalled(); expect(f.runTransaction).not.toHaveBeenCalled();
  });
});
