import request from 'supertest';
import type { Auth } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getFirebaseAuth: vi.fn(),
  getFirestoreDb: vi.fn(),
}));
vi.mock('../config/firebase', () => ({
  getFirebaseAuth: mocks.getFirebaseAuth,
  getFirestoreDb: mocks.getFirestoreDb,
}));

import { app } from '../app';
import { getUserProfileAndSyncEmail, validateEmailChangeEligibility } from './users.service';

const uid = 'uid-1';
const nowSeconds = 1800000000;
const baseProfile = {
  uid,
  email: 'ana@example.com',
  nombre: 'Ana',
  apellido: 'Pérez',
  username: 'Ana-User1',
  usernameKey: 'ana-user1',
  avatarUrl: null,
  profileStatus: 'complete' as const,
  createdAt: Timestamp.fromMillis(1000),
  updatedAt: Timestamp.fromMillis(2000),
};

function makeDb(options: {
  profile?: Record<string, unknown> | null;
  deletion?: Record<string, unknown>;
  emailDocs?: Array<{ id: string; data: Record<string, unknown> }>;
} = {}) {
  let currentProfile = options.profile === undefined ? { ...baseProfile } : options.profile;
  const update = vi.fn((_ref: unknown, patch: Record<string, unknown>) => {
    if (currentProfile) currentProfile = { ...currentProfile, ...patch };
  });
  const docSnapshot = (collection: string) => {
    if (collection === 'accountDeletions') {
      return { exists: options.deletion !== undefined, data: () => options.deletion };
    }
    if (collection === 'users') {
      return { exists: currentProfile !== null, data: () => currentProfile };
    }
    return { exists: false, data: () => undefined };
  };
  const doc = (collection: string, id: string) => ({
    collection,
    id,
    get: vi.fn(async () => docSnapshot(collection)),
    onSnapshot: (next: (snap: unknown) => void) => {
      queueMicrotask(() => next(docSnapshot(collection)));
      return () => undefined;
    },
  });
  const tx = {
    get: vi.fn(async (ref: { collection: string }) => docSnapshot(ref.collection)),
    update,
  };
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => doc(name, id),
      where: (_field: string, _op: string, email: string) => ({
        limit: () => ({
          get: vi.fn(async () => {
            const docs = (options.emailDocs ?? [])
              .filter((entry) => entry.data.email === email)
              .map((entry) => ({ id: entry.id, data: () => entry.data }));
            return { empty: docs.length === 0, size: docs.length, docs };
          }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: (transaction: typeof tx) => unknown) => fn(tx)),
  };
  return { db: db as unknown as Firestore, tx, update };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000);
  mocks.getFirebaseAuth.mockReturnValue({
    verifyIdToken: mocks.verifyIdToken,
    getUser: mocks.getUser,
    getUserByEmail: mocks.getUserByEmail,
  });
  mocks.verifyIdToken.mockResolvedValue({
    uid,
    email: 'ana@example.com',
    email_verified: true,
    auth_time: nowSeconds - 10,
  });
  mocks.getUser.mockResolvedValue({
    uid,
    email: 'ana@example.com',
    emailVerified: true,
    providerData: [{ providerId: 'password' }],
  });
  mocks.getUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' });
});

afterEach(() => vi.restoreAllMocks());

