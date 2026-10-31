import type { RequestHandler } from 'express';
import { notImplemented } from '../services/placeholder.service';
import { roomBodySchema } from '../validators/room.validator';

export const listRooms: RequestHandler = () => notImplemented('listar salas');
export const getRoom: RequestHandler = () => notImplemented('consultar salas');
export const updateRoom: RequestHandler = () => notImplemented('editar salas');
export const deleteRoom: RequestHandler = () => notImplemented('eliminar salas');
export const joinRoom: RequestHandler = () => notImplemented('unirse a salas');

export const createRoom: RequestHandler = (request) => {
  roomBodySchema.parse(request.body);
  notImplemented('crear salas');
};
