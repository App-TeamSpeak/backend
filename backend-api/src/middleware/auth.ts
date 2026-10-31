import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';
import { getFirebaseAuth } from '../config/firebase';

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
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
      ...(decoded.email ? { email: decoded.email } : {}),
      ...(decoded.name ? { name: decoded.name } : {}),
    };
    next();
  } catch {
    next(new AppError(401, 'AUTH_INVALID', 'El token de autenticación no es válido.'));
  }
}
