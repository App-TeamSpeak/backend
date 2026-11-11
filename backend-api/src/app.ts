import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { errorHandler, notFound } from './middleware/errors';
import { openapi } from './docs/openapi';
import { healthRouter } from './routes/health.routes';
import { apiRouter } from './routes/api.routes';
import { sprint0Router } from './routes/sprint0.routes';

export const app = express();
let acceptingRequests = true;
export function setApiAcceptingRequests(value: boolean) { acceptingRequests = value; }
app.use((_request, response, next) => {
  if (!acceptingRequests) { response.status(503).json({ success: false, code: 'SERVER_STOPPED', message: 'El servidor se está deteniendo.' }); return; }
  next();
});
const corsOrigin = env.CORS_ORIGINS.length
  ? env.CORS_ORIGINS
  : env.NODE_ENV === 'production' ? false : true;

app.use(helmet());
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/openapi.json', (_request, response) => response.json(openapi));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.use(healthRouter);
app.use('/api/sprint0', sprint0Router);
app.use('/api', apiRouter);
app.use(notFound);
app.use(errorHandler);
