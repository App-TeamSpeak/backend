import { assertAuthorizationActive } from '../services/authorization-read.service';
import type { RequestHandler } from 'express';
import { AppError } from './errors';
import { getUserProfile } from '../services/users.service';

// Reuse the authoritative stored-profile validation, never client state or claims.
export const requireCompleteProfile: RequestHandler = async (request, _response, next) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  const state = await getUserProfile(request.user);
  if (state.profileStatus !== 'complete') throw new AppError(403, 'PROFILE_INCOMPLETE', 'Completa tu perfil y selecciona un username antes de acceder.');
  assertAuthorizationActive();
  next();
};
