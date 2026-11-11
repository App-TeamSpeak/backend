import type { RequestHandler } from 'express';
import { AppError } from './errors';

// Only populated by requireAuth from a verified Firebase ID token.
export const requireVerifiedEmail: RequestHandler = (request, _response, next) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  if (request.user.emailVerified !== true) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verifica tu correo y actualiza el ID token para acceder.');
  next();
};
