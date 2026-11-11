import { readAuthorizationDocument } from './authorization-read.service';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { AppError } from '../middleware/errors';
import { userBodySchema, userPatchSchema, type UserPatch, type UserBody } from '../validators/user.validator';
import { assertNoAccountDeletion, ensureAccountActive } from './account-state.service';
import { getFirestoreCollections, withFirestore } from './firestore.service';
import type { UserDocument } from './firestore.documents';

export interface UserIdentity { uid: string; email?: string }
const storedFields = {
  uid: z.string().min(1), email: z.email(),
  nombre: z.string().min(1).max(100), apellido: z.string().min(1).max(100),
  username: z.string().min(8).max(30).regex(/^[A-Za-z0-9_-]+$/),
  usernameKey: z.string().min(8).max(30).regex(/^[a-z0-9_-]+$/),
  avatarUrl: z.string().max(2048).url().refine((value) => {
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
  }).nullable(),
  profileStatus: z.literal('complete'),
  createdAt: z.instanceof(Timestamp), updatedAt: z.instanceof(Timestamp),
};
// Stored data is checked without applying input transforms or defaults.
const storedProfileSchema = z.object(storedFields);
const partialProfileSchema = storedProfileSchema.partial().extend({
  profileStatus: z.enum(['complete', 'incomplete']).optional(),
});
function inconsistent(): never {
  throw new AppError(409, 'PROFILE_INCONSISTENT', 'El perfil o sus reservas requieren revisión.');
}
function inspectProfile(value: unknown, uid: string) {
  const partial = partialProfileSchema.safeParse(value);
  if (!partial.success) return inconsistent();
  const data = partial.data;
  if (data.uid !== undefined && data.uid !== uid) return inconsistent();
  if (data.username && data.usernameKey && data.username.toLowerCase() !== data.usernameKey) return inconsistent();
  const complete = storedProfileSchema.safeParse(value);
  return { partial: data, complete: complete.success ? complete.data : null };
}
function serialize(profile: UserDocument) {
  return { ...profile, createdAt: profile.createdAt.toDate().toISOString(), updatedAt: profile.updatedAt.toDate().toISOString() };
}
export async function getUserProfile(identity: UserIdentity, db?: Firestore) {
  return withFirestore(async (firestore) => {
    await ensureAccountActive(identity.uid, firestore);
    const snapshot = await readAuthorizationDocument(getFirestoreCollections(firestore).users.doc(identity.uid));
    const profile = snapshot.exists ? inspectProfile(snapshot.data(), identity.uid).complete : null;
    return { uid: identity.uid, profileStatus: profile ? 'complete' as const : 'incomplete' as const, profile: profile ? serialize(profile) : null };
  }, db);
}
export async function createUserProfile(identity: UserIdentity, input: UserBody, db?: Firestore) {
  const body = userBodySchema.parse(input);
  if (!identity.email || !z.email().safeParse(identity.email).success) {
    throw new AppError(400, 'AUTH_EMAIL_REQUIRED', 'La identidad autenticada debe incluir un correo válido.');
  }
  const email = identity.email;
  return withFirestore(async (firestore) => {
    const { users, usernames, accountDeletions } = getFirestoreCollections(firestore);
    const profileRef = users.doc(identity.uid);
    const usernameKey = body.username.toLowerCase();
    const usernameRef = usernames.doc(usernameKey);
    return firestore.runTransaction(async (transaction) => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(identity.uid)));
      const profileSnapshot = await transaction.get(profileRef);
      const existing = profileSnapshot.exists ? inspectProfile(profileSnapshot.data(), identity.uid) : null;
      const oldKey = existing?.partial.usernameKey ?? existing?.partial.username?.toLowerCase();
      const requested = await transaction.get(usernameRef);
      const previous = oldKey && oldKey !== usernameKey ? await transaction.get(usernames.doc(oldKey)) : requested;
      // Never write until ownership and all related reservations have been checked.
      const checkReservation = (snapshot: typeof requested, key: string) => {
        if (!snapshot.exists) return;
        const reservation = snapshot.data();
        if (!reservation || reservation.usernameKey !== key || !reservation.uid) return inconsistent();
        if (reservation.uid !== identity.uid) {
          if (key === oldKey) return inconsistent();
          throw new AppError(409, 'USERNAME_TAKEN', 'El username no está disponible.');
        }
      };
      checkReservation(requested, usernameKey);
      if (oldKey && oldKey !== usernameKey) checkReservation(previous, oldKey);
      if (existing?.complete) {
        const profile = existing.complete;
        if (!previous.exists) return inconsistent();
        const identical = profile.nombre === body.nombre && profile.apellido === body.apellido
          && profile.username === body.username && profile.avatarUrl === body.avatarUrl && profile.email === email;
        if (identical) return { created: false, data: { uid: identity.uid, profileStatus: 'complete' as const, profile: serialize(profile) } };
        throw new AppError(409, 'PROFILE_ALREADY_EXISTS', 'El perfil ya está registrado; esta operación no lo actualiza.');
      }
      // Recover missing fields only. Existing valid user data is never silently replaced.
      if (existing) {
        for (const field of ['nombre', 'apellido', 'username', 'avatarUrl'] as const) {
          if (existing.partial[field] !== undefined && existing.partial[field] !== body[field]) return inconsistent();
        }
        if (existing.partial.email !== undefined && existing.partial.email !== email) return inconsistent();
        if (oldKey && oldKey !== usernameKey) return inconsistent();
      } else if (requested.exists) {
        return inconsistent(); // A reservation without its profile requires explicit review.
      }
      const now = Timestamp.now();
      const profile: UserDocument = { ...body, uid: identity.uid, email, usernameKey, profileStatus: 'complete', createdAt: existing?.partial.createdAt ?? now, updatedAt: now };
      if (!requested.exists) transaction.create(usernameRef, { usernameKey, uid: identity.uid });
      if (profileSnapshot.exists) transaction.set(profileRef, profile, { merge: true });
      else transaction.create(profileRef, profile);
      return { created: !profileSnapshot.exists, data: { uid: identity.uid, profileStatus: 'complete' as const, profile: serialize(profile) } };
    });
  }, db);
}


