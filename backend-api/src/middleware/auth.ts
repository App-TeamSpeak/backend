import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';
import { getFirebaseAuth } from '../config/firebase';

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        authTime?: number;
        emailVerified?: boolean;
        email?: string;
        name?: string;
      };
    }
  }
}

const transientAuthCodes = new Set<unknown>([
  'app/network-error',
  'app/network-timeout',
  'auth/network-request-failed',
  'auth/too-many-requests',
  'auth/quota-exceeded',
]);

const revocationErrorCodes: Record<string, string> = {
  'auth/id-token-expired': 'AUTH_EXPIRED',
  'auth/id-token-revoked': 'AUTH_REVOKED',
  'auth/user-disabled': 'AUTH_USER_DISABLED',
  'auth/user-not-found': 'AUTH_USER_DELETED',
};

export function isTransientAuthError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return transientAuthCodes.has(code);
}

async function authenticateRequest(
  request: Request,
  options: { checkRevoked: boolean; requireRecent?: boolean },
): Promise<void> {
  const authorization = request.header('authorization');
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : undefined;

  if (!token) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere un token Bearer válido.');
  }

  let firebaseAuth;
  try {
    firebaseAuth = getFirebaseAuth();
  } catch {
    throw new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está configurada.');
  }

  try {
    const decoded = options.checkRevoked
      ? await firebaseAuth.verifyIdToken(token, true)
      : await firebaseAuth.verifyIdToken(token);

    if (options.requireRecent) {
      const now = Math.floor(Date.now() / 1000);
      const authTime = decoded.auth_time;
      if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0 || authTime > now || now - authTime > 300) {
        throw new AppError(401, 'AUTH_RECENT_REQUIRED', 'Vuelve a autenticarte antes de cambiar tu correo electrónico.');
      }
    }

    request.user = {
      uid: decoded.uid,
      ...(typeof decoded.auth_time === 'number' ? { authTime: decoded.auth_time } : {}),
      ...(decoded.email_verified === true ? { emailVerified: true } : {}),
      ...(decoded.email ? { email: decoded.email } : {}),
      ...(decoded.name ? { name: decoded.name } : {}),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (options.checkRevoked && typeof code === 'string' && Object.hasOwn(revocationErrorCodes, code)) {
      throw new AppError(401, revocationErrorCodes[code], 'La sesión actual no permite autorizar la solicitud.');
    }
    if (transientAuthCodes.has(code)) {
      throw new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está disponible.');
    }
    throw new AppError(401, 'AUTH_INVALID', 'El token de autenticación no es válido.');
  }
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  try { await authenticateRequest(request, { checkRevoked: false }); next(); }
  catch (error) { next(error); }
}

export async function requireAuthWithRevocation(request: Request, _response: Response, next: NextFunction) {
  try { await authenticateRequest(request, { checkRevoked: true }); next(); }
  catch (error) { next(error); }
}

export async function requireRecentAuth(request: Request, _response: Response, next: NextFunction) {
  try { await authenticateRequest(request, { checkRevoked: true, requireRecent: true }); next(); }
  catch (error) { next(error); }
}
