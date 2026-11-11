import { requireCompleteProfile } from '../middleware/complete-profile';
import { deleteMe } from '../controllers/users.controller';
import { requireDeletionAuth, requireDeletionTests } from '../middleware/deletion-auth';
import { requireVerifiedEmail } from '../middleware/email-verified';
import { Router } from 'express';
import { requireActiveAccount } from '../middleware/account-active';
import { requireAuth } from '../middleware/auth';
import { usersRouter } from './users.routes';
import { roomsRouter } from './rooms.routes';

export const apiRouter = Router();

apiRouter.delete('/users/me', requireDeletionTests, requireDeletionAuth, deleteMe);
apiRouter.use(requireAuth);
apiRouter.use(requireActiveAccount);
apiRouter.use('/users', usersRouter);
apiRouter.use(requireVerifiedEmail);
apiRouter.use(requireCompleteProfile);
apiRouter.use('/rooms', roomsRouter);
