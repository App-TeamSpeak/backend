import type { RequestHandler } from 'express';
import { AppError } from '../middleware/errors';
import { userBodySchema } from '../validators/user.validator';
import { createUserProfile, getUserProfile } from '../services/users.service';
import { notImplemented } from '../services/placeholder.service';

export const getMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  response.json({ success: true, data: await getUserProfile(request.user) });
};

export const createMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  const result = await createUserProfile(request.user, userBodySchema.parse(request.body));
  response.status(result.created ? 201 : 200).json({ success: true, data: result.data });
};
export const updateMe: RequestHandler = () => notImplemented('actualizar el perfil');
export const deleteMe: RequestHandler = () => notImplemented('eliminar la cuenta');
