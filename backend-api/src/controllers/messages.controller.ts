import type { RequestHandler } from 'express';
import { AppError } from '../middleware/errors';
import { messageBodySchema } from '../validators/message.validator';
import { createMessage as create, listMessages as list } from '../services/messages.service';

const uid = (request: Parameters<RequestHandler>[0]) => { if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.'); return request.user.uid; };
const roomId = (request: Parameters<RequestHandler>[0]) => { const value = request.params.roomId; if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'El identificador de sala no es válido.'); return value; };
export const listMessages: RequestHandler = async (request, response) => response.json({ success: true, data: await list(uid(request), roomId(request)) });
export const createMessage: RequestHandler = async (request, response) => { const body = messageBodySchema.parse(request.body); response.status(201).json({ success: true, data: await create(uid(request), roomId(request), body.text) }); };