describe('US-04 safe email-change eligibility', () => {
  it('allows password-linked account with recent auth and unique new email', async () => {
    const { db } = makeDb();
    const auth = mocks.getFirebaseAuth() as unknown as Auth;
    const result = await validateEmailChangeEligibility(
      { uid, authTime: nowSeconds - 60 },
      { newEmail: '  Ana.Nueva@Example.com ' },
      db,
      auth,
    );
    expect(result).toEqual({
      eligible: true,
      currentEmail: 'ana@example.com',
      targetEmail: 'ana.nueva@example.com',
      nextStep: 'verify_before_update_email',
    });
  });

  it('allows hybrid password + google.com linked accounts', async () => {
    mocks.getUser.mockResolvedValueOnce({
      uid,
      email: 'ana@example.com',
      emailVerified: true,
      providerData: [{ providerId: 'google.com' }, { providerId: 'password' }],
    });
    const { db } = makeDb();
    const result = await validateEmailChangeEligibility(
      { uid, authTime: nowSeconds },
      { newEmail: 'nueva@example.com' },
      db,
      mocks.getFirebaseAuth() as unknown as Auth,
    );
    expect(result.eligible).toBe(true);
  });

  it('rejects Google-only accounts with 403 EMAIL_CHANGE_NOT_ALLOWED', async () => {
    mocks.getUser.mockResolvedValueOnce({
      uid,
      email: 'ana@example.com',
      emailVerified: true,
      providerData: [{ providerId: 'google.com' }],
    });
    const { db } = makeDb();
    await expect(
      validateEmailChangeEligibility({ uid, authTime: nowSeconds }, { newEmail: 'nueva@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 403, code: 'EMAIL_CHANGE_NOT_ALLOWED' });
  });

  it('rejects stale authTime with 401 AUTH_RECENT_REQUIRED', async () => {
    const { db } = makeDb();
    await expect(
      validateEmailChangeEligibility({ uid, authTime: nowSeconds - 301 }, { newEmail: 'nueva@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_RECENT_REQUIRED' });
  });

  it('rejects same email with 400 EMAIL_UNCHANGED', async () => {
    const { db } = makeDb();
    await expect(
      validateEmailChangeEligibility({ uid, authTime: nowSeconds }, { newEmail: 'ANA@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 400, code: 'EMAIL_UNCHANGED' });
  });

  it('rejects email already registered in Firebase Auth with 409 EMAIL_TAKEN', async () => {
    mocks.getUserByEmail.mockResolvedValueOnce({ uid: 'other-uid' });
    const { db } = makeDb();
    await expect(
      validateEmailChangeEligibility({ uid, authTime: nowSeconds }, { newEmail: 'taken@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
  });

  it('rejects email already present in Firestore users with 409 EMAIL_TAKEN', async () => {
    const { db } = makeDb({ emailDocs: [{ id: 'other-uid', data: { email: 'taken@example.com' } }] });
    await expect(
      validateEmailChangeEligibility({ uid, authTime: nowSeconds }, { newEmail: 'taken@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
  });

  it('blocks email change when account deletion is pending', async () => {
    const { db } = makeDb({ deletion: { status: 'pending' } });
    await expect(
      validateEmailChangeEligibility({ uid, authTime: nowSeconds }, { newEmail: 'nueva@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_DELETION_PENDING' });
  });
});

describe('US-04 Auth -> Firestore email reconciliation', () => {
  it('syncs verified Auth email to Firestore idempotently', async () => {
    const { db, update } = makeDb();
    mocks.getUser.mockResolvedValueOnce({ uid, email: 'Verified.New@Example.com', emailVerified: true });
    const first = await getUserProfileAndSyncEmail({ uid, email: 'verified.new@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth);
    expect(first.profile?.email).toBe('verified.new@example.com');
    expect(update).toHaveBeenCalledTimes(1);

    // Second call with already-synced profile skips all writes.
    const second = await getUserProfileAndSyncEmail({ uid, email: 'verified.new@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth);
    expect(second.profile?.email).toBe('verified.new@example.com');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite Firestore email when Auth email is not verified', async () => {
    const { db, update } = makeDb();
    mocks.getUser.mockResolvedValueOnce({ uid, email: 'unverified@example.com', emailVerified: false });
    const result = await getUserProfileAndSyncEmail({ uid, email: 'unverified@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth);
    expect(result.profile?.email).toBe('ana@example.com');
    expect(update).not.toHaveBeenCalled();
  });

  it('maps temporary Firestore failure to 503 FIRESTORE_UNAVAILABLE for recovery', async () => {
    const { db } = makeDb();
    (db as unknown as { runTransaction: ReturnType<typeof vi.fn> }).runTransaction.mockRejectedValueOnce({ code: 14 });
    mocks.getUser.mockResolvedValueOnce({ uid, email: 'new@example.com', emailVerified: true });
    await expect(
      getUserProfileAndSyncEmail({ uid, email: 'new@example.com' }, db, mocks.getFirebaseAuth() as unknown as Auth),
    ).rejects.toMatchObject({ statusCode: 503, code: 'FIRESTORE_UNAVAILABLE' });
  });
});

describe('HTTP POST /api/users/me/email-change', () => {
  it('verifies token with revocation check and returns 200 when eligible', async () => {
    const { db } = makeDb();
    mocks.getFirestoreDb.mockReturnValue(db);
    const response = await request(app)
      .post('/api/users/me/email-change')
      .set('Authorization', 'Bearer fresh-token')
      .send({ newEmail: 'nueva@example.com' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        eligible: true,
        currentEmail: 'ana@example.com',
        targetEmail: 'nueva@example.com',
        nextStep: 'verify_before_update_email',
      },
    });
    expect(mocks.verifyIdToken).toHaveBeenCalledWith('fresh-token', true);
  });

  it('rejects revoked tokens with 401 AUTH_REVOKED', async () => {
    mocks.verifyIdToken.mockRejectedValueOnce({ code: 'auth/id-token-revoked' });
    const response = await request(app)
      .post('/api/users/me/email-change')
      .set('Authorization', 'Bearer revoked-token')
      .send({ newEmail: 'nueva@example.com' });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REVOKED');
  });

  it('rejects stale auth_time at middleware level with 401 AUTH_RECENT_REQUIRED', async () => {
    mocks.verifyIdToken.mockResolvedValueOnce({
      uid,
      email: 'ana@example.com',
      email_verified: true,
      auth_time: nowSeconds - 600,
    });
    const response = await request(app)
      .post('/api/users/me/email-change')
      .set('Authorization', 'Bearer old-token')
      .send({ newEmail: 'nueva@example.com' });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_RECENT_REQUIRED');
  });
});
