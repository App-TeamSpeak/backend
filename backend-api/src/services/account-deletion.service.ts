import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Auth } from 'firebase-admin/auth';
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { getFirebaseAuth } from '../config/firebase';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { isTransientAuthError } from '../middleware/auth';
import { AppError } from '../middleware/errors';
import { getFirestoreCollections, getRoomMembersCollection, getRoomMessagesCollection, withFirestore } from './firestore.service';
import { parseAccountDeletion, readDeletionResources, assertOwnedReservation, deletionInconsistent } from './account-deletion.data';
import type { AccountDeletionDocument } from './firestore.documents';

const MAX_BATCH_OPS = 450;
const LEASE_TTL_MS = 60_000;
const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

class LeaseLostError extends Error {
  constructor() { super('LEASE_LOST'); this.name = 'LeaseLostError'; }
}

function hashStatusToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function validateClientStatusToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (!STATUS_TOKEN_PATTERN.test(token)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El encabezado X-Deletion-Status-Token debe tener entre 32 y 128 caracteres URL-safe.');
  }
  return token;
}

function requireRecent(authTime: unknown): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0 || authTime > now || now - authTime > 300) {
    throw new AppError(401, 'AUTH_RECENT_REQUIRED', 'Vuelve a autenticarte antes de solicitar la eliminación.');
  }
}

export async function beginAccountDeletion(identity: { uid: string; authTime?: number }, db?: Firestore) {
  assertDeletionTestEnvironment();
  return withFirestore(async (firestore) => {
    if (!('projectId' in firestore) || firestore.projectId !== deletionTestProject) throw new AppError(501, 'NOT_IMPLEMENTED', 'Proyecto de pruebas incorrecto.');
    const { usernames, accountDeletions } = getFirestoreCollections(firestore);
    return firestore.runTransaction(async (tx) => {
      const markerRef = accountDeletions.doc(identity.uid);
      const existing = await tx.get(markerRef);
      if (existing.exists) {
        const parsed = parseAccountDeletion(existing.data());
        if (parsed.status === 'blocked') throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'El proceso existente está bloqueado.');
        if (parsed.status === 'completed') throw new AppError(409, 'ACCOUNT_DELETED', 'Existe un proceso de eliminación completado.');
        // Repetition never rewrites progress or trusts a recorded foreign reservation.
        for (const key of parsed.usernameKeys) {
          const reservation = await tx.get(usernames.doc(key));
          const owned = assertOwnedReservation(reservation, key, identity.uid);
          if (!owned && parsed.phase === 'auth') return deletionInconsistent();
        }
        return { status: 'pending' as const };
      }
      requireRecent(identity.authTime);
      const resources = await readDeletionResources(tx, firestore, identity.uid);
      const now = Timestamp.now();
      const marker: AccountDeletionDocument = { status: 'pending', phase: 'auth', usernameKeys: resources.usernameKeys, requestedAt: now, updatedAt: now, attempts: 0 };
      tx.create(markerRef, marker);
      return { status: 'pending' as const };
    });
  }, db);
}

async function commitBatchedWrites(
  firestore: Firestore,
  operations: Array<(batch: ReturnType<Firestore['batch']>) => void>,
  ensureLease?: () => Promise<void>,
): Promise<void> {
  for (let index = 0; index < operations.length; index += MAX_BATCH_OPS) {
    await ensureLease?.();
    const batch = firestore.batch();
    for (const apply of operations.slice(index, index + MAX_BATCH_OPS)) {
      apply(batch);
    }
    await batch.commit();
  }
}

function userResourceQueries(firestore: Firestore, uid: string) {
  return {
    ownedRooms: getFirestoreCollections(firestore).rooms.where('ownerId', '==', uid),
    foreignMemberships: firestore.collectionGroup('members').where('uid', '==', uid),
    foreignMessages: firestore.collectionGroup('messages').where('senderId', '==', uid),
  };
}

