import { Router } from 'express';
import { deleteMe, getMe, updateMe } from '../controllers/users.controller';

export const usersRouter = Router();

usersRouter.route('/me')
  .get(getMe)
  .patch(updateMe)
  .delete(deleteMe);
