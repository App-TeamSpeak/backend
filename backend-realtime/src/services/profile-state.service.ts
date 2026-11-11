import { z } from 'zod';
import { Timestamp } from 'firebase-admin/firestore';
import { readUserProfile } from '../config/firebase';
import { withAuthorizationTimeout } from './account-state.service';

// Contract of persisted users, matching API read validation. No writes/reservations here.
const fields = {
  uid: z.string().min(1), email: z.email(), nombre: z.string().min(1).max(100), apellido: z.string().min(1).max(100),
  username: z.string().min(8).max(30).regex(/^[A-Za-z0-9_-]+$/),
  usernameKey: z.string().min(8).max(30).regex(/^[a-z0-9_-]+$/),
  avatarUrl: z.string().max(2048).url().refine(value => {
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
  }).nullable(),
  profileStatus: z.literal('complete'), createdAt: z.instanceof(Timestamp), updatedAt: z.instanceof(Timestamp),
};
const complete = z.object(fields);
const partial = complete.partial().extend({ profileStatus: z.enum(['complete', 'incomplete']).optional() });
export type ProfileAuthorizationCode = 'PROFILE_INCOMPLETE' | 'PROFILE_INCONSISTENT' | 'AUTHORIZATION_UNAVAILABLE';
export class ProfileAuthorizationError extends Error {
  constructor(public readonly code: ProfileAuthorizationCode) { super(code); this.name = 'ProfileAuthorizationError'; }
}
export async function requireCompleteProfile(uid: string): Promise<void> {
  let value: unknown;
  try { value = await withAuthorizationTimeout(() => readUserProfile(uid)); }
  catch { throw new ProfileAuthorizationError('AUTHORIZATION_UNAVAILABLE'); }
  if (value === undefined) throw new ProfileAuthorizationError('PROFILE_INCOMPLETE');
  const parsed = partial.safeParse(value);
  if (!parsed.success) throw new ProfileAuthorizationError('PROFILE_INCONSISTENT');
  const profile = parsed.data;
  if ((profile.uid !== undefined && profile.uid !== uid)
    || (profile.username && profile.usernameKey && profile.username.toLowerCase() !== profile.usernameKey)) {
    throw new ProfileAuthorizationError('PROFILE_INCONSISTENT');
  }
  if (!complete.safeParse(value).success) throw new ProfileAuthorizationError('PROFILE_INCOMPLETE');
}
