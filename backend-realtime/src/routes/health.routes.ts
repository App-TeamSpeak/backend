import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_request, response) => {
  response.json({ success: true, service: 'teamspeak-backend-realtime', status: 'ok' });
});
