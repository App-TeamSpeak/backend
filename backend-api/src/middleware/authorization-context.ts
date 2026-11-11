import type { RequestHandler } from 'express';
import { authorizationReadScope, authorizationReadTimeoutMs } from '../services/authorization-read.service';

export const authorizationContext: RequestHandler = (request, response, next) => {
  const controller = new AbortController();
  const cleanup = () => {
    request.off('aborted', abandoned);
    response.off('close', closed); response.off('finish', finished);
  };
  const finished = () => { controller.abort(); cleanup(); };
  const abandoned = () => { controller.abort(); cleanup(); };
  const closed = () => { if (!response.writableFinished) abandoned(); else cleanup(); };
  request.once('aborted', abandoned);
  response.once('close', closed); response.once('finish', finished);
  if (request.aborted || response.destroyed) { abandoned(); return; }
  authorizationReadScope.run({ signal: controller.signal, deadline: Date.now() + authorizationReadTimeoutMs }, next);
};
