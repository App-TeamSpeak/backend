import { Router, type RequestHandler } from 'express';

export const healthRouter = Router();

const healthHandler: RequestHandler = (_request, response) => {
  response.json({ success: true, service: 'teamspeak-backend-realtime', status: 'ok' });
};

healthRouter.get('/', healthHandler);
healthRouter.get('/health', healthHandler);