export async function updateUserProfile(identity: UserIdentity, input: UserPatch, db?: Firestore) {
  const patch = userPatchSchema.parse(input);
  return withFirestore(async (firestore) => {
    const { users, usernames, accountDeletions } = getFirestoreCollections(firestore);
    const profileRef = users.doc(identity.uid);
    return firestore.runTransaction(async (transaction) => {
      assertNoAccountDeletion(await transaction.get(accountDeletions.doc(identity.uid)));
      const snapshot = await transaction.get(profileRef);
      if (!snapshot.exists) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Completa el registro mediante POST /api/users/me.');
      const profile = inspectProfile(snapshot.data(), identity.uid).complete;
      if (!profile) throw new AppError(409, 'PROFILE_INCOMPLETE', 'Completa el perfil mediante POST /api/users/me.');
      const oldRef = usernames.doc(profile.usernameKey);
      const oldReservation = await transaction.get(oldRef);
      if (!oldReservation.exists || oldReservation.data()?.uid !== identity.uid
        || oldReservation.data()?.usernameKey !== profile.usernameKey) return inconsistent();
      const usernameKey = (patch.username ?? profile.username).toLowerCase();
      const keyChanged = usernameKey !== profile.usernameKey;
      const newRef = usernames.doc(usernameKey);
      if (keyChanged) {
        const newReservation = await transaction.get(newRef);
        if (newReservation.exists) {
          const reservation = newReservation.data();
          if (!reservation || reservation.usernameKey !== usernameKey || typeof reservation.uid !== 'string' || !reservation.uid) return inconsistent();
          if (reservation.uid === identity.uid) return inconsistent();
          throw new AppError(409, 'USERNAME_TAKEN', 'El username no está disponible.');
        }
      }
      const changes: UserPatch = {};
      for (const field of ['nombre', 'apellido', 'username', 'avatarUrl'] as const) {
        const value = patch[field];
        if (value !== undefined && value !== profile[field]) Object.assign(changes, { [field]: value });
      }
      if (!Object.keys(changes).length) {
        return { uid: identity.uid, profileStatus: 'complete' as const, profile: serialize(profile) };
      }
      const updatedAt = Timestamp.now();
      // All reads precede writes, including the target reservation when renaming.
      if (keyChanged) transaction.create(newRef, { uid: identity.uid, usernameKey });
      transaction.update(profileRef, { ...changes, ...(keyChanged ? { usernameKey } : {}), updatedAt });
      if (keyChanged) transaction.delete(oldRef);
      return { uid: identity.uid, profileStatus: 'complete' as const, profile: serialize({ ...profile, ...changes, usernameKey, updatedAt }) };
    });
  }, db);
}