async function cleanupUserRoomResources(
  firestore: Firestore,
  uid: string,
  ensureLease?: () => Promise<void>,
): Promise<void> {
  const queries = userResourceQueries(firestore, uid);
  const ownedRooms = await queries.ownedRooms.get();
  for (const roomDoc of ownedRooms.docs) {
    await ensureLease?.();
    const roomId = roomDoc.id;
    const [members, messages] = await Promise.all([
      getRoomMembersCollection(roomId, firestore).get(),
      getRoomMessagesCollection(roomId, firestore).get(),
    ]);
    await commitBatchedWrites(firestore, [
      ...members.docs.map((doc) => (batch: ReturnType<Firestore['batch']>) => batch.delete(doc.ref)),
      ...messages.docs.map((doc) => (batch: ReturnType<Firestore['batch']>) => batch.delete(doc.ref)),
      (batch) => batch.delete(roomDoc.ref),
    ], ensureLease);
  }

  await ensureLease?.();
  const [foreignMemberships, foreignMessages] = await Promise.all([
    queries.foreignMemberships.get(),
    queries.foreignMessages.get(),
  ]);
  await commitBatchedWrites(firestore, [
    ...foreignMemberships.docs.map((doc) => (batch: ReturnType<Firestore['batch']>) => batch.delete(doc.ref)),
    ...foreignMessages.docs.map((doc) => (batch: ReturnType<Firestore['batch']>) => batch.update(doc.ref as DocumentReference, { senderId: null, authorDeleted: true })),
  ], ensureLease);
}

async function hasRemainingUserResources(firestore: Firestore, uid: string): Promise<boolean> {
  const queries = userResourceQueries(firestore, uid);
  const [ownedRooms, foreignMemberships, foreignMessages] = await Promise.all([
    queries.ownedRooms.limit(1).get(),
    queries.foreignMemberships.limit(1).get(),
    queries.foreignMessages.limit(1).get(),
  ]);
  return !ownedRooms.empty || !foreignMemberships.empty || !foreignMessages.empty;
}

function clearLease(doc: AccountDeletionDocument): AccountDeletionDocument {
  const { leaseOwner: _owner, leaseExpiresAt: _exp, ...rest } = doc;
  return rest;
}

async function withLeasedMarker(
  firestore: Firestore,
  markerRef: DocumentReference<AccountDeletionDocument>,
  executionId: string,
  update: (tx: FirebaseFirestore.Transaction, current: AccountDeletionDocument) => Promise<AccountDeletionDocument | null> | AccountDeletionDocument | null,
): Promise<AccountDeletionDocument | null> {
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(markerRef);
    if (!snap.exists) return null;
    const current = parseAccountDeletion(snap.data());
    if (current.status !== 'pending' || current.leaseOwner !== executionId) return current;
    const next = await update(tx, current);
    if (!next) return current;
    tx.set(markerRef, next);
    return next;
  });
}

