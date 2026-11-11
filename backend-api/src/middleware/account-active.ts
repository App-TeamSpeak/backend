import { assertAuthorizationActive } from '../services/authorization-read.service';
import type { RequestHandler } from 'express';
import { AppError } from './errors';
import { ensureAccountActive } from '../services/account-state.service';

// Authentication establishes identity; this checks account access, not profile completeness.
export const requireActiveAccount: RequestHandler = async (request, _response, next) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  await ensureAccountActive(request.user.uid);
  assertAuthorizationActive();
  next();
};
