import { Router } from 'express';
import { createRoom, deleteRoom, getRoom, listRooms, updateRoom, joinRoom } from '../controllers/rooms.controller';
import { messagesRouter } from './messages.routes';

export const roomsRouter = Router();

roomsRouter.get('/', listRooms);
roomsRouter.post('/', createRoom);
roomsRouter.route('/:roomId')
  .get(getRoom)
  .patch(updateRoom)
  .delete(deleteRoom);
roomsRouter.post('/:roomId/join', joinRoom);
roomsRouter.use('/:roomId/messages', messagesRouter);
