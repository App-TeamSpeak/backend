import { hasAccountDeletion } from '../config/firebase';

export type AuthorizationCode = 'ACCOUNT_UNAVAILABLE' | 'AUTHORIZATION_UNAVAILABLE';
export class AccountAuthorizationError extends Error {
  constructor(public readonly code: AuthorizationCode) { super(code); this.name = 'AccountAuthorizationError'; }
}
export const authorizationTimeoutMs = 5000;

// Separate the caller's deadline from the actual SDK read lifetime.
export function startAccountAuthorization(uid: string): { authorized: Promise<void>; settled: Promise<void> } {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) {
    return { authorized: Promise.reject(new AccountAuthorizationError('AUTHORIZATION_UNAVAILABLE')), settled: Promise.resolve() };
  }
  const read = hasAccountDeletion(uid);
  const settled = read.then(() => undefined, () => undefined);
  const authorized = (async () => {
    try {
      if (await withAuthorizationTimeout(() => read)) throw new AccountAuthorizationError('ACCOUNT_UNAVAILABLE');
    } catch (error) {
      if (error instanceof AccountAuthorizationError) throw error;
      throw new AccountAuthorizationError('AUTHORIZATION_UNAVAILABLE');
    }
  })();
  return { authorized, settled };
}
export async function requireActiveAccount(uid: string): Promise<void> {
  await startAccountAuthorization(uid).authorized;
}
export async function withAuthorizationTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AccountAuthorizationError('AUTHORIZATION_UNAVAILABLE')), authorizationTimeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