export async function runAccountDeletionWithLease(
  uid: string,
  db?: Firestore,
  auth?: Auth,
  nowFn: () => Timestamp = Timestamp.now,
): Promise<'pending' | 'blocked' | 'completed'> {
  return withFirestore(async (firestore) => {
    const { accountDeletions, usernames, users } = getFirestoreCollections(firestore);
    const markerRef = accountDeletions.doc(uid);
    const executionId = randomUUID();

    const admission = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(markerRef);
      if (!snap.exists) throw new AppError(404, 'ACCOUNT_DELETION_NOT_FOUND', 'No existe una solicitud de eliminación.');
      const current = parseAccountDeletion(snap.data());
      if (current.status === 'completed') return { run: false as const, status: 'completed' as const };
      if (current.status === 'blocked') return { run: false as const, status: 'blocked' as const };
      const now = nowFn();
      if (current.nextAttemptAt && current.nextAttemptAt.toMillis() > now.toMillis()) {
        return { run: false as const, status: 'pending' as const };
      }
      if (current.leaseOwner && current.leaseExpiresAt && current.leaseExpiresAt.toMillis() > now.toMillis()) {
        return { run: false as const, status: 'pending' as const };
      }
      const leased: AccountDeletionDocument = {
        ...current,
        attempts: current.attempts + 1,
        updatedAt: now,
        leaseOwner: executionId,
        leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_TTL_MS),
      };
      tx.set(markerRef, leased);
      return { run: true as const, phase: leased.phase, attempts: leased.attempts, leasedAt: now.toMillis() };
    });

    if (!admission.run) return admission.status;
    let phase = admission.phase;
    let leaseRenewedAt = admission.leasedAt;

    const ensureLeaseValid = async () => {
      const now = nowFn();
      if (now.toMillis() - leaseRenewedAt < LEASE_TTL_MS / 2) return;
      const renewed = await withLeasedMarker(firestore, markerRef, executionId, (_tx, current) => ({
        ...current,
        updatedAt: now,
        leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_TTL_MS),
      }));
      if (!renewed || renewed.status !== 'pending' || renewed.leaseOwner !== executionId) {
        throw new LeaseLostError();
      }
      leaseRenewedAt = now.toMillis();
    };

    try {
      if (phase === 'cleanup' || phase === 'firestore') {
        await cleanupUserRoomResources(firestore, uid, ensureLeaseValid);
        await ensureLeaseValid();
        if (await hasRemainingUserResources(firestore, uid)) {
          await cleanupUserRoomResources(firestore, uid, ensureLeaseValid);
        }
        const advanced = await withLeasedMarker(firestore, markerRef, executionId, async (tx, current) => {
          const [profileSnap, ownedUsernames] = await Promise.all([
            tx.get(users.doc(uid)),
            tx.get(usernames.where('uid', '==', uid)),
          ]);
          if (profileSnap.exists) tx.delete(users.doc(uid));
          for (const reservation of ownedUsernames.docs) tx.delete(reservation.ref);
          const now = nowFn();
          return {
            ...current,
            phase: 'auth',
            usernameKeys: [],
            updatedAt: now,
            leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_TTL_MS),
          };
        });
        if (!advanced || advanced.status === 'completed') return 'completed';
        if (advanced.status === 'blocked') return 'blocked';
        if (advanced.leaseOwner !== executionId) return 'pending';
        leaseRenewedAt = advanced.updatedAt.toMillis();
        phase = advanced.phase;
      }

      if (phase === 'auth') {
        await ensureLeaseValid();
        let firebaseAuth: Auth;
        try { firebaseAuth = auth ?? getFirebaseAuth(); }
        catch { throw Object.assign(new Error('AUTH_UNAVAILABLE'), { code: 'auth/network-request-failed' }); }
        try { await firebaseAuth.deleteUser(uid); }
        catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
          if (code !== 'auth/user-not-found') throw error;
        }
        const completed = await withLeasedMarker(firestore, markerRef, executionId, (_tx, current) => {
          const now = nowFn();
          const done: AccountDeletionDocument = clearLease({
            ...current,
            status: 'completed',
            phase: 'done',
            usernameKeys: [],
            updatedAt: now,
            completedAt: now,
          });
          delete done.lastErrorCode;
          delete done.nextAttemptAt;
          return done;
        });
        return completed?.status === 'completed' ? 'completed' : completed?.status === 'blocked' ? 'blocked' : 'pending';
      }

      return 'completed';
    } catch (error) {
      if (error instanceof LeaseLostError) return 'pending';
      const transient = isTransientAuthError(error) || (error instanceof AppError && error.statusCode === 503)
        || [4, 8, 10, 14, 'deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable'].includes(
          typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code as never : undefined as never,
        );
      const nextStatus = transient ? 'pending' as const : 'blocked' as const;
      const saved = await withLeasedMarker(firestore, markerRef, executionId, (_tx, current) => {
        const now = nowFn();
        const backoffSec = Math.min(3600, 30 * 2 ** Math.min(admission.attempts - 1, 7));
        return clearLease({
          ...current,
          status: nextStatus,
          lastErrorCode: transient ? 'DELETION_TRANSIENT_FAILURE' : 'DELETION_FAILED',
          updatedAt: now,
          ...(transient ? { nextAttemptAt: Timestamp.fromMillis(now.toMillis() + backoffSec * 1000) } : {}),
        });
      }).catch(() => null);
      return saved?.status === 'blocked' ? 'blocked' : saved?.status === 'completed' ? 'completed' : nextStatus;
    }
  }, db);
}

