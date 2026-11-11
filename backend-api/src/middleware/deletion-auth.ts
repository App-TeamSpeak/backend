import type { RequestHandler } from 'express';
import { getFirebaseAuth } from '../config/firebase';
import { assertDeletionTestEnvironment, deletionTestProject } from '../config/deletion-test';
import { AppError } from './errors';

export const requireDeletionTests: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  assertDeletionTestEnvironment();
  next();
};

function authenticationError(error: unknown): AppError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const invalid = new Set(['auth/argument-error', 'auth/invalid-argument', 'auth/invalid-id-token']);
  if (invalid.has(code as string)) return new AppError(401, 'AUTH_INVALID', 'El token no es válido.');
  const rejected: Record<string, string> = {
    'auth/id-token-expired': 'AUTH_EXPIRED', 'auth/id-token-revoked': 'AUTH_REVOKED',
    'auth/user-disabled': 'AUTH_USER_DISABLED', 'auth/user-not-found': 'AUTH_USER_DELETED',
  };
  if (typeof code === 'string' && Object.hasOwn(rejected, code)) return new AppError(401, rejected[code], 'La identidad o sesión no permite autorizar la solicitud.');
  if (new Set(['app/network-error', 'app/network-timeout', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/quota-exceeded']).has(code as string)) {
    return new AppError(503, 'AUTH_UNAVAILABLE', 'La autenticación no está disponible.');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Ocurrió un error interno.');
}

// Dedicated verification: ordinary endpoints keep requireAuth unchanged.
export const requireDeletionAuth: RequestHandler = async (request, _response, next) => {
  const authorization = request.header('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
  if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere un token Bearer válido.');
  let auth;
  try { auth = getFirebaseAuth(); } catch (error) { throw authenticationError(error); }
  if (auth.app.options.projectId !== deletionTestProject) throw new AppError(501, 'NOT_IMPLEMENTED', 'Proyecto de pruebas incorrecto.');
  try {
    const decoded = await auth.verifyIdToken(token, true);
    if (typeof decoded.uid !== 'string' || !decoded.uid) throw new AppError(401, 'AUTH_INVALID', 'La identidad no es válida.');
    request.user = { uid: decoded.uid, authTime: decoded.auth_time };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw authenticationError(error);
  }
  next();
};
