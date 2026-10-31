import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { usersRouter } from './users.routes';
import { roomsRouter } from './rooms.routes';

export const apiRouter = Router();

apiRouter.use(requireAuth);
apiRouter.use('/users', usersRouter);
apiRouter.use('/rooms', roomsRouter);
