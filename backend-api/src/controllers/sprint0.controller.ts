import type { RequestHandler } from 'express';
import { AppError } from '../middleware/errors';
import { getSprint0DemoDocument } from '../services/firestore.service';

export const sprint0DemoController: RequestHandler = async (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const document = await getSprint0DemoDocument();

    if (!document) {
      next(new AppError(404, 'SPRINT0_DOCUMENT_NOT_FOUND', 'El documento de verificación de Sprint 0 no existe.'));
      return;
    }

    response.json({ success: true, data: document });
  } catch {
    next(new AppError(503, 'FIRESTORE_UNAVAILABLE', 'Firestore no está disponible o no está configurado.'));
  }
};
