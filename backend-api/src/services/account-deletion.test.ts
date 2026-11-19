import request from 'supertest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ getFirebaseAuth: vi.fn(), getFirestoreDb: vi.fn(), verify: vi.fn(), deleteUser: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: config.getFirebaseAuth, getFirestoreDb: config.getFirestoreDb }));

import { app } from '../app';
import { createAccountDeletionReconciler } from './account-deletion.reconciler';
import { beginAccountDeletion, getAccountDeletionStatus, requestAccountDeletion, runAccountDeletionWithLease } from './account-deletion.service';

const projectId = 'demo-teamspeak-tests';
const uid = 'user-a';
const seconds = 1800000000;
const now = Timestamp.fromMillis(seconds * 1000);
const profile = { uid, username: 'Ana-User1', usernameKey: 'ana-user1', nombre: 'Ana' };

function database() {
  const data = new Map<string, Record<string, unknown>>([
    [`users/${uid}`, profile],
    ['users/user-b', { uid: 'user-b', username: 'Bob-User1' }],
    ['usernames/ana-user1', { uid, usernameKey: 'ana-user1' }],
    ['usernames/bob-user1', { uid: 'user-b', usernameKey: 'bob-user1' }],
    ['rooms/room-owned', { roomId: 'room-owned', ownerId: uid, name: 'Sala propia' }],
    ['rooms/room-owned/members/user-a', { uid, roomId: 'room-owned', role: 'host' }],
    ['rooms/room-owned/messages/m-own', { messageId: 'm-own', roomId: 'room-owned', senderId: uid, text: 'propio' }],
    ['rooms/room-foreign', { roomId: 'room-foreign', ownerId: 'user-b', name: 'Sala ajena' }],
    ['rooms/room-foreign/members/user-a', { uid, roomId: 'room-foreign', role: 'member' }],
    ['rooms/room-foreign/members/user-b', { uid: 'user-b', roomId: 'room-foreign', role: 'host' }],
    ['rooms/room-foreign/messages/m-1', { messageId: 'm-1', roomId: 'room-foreign', senderId: uid, text: 'mensaje en sala ajena' }],
    ['rooms/room-foreign/messages/m-2', { messageId: 'm-2', roomId: 'room-foreign', senderId: 'user-b', text: 'mensaje de otro' }],
  ]);

  const docRef = (path: string) => ({
    path,
    id: path.split('/').at(-1)!,
    get: async () => get({ path }),
    collection: (sub: string) => collection(`${path}/${sub}`),
  });
  const create = vi.fn((ref: { path: string }, value: Record<string, unknown>) => { data.set(ref.path, value); });
  const set = vi.fn((ref: { path: string }, value: Record<string, unknown>) => { data.set(ref.path, value); });
  const del = vi.fn((ref: { path: string }) => { data.delete(ref.path); });

  const matchQuery = (kind: string, field: string, value: unknown) => {
    let entries = [...data.entries()];
    if (kind === 'usernames') entries = entries.filter(([p]) => p.startsWith('usernames/'));
    else if (kind === 'rooms') entries = entries.filter(([p]) => p.startsWith('rooms/') && p.split('/').length === 2);
    else if (kind === 'accountDeletions') entries = entries.filter(([p]) => p.startsWith('accountDeletions/'));
    else if (kind === 'group:members') entries = entries.filter(([p]) => /^rooms\/[^/]+\/members\/[^/]+$/.test(p));
    else if (kind === 'group:messages') entries = entries.filter(([p]) => /^rooms\/[^/]+\/messages\/[^/]+$/.test(p));
    return entries.filter(([, v]) => v[field] === value);
  };

  const get = vi.fn(async (ref: { path?: string; queryKind?: string; field?: string; value?: unknown }) => {
    if (ref.queryKind) {
      const docs = matchQuery(ref.queryKind, ref.field!, ref.value).map(([p, v]) => ({
        id: p.split('/').at(-1)!,
        ref: docRef(p),
        data: () => v,
      }));
      return { empty: docs.length === 0, size: docs.length, docs };
    }
    return { exists: data.has(ref.path!), data: () => data.get(ref.path!) };
  });

  const makeQuery = (queryKind: string, field: string, value: unknown): any => ({
    queryKind,
    field,
    value,
    orderBy: () => makeQuery(queryKind, field, value),
    startAfter: () => makeQuery(queryKind, field, value),
    limit: () => ({ queryKind, field, value, startAfter: () => makeQuery(queryKind, field, value), get: () => get({ queryKind, field, value }) }),
    get: () => get({ queryKind, field, value }),
  });

  const collection = (prefix: string) => ({
    doc: (id: string) => docRef(`${prefix}/${id}`),
    where: (field: string, _op: string, value: unknown) => makeQuery(prefix, field, value),
    get: async () => {
      const docs = [...data.entries()]
        .filter(([p]) => p.startsWith(`${prefix}/`) && p.split('/').length === prefix.split('/').length + 1)
        .map(([p, v]) => ({ id: p.split('/').at(-1)!, ref: docRef(p), data: () => v }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });

  const batch = () => {
    const ops: Array<() => void> = [];
    return {
      delete: (ref: { path: string }) => { ops.push(() => { data.delete(ref.path); }); },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        ops.push(() => { const prev = data.get(ref.path); if (prev) data.set(ref.path, { ...prev, ...patch }); });
      },
      commit: vi.fn(async () => { ops.forEach((op) => op()); }),
    };
  };

  const db = {
    projectId,
    collection,
    collectionGroup: (name: string) => ({
      where: (field: string, _op: string, value: unknown) => makeQuery(`group:${name}`, field, value),
    }),
    batch,
    runTransaction: vi.fn(async (fn: (tx: { get: typeof get; create: typeof create; set: typeof set; delete: typeof del }) => unknown) => fn({ get, create, set, delete: del })),
  };
  return { db: db as unknown as Firestore, data, create, set, del, get };
}

let fake: ReturnType<typeof database>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000);
  for (const [name, value] of Object.entries({ NODE_ENV: 'test', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', FIREBASE_PROJECT_ID: projectId, GCLOUD_PROJECT: projectId, DOTENV_CONFIG_PATH: '/dev/null', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })) vi.stubEnv(name, value);
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']) vi.stubEnv(name, '');
  fake = database();
  config.getFirestoreDb.mockReturnValue(fake.db);
  config.verify.mockResolvedValue({ uid, auth_time: seconds, iat: seconds });
  config.deleteUser.mockResolvedValue(undefined);
  config.getFirebaseAuth.mockReturnValue({ app: { options: { projectId } }, verifyIdToken: config.verify, deleteUser: config.deleteUser });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const remove = () => request(app).delete('/api/users/me').set('Authorization', 'Bearer synthetic');

describe('US-05 recoverable & complete account deletion', () => {
  it('executes full cleanup (owned rooms, foreign memberships, anonymized foreign messages, profile, usernames, Auth) and returns statusToken', async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('completed');
    expect(typeof response.body.data.statusToken).toBe('string');

    expect(config.deleteUser).toHaveBeenCalledExactlyOnceWith(uid);
    expect(fake.data.has(`users/${uid}`)).toBe(false);
    expect(fake.data.has('usernames/ana-user1')).toBe(false);
    expect(fake.data.has('rooms/room-owned')).toBe(false);
    expect(fake.data.has('rooms/room-owned/members/user-a')).toBe(false);
    expect(fake.data.has('rooms/room-owned/messages/m-own')).toBe(false);
    expect(fake.data.has('rooms/room-foreign/members/user-a')).toBe(false);

    // Foreign room, other users' data, and anonymized message remain intact.
    expect(fake.data.has('users/user-b')).toBe(true);
    expect(fake.data.has('usernames/bob-user1')).toBe(true);
    expect(fake.data.has('rooms/room-foreign/members/user-b')).toBe(true);
    expect(fake.data.get('rooms/room-foreign/messages/m-1')).toMatchObject({ senderId: null, authorDeleted: true, text: 'mensaje en sala ajena' });
    expect(fake.data.get('rooms/room-foreign/messages/m-2')).toMatchObject({ senderId: 'user-b', text: 'mensaje de otro' });

    // Status can be queried safely via X-Deletion-Status-Token even after Auth deletion.
    const statusRes = await request(app)
      .get('/api/users/me/deletion-status')
      .set('X-Deletion-Status-Token', response.body.data.statusToken);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toEqual({ success: true, data: { status: 'completed' } });
  });

  it('rejects unknown statusToken with 404 without leaking account existence', async () => {
    const res = await request(app).get('/api/users/me/deletion-status').set('X-Deletion-Status-Token', 'invalid-token');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DELETION_STATUS_NOT_FOUND');
  });

  it('requires recent auth_time (<= 300s) for new requests, but allows idempotent retries of pending requests', async () => {
    config.verify.mockResolvedValueOnce({ uid, auth_time: seconds - 301, iat: seconds });
    const stale = await remove();
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('AUTH_RECENT_REQUIRED');

    // Simulate transient Auth failure on first attempt -> stays pending.
    config.deleteUser.mockRejectedValueOnce({ code: 'auth/network-request-failed' });
    const first = await remove();
    expect(first.status).toBe(202);
    expect(first.body.data.status).toBe('pending');
    expect(fake.data.get(`accountDeletions/${uid}`)).toMatchObject({ status: 'pending', phase: 'auth' });

    // Retry with older auth_time succeeds and resumes from phase 'auth'.
    config.verify.mockResolvedValueOnce({ uid, auth_time: seconds - 600, iat: seconds });
    // Advance mock clock past backoff.
    vi.spyOn(Date, 'now').mockReturnValue((seconds + 120) * 1000);
    const retry = await remove();
    expect(retry.status).toBe(200);
    expect(retry.body.data.status).toBe('completed');
  });

  it('respects active lease held by another instance and avoids duplicate processing', async () => {
    fake.data.set(`accountDeletions/${uid}`, {
      status: 'pending',
      phase: 'auth',
      usernameKeys: [],
      requestedAt: now,
      updatedAt: now,
      attempts: 1,
      leaseOwner: 'other-instance',
      leaseExpiresAt: Timestamp.fromMillis((seconds + 30) * 1000),
    });
    const status = await runAccountDeletionWithLease(uid, fake.db, { deleteUser: config.deleteUser } as unknown as Auth, () => now);
    expect(status).toBe('pending');
    expect(config.deleteUser).not.toHaveBeenCalled();
  });

  it('returns completed idempotently on repeated request after completion without invalidating existing statusToken', async () => {
    const clientToken = 'ClientGeneratedReceiptToken_0123456789abcdef';
    const first = await requestAccountDeletion({ uid, authTime: seconds }, fake.db, { deleteUser: config.deleteUser } as unknown as Auth, clientToken);
    expect(first).toEqual({ status: 'completed', statusToken: clientToken });
    config.deleteUser.mockClear();

    // Retry with a different token is rejected with 409 DELETION_STATUS_TOKEN_MISMATCH without overwriting the hash.
    await expect(
      requestAccountDeletion({ uid, authTime: seconds - 1000 }, fake.db, { deleteUser: config.deleteUser } as unknown as Auth, 'DifferentReceiptToken_0123456789abcdef'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DELETION_STATUS_TOKEN_MISMATCH' });

    // Retry without token preserves the original statusTokenHash and does not invalidate it.
    const second = await requestAccountDeletion({ uid, authTime: seconds - 1000 }, fake.db, { deleteUser: config.deleteUser } as unknown as Auth);
    expect(second.status).toBe('completed');
    expect(second.statusToken).toBeUndefined();
    expect(config.deleteUser).not.toHaveBeenCalled();
    expect(await getAccountDeletionStatus({ statusToken: clientToken }, fake.db)).toEqual({ status: 'completed' });
  });

  it('returns blocked (409) instead of pending on permanent failure and exposes blocked via deletion-status', async () => {
    const clientToken = 'ClientReceiptPermanentError_0123456789abcdef';
    config.deleteUser.mockRejectedValueOnce({ code: 'auth/insufficient-permission' });
    const res = await remove().set('X-Deletion-Status-Token', clientToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_DELETION_BLOCKED');
    expect(fake.data.get(`accountDeletions/${uid}`)).toMatchObject({ status: 'blocked', lastErrorCode: 'DELETION_FAILED' });

    const statusRes = await request(app).get('/api/users/me/deletion-status').set('X-Deletion-Status-Token', clientToken);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toEqual({ success: true, data: { status: 'blocked' } });
  });

  it('rejects weak or malformed X-Deletion-Status-Token on DELETE with 400 VALIDATION_ERROR', async () => {
    const res = await remove().set('X-Deletion-Status-Token', 'too-short');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('renews lease during prolonged cleanup and aborts cleanly if lease ownership is lost', async () => {
    let clockMs = seconds * 1000;
    const nowFn = () => {
      clockMs += 35_000; // Advance > LEASE_TTL_MS / 2 on each check to trigger renewal.
      return Timestamp.fromMillis(clockMs);
    };
    fake.data.set(`accountDeletions/${uid}`, {
      status: 'pending',
      phase: 'cleanup',
      usernameKeys: ['ana-user1'],
      requestedAt: now,
      updatedAt: now,
      attempts: 0,
    });
    const status = await runAccountDeletionWithLease(uid, fake.db, { deleteUser: config.deleteUser } as unknown as Auth, nowFn);
    expect(status).toBe('completed');
    expect(fake.set.mock.calls.length).toBeGreaterThanOrEqual(4); // admission + renewal(s) + auth + completed

    // Simulate lease hijacked mid-cleanup: runAccountDeletionWithLease aborts cleanly and returns pending.
    let hijacked = false;
    let clock2 = seconds * 1000;
    fake.data.set(`accountDeletions/${uid}`, {
      status: 'pending',
      phase: 'cleanup',
      usernameKeys: [],
      requestedAt: now,
      updatedAt: now,
      attempts: 0,
    });
    fake.data.set('rooms/room-owned', { roomId: 'room-owned', ownerId: uid, name: 'Sala' });
    const statusHijacked = await runAccountDeletionWithLease(uid, fake.db, { deleteUser: config.deleteUser } as unknown as Auth, () => {
      clock2 += 35_000;
      if (!hijacked && fake.data.get(`accountDeletions/${uid}`)?.leaseOwner) {
        hijacked = true;
        fake.data.set(`accountDeletions/${uid}`, {
          ...fake.data.get(`accountDeletions/${uid}`),
          leaseOwner: 'another-server-instance',
          leaseExpiresAt: Timestamp.fromMillis(clock2 + 60_000),
        });
      }
      return Timestamp.fromMillis(clock2);
    });
    expect(statusHijacked).toBe('pending');
    expect(fake.data.get(`accountDeletions/${uid}`)?.leaseOwner).toBe('another-server-instance');
  });

  it('resumes pending deletion in production reconciler mode after server restart and skips active leases', async () => {
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS', '');
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER', 'true');
    const auth = { deleteUser: config.deleteUser } as unknown as Auth;

    // 1. Active lease is skipped by reconciler.
    fake.data.set(`accountDeletions/${uid}`, {
      status: 'pending',
      phase: 'auth',
      usernameKeys: [],
      requestedAt: now,
      updatedAt: now,
      attempts: 1,
      leaseOwner: 'active-worker',
      leaseExpiresAt: Timestamp.fromMillis((seconds + 45) * 1000),
    });
    const r1 = createAccountDeletionReconciler({ db: fake.db, auth, now: () => now });
    const skipped = await r1.runOnce();
    expect(skipped.eligible).toBe(0);
    expect(config.deleteUser).not.toHaveBeenCalled();

    // 2. Once lease expires (e.g., after server restart), reconciler resumes and completes deletion.
    const r2 = createAccountDeletionReconciler({ db: fake.db, auth, now: () => Timestamp.fromMillis((seconds + 120) * 1000) });
    const recovered = await r2.runOnce();
    expect(recovered.processed).toBe(1);
    expect(config.deleteUser).toHaveBeenCalledExactlyOnceWith(uid);
    expect(fake.data.get(`accountDeletions/${uid}`)).toMatchObject({ status: 'completed', phase: 'done' });
  });

  it('rejects enabling both test and runtime reconciler modes simultaneously', () => {
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS', 'true');
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER', 'true');
    expect(() => createAccountDeletionReconciler()).toThrow(expect.objectContaining({ statusCode: 400, code: 'RECONCILER_CONFIG_INVALID' }));
  });

  it('prevents production reconciler from connecting to wrong or unverified Firebase project', () => {
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS', '');
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FIREBASE_PROJECT_ID', 'prod-project');
    vi.stubEnv('FIREBASE_EXPECTED_PROJECT_ID', '');
    expect(() => createAccountDeletionReconciler()).toThrow(expect.objectContaining({ statusCode: 501 }));

    vi.stubEnv('FIREBASE_EXPECTED_PROJECT_ID', 'other-project');
    expect(() => createAccountDeletionReconciler()).toThrow(expect.objectContaining({ statusCode: 501 }));

    vi.stubEnv('FIREBASE_EXPECTED_PROJECT_ID', 'prod-project');
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8081');
    expect(() => createAccountDeletionReconciler()).toThrow(expect.objectContaining({ statusCode: 501 }));
  });
});

describe('beginAccountDeletion isolation and deterministic ordering', () => {
  it.each([
    ['NODE_ENV', 'production'], ['TEAMSPEAK_ENABLE_DELETE_TESTS', ''], ['FIREBASE_PROJECT_ID', 'other'],
  ])('disables beginAccountDeletion when %s=%s', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(beginAccountDeletion({ uid, authTime: seconds }, fake.db)).rejects.toMatchObject({ statusCode: 501 });
  });

  it('persists all owned keys in deterministic code-unit order regardless of query order', async () => {
    for (const key of ['zzzzzzzz', 'aaaa_aaa', 'aaaa-aaa']) {
      fake.data.set(`usernames/${key}`, { uid, usernameKey: key });
    }
    await beginAccountDeletion({ uid, authTime: seconds }, fake.db);
    expect(fake.data.get(`accountDeletions/${uid}`)?.usernameKeys)
      .toEqual(['aaaa-aaa', 'aaaa_aaa', 'ana-user1', 'zzzzzzzz']);
    expect(fake.create).toHaveBeenCalledOnce();
  });
});
