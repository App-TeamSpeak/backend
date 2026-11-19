import { authorizationContext } from '../middleware/authorization-context';
import { requireCompleteProfile } from '../middleware/complete-profile';
import { deleteMe } from '../controllers/users.controller';
import { requireVerifiedEmail } from '../middleware/email-verified';
import { Router } from 'express';
import { requireActiveAccount } from '../middleware/account-active';
import { requireAuth } from '../middleware/auth';
import { usersRouter } from './users.routes';
import { roomsRouter } from './rooms.routes';

export const apiRouter = Router();

apiRouter.delete('/users/me', requireAuth, deleteMe);
apiRouter.use(requireAuth);
apiRouter.use(authorizationContext);
apiRouter.use(requireActiveAccount);
apiRouter.use('/users', usersRouter);
apiRouter.use(requireVerifiedEmail);
apiRouter.use(requireCompleteProfile);
apiRouter.use('/rooms', roomsRouter);
