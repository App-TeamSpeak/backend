import type { RequestHandler } from 'express';
import { getFirebaseAuth } from '../config/firebase';
import { AppError } from '../middleware/errors';
import { emailChangeSchema, userBodySchema, userPatchSchema } from '../validators/user.validator';
import { createUserProfile, getUserProfile, syncUserEmailFromAuth, updateUserProfile, validateEmailChangeEligibility } from '../services/users.service';
import { getAccountDeletionStatus, requestAccountDeletion } from '../services/account-deletion.service';

export const getMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  const current = await getUserProfile(request.user);
  const data = current.profileStatus === 'complete' && current.profile && request.user.email
    && typeof current.profile.email === 'string'
    && request.user.email.trim().toLowerCase() !== current.profile.email.toLowerCase()
    ? await syncUserEmailFromAuth(request.user, current)
    : current;
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

export const requestEmailChange: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  const data = await validateEmailChangeEligibility(request.user, emailChangeSchema.parse(request.body));
  if (!response.destroyed) response.json({ success: true, data });
};
export const deleteMe: RequestHandler = async (request, response) => {
  if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.');
  response.setHeader('Cache-Control', 'no-store');
  if (request.body !== undefined || (request.header('content-length') && request.header('content-length') !== '0') || request.header('transfer-encoding')) {
    throw new AppError(400, 'VALIDATION_ERROR', 'DELETE no admite cuerpo de solicitud.');
  }
  const data = await requestAccountDeletion(request.user);
  if (!response.destroyed) response.status(data.status === 'completed' ? 200 : 202).json({ success: true, data });
};

export const getDeletionStatus: RequestHandler = async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const statusToken = request.header('x-deletion-status-token')?.trim();
  if (statusToken) {
    const data = await getAccountDeletionStatus({ statusToken });
    if (!response.destroyed) response.json({ success: true, data });
    return;
  }
  const authorization = request.header('authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
  if (!bearer) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere token Bearer o X-Deletion-Status-Token.');
  let decoded;
  try {
    decoded = await getFirebaseAuth().verifyIdToken(bearer);
  } catch {
    throw new AppError(401, 'AUTH_INVALID', 'El token de autenticación no es válido.');
  }
  const data = await getAccountDeletionStatus({ uid: decoded.uid });
  if (!response.destroyed) response.json({ success: true, data });
};
