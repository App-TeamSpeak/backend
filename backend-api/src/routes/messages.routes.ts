import { Router } from 'express';
import { createMessage, listMessages } from '../controllers/messages.controller';

export const messagesRouter = Router({ mergeParams: true });

messagesRouter.route('/')
  .get(listMessages)
  .post(createMessage);
