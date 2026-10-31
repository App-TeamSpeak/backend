import type { RequestHandler } from 'express';

export const healthController: RequestHandler = (_request, response) => {
  response.json({ success: true, service: 'teamspeak-backend-api', status: 'ok' });
};
