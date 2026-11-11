import type { RequestHandler } from 'express';
import { AppError } from '../middleware/errors';
import { userBodySchema, userPatchSchema } from '../validators/user.validator';
import { createUserProfile, getUserProfile, updateUserProfile } from '../services/users.service';
import { beginAccountDeletion } from '../services/account-deletion.service';

export const getMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  const data = await getUserProfile(request.user);
  if (!response.destroyed) response.json({ success: true, data });
};

export const createMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  const result = await createUserProfile(request.user, userBodySchema.parse(request.body));
  if (response.destroyed) return;
  response.status(result.created ? 201 : 200).json({ success: true, data: result.data });
};
export const updateMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  const data = await updateUserProfile(request.user, userPatchSchema.parse(request.body));
  if (!response.destroyed) response.json({ success: true, data });
};
export const deleteMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  if (request.body !== undefined || (request.header('content-length') && request.header('content-length') !== '0') || request.header('transfer-encoding')) {
    throw new AppError(400, 'VALIDATION_ERROR', 'DELETE no admite cuerpo de solicitud.');
  }
  const data = await beginAccountDeletion(request.user);
  response.status(202).json({ success: true, data });
};
