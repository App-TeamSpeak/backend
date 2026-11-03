import type { RequestHandler } from 'express';
import { checkFirestoreConnection } from '../services/firestore.service';
import { AppError } from '../middleware/errors';

export const healthController: RequestHandler = (_request, response) => {
  response.json({ success: true, service: 'teamspeak-backend-api', status: 'ok' });
};

export const firestoreHealthController: RequestHandler = async (_request, response, next) => {
  try {
    await checkFirestoreConnection();
    response.json({ success: true, service: 'teamspeak-backend-api', firestore: 'connected' });
  } catch {
    next(new AppError(503, 'FIRESTORE_UNAVAILABLE', 'Firestore no está disponible o no está configurado.'));
  }
};
