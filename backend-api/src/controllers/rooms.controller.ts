import type { RequestHandler } from 'express';
import { AppError } from '../middleware/errors';
import { roomBodySchema } from '../validators/room.validator';
import { createRoom as create, deleteRoom as remove, getRoom as get, joinRoom as join, listRooms as list, updateRoom as update } from '../services/rooms.service';

const uid = (request: Parameters<RequestHandler>[0]) => { if (!request.user) throw new AppError(401, 'AUTH_REQUIRED', 'Se requiere autenticación.'); return request.user.uid; };
const roomId = (request: Parameters<RequestHandler>[0]) => { const value = request.params.roomId; if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'El identificador de sala no es válido.'); return value; };
export const listRooms: RequestHandler = async (request, response) => response.json({ success: true, data: await list(uid(request)) });
export const getRoom: RequestHandler = async (request, response) => response.json({ success: true, data: await get(uid(request), roomId(request)) });
export const updateRoom: RequestHandler = async (request, response) => { const body = roomBodySchema.parse(request.body); response.json({ success: true, data: await update(uid(request), roomId(request), body.name) }); };
export const deleteRoom: RequestHandler = async (request, response) => response.json({ success: true, data: await remove(uid(request), roomId(request)) });
export const joinRoom: RequestHandler = async (request, response) => response.json({ success: true, data: await join(uid(request), roomId(request)) });

export const createRoom: RequestHandler = async (request, response) => {
  const body = roomBodySchema.parse(request.body);
  response.status(201).json({ success: true, data: await create(uid(request), body.name) });
};
