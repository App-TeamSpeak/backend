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

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  const authorization = request.header('authorization');
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : undefined;

  if (!token) {
    next(new AppError(401, 'AUTH_REQUIRED', 'Se requiere un token Bearer válido.'));
    return;
  }

  let firebaseAuth;
  try {
    firebaseAuth = getFirebaseAuth();
  } catch {
    next(new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está configurada.'));
    return;
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    request.user = {
      uid: decoded.uid,
      ...(typeof decoded.auth_time === 'number' ? { authTime: decoded.auth_time } : {}),
      ...(decoded.email_verified === true ? { emailVerified: true } : {}),
      ...(decoded.email ? { email: decoded.email } : {}),
      ...(decoded.name ? { name: decoded.name } : {}),
    };
    next();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (new Set<unknown>(['app/network-error', 'app/network-timeout', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/quota-exceeded']).has(code)) {
      next(new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está disponible.'));
      return;
    }
    next(new AppError(401, 'AUTH_INVALID', 'El token de autenticación no es válido.'));
  }
}

export async function requireRecentAuth(request: Request, _response: Response, next: NextFunction) {
  const authorization = request.header('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
  if (!token) {
    next(new AppError(401, 'AUTH_REQUIRED', 'Se requiere un token Bearer válido.'));
    return;
  }
  let firebaseAuth;
  try {
    firebaseAuth = getFirebaseAuth();
  } catch {
    next(new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está configurada.'));
    return;
  }
  try {
    const decoded = await firebaseAuth.verifyIdToken(token, true);
    const now = Math.floor(Date.now() / 1000);
    const authTime = decoded.auth_time;
    if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0 || authTime > now || now - authTime > 300) {
      next(new AppError(401, 'AUTH_RECENT_REQUIRED', 'Vuelve a autenticarte antes de cambiar tu correo electrónico.'));
      return;
    }
    request.user = {
      uid: decoded.uid,
      authTime,
      ...(decoded.email_verified === true ? { emailVerified: true } : {}),
      ...(decoded.email ? { email: decoded.email } : {}),
      ...(decoded.name ? { name: decoded.name } : {}),
    };
    next();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const mapped: Record<string, string> = {
      'auth/id-token-expired': 'AUTH_EXPIRED',
      'auth/id-token-revoked': 'AUTH_REVOKED',
      'auth/user-disabled': 'AUTH_USER_DISABLED',
      'auth/user-not-found': 'AUTH_USER_DELETED',
    };
    if (typeof code === 'string' && Object.hasOwn(mapped, code)) {
      next(new AppError(401, mapped[code], 'La sesión actual no permite autorizar el cambio de correo.'));
      return;
    }
    if (new Set<unknown>(['app/network-error', 'app/network-timeout', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/quota-exceeded']).has(code)) {
      next(new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está disponible.'));
      return;
    }
    next(new AppError(401, 'AUTH_INVALID', 'El token de autenticación no es válido.'));
  }
}
