import { Router } from 'express';
import { createMe, deleteMe, getMe, updateMe } from '../controllers/users.controller';

export const usersRouter = Router();

usersRouter.route('/me')
  .get(getMe)
  .post(createMe)
  .patch(updateMe)
  .delete(deleteMe);