export async function requestAccountDeletion(
  identity: { uid: string; authTime?: number },
  db?: Firestore,
  auth?: Auth,
  clientStatusToken?: string,
): Promise<{ status: 'pending' | 'completed'; statusToken?: string }> {
  const validatedClientToken = validateClientStatusToken(clientStatusToken);

  const initial = await withFirestore(async (firestore) => {
    const { accountDeletions } = getFirestoreCollections(firestore);
    const markerRef = accountDeletions.doc(identity.uid);
    return firestore.runTransaction(async (tx) => {
      const existing = await tx.get(markerRef);
      if (existing.exists) {
        const parsed = parseAccountDeletion(existing.data());
        if (parsed.status === 'blocked') throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'El proceso de eliminación está bloqueado.');
        if (parsed.statusTokenHash) {
          if (validatedClientToken && hashStatusToken(validatedClientToken) !== parsed.statusTokenHash) {
            throw new AppError(409, 'DELETION_STATUS_TOKEN_MISMATCH', 'El comprobante proporcionado no coincide con la solicitud de eliminación existente.');
          }
          const matchedToken = validatedClientToken && hashStatusToken(validatedClientToken) === parsed.statusTokenHash
            ? validatedClientToken
            : undefined;
          return { status: parsed.status, statusToken: matchedToken };
        }
        const generated = validatedClientToken ?? randomBytes(32).toString('base64url');
        tx.set(markerRef, { ...parsed, statusTokenHash: hashStatusToken(generated), updatedAt: Timestamp.now() });
        return { status: parsed.status, statusToken: generated };
      }
      requireRecent(identity.authTime);
      const resources = await readDeletionResources(tx, firestore, identity.uid);
      const statusToken = validatedClientToken ?? randomBytes(32).toString('base64url');
      const now = Timestamp.now();
      const marker: AccountDeletionDocument = {
        status: 'pending',
        phase: 'cleanup',
        usernameKeys: resources.usernameKeys,
        requestedAt: now,
        updatedAt: now,
        attempts: 0,
        statusTokenHash: hashStatusToken(statusToken),
      };
      tx.create(markerRef, marker);
      return { status: 'pending' as const, statusToken };
    });
  }, db);

  if (initial.status === 'completed') {
    return { status: 'completed', ...(initial.statusToken ? { statusToken: initial.statusToken } : {}) };
  }
  const finalStatus = await runAccountDeletionWithLease(identity.uid, db, auth);
  if (finalStatus === 'blocked') {
    throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'El proceso de eliminación quedó bloqueado y requiere revisión.');
  }
  return { status: finalStatus, ...(initial.statusToken ? { statusToken: initial.statusToken } : {}) };
}

export async function getAccountDeletionStatus(
  query: { statusToken?: string; uid?: string },
  db?: Firestore,
): Promise<{ status: 'none' | 'pending' | 'blocked' | 'completed' }> {
  return withFirestore(async (firestore) => {
    const { accountDeletions } = getFirestoreCollections(firestore);
    if (query.statusToken) {
      const hash = hashStatusToken(query.statusToken);
      const matches = await accountDeletions.where('statusTokenHash', '==', hash).limit(1).get();
      if (matches.empty) {
        throw new AppError(404, 'DELETION_STATUS_NOT_FOUND', 'No se encontró una solicitud de eliminación para el token proporcionado.');
      }
      const parsed = parseAccountDeletion(matches.docs[0].data());
      return { status: parsed.status };
    }
    if (query.uid) {
      const snap = await accountDeletions.doc(query.uid).get();
      if (!snap.exists) return { status: 'none' };
      const parsed = parseAccountDeletion(snap.data());
      return { status: parsed.status };
    }
    throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación o token de estado de eliminación.');
  }, db);
}
