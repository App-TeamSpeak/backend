import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { openapi } from './docs/openapi';
import { healthRouter } from './routes/health.routes';

export const app = express();
const corsOrigin = env.CORS_ORIGINS.length
  ? env.CORS_ORIGINS
  : env.NODE_ENV === 'production' ? false : true;

app.use(helmet());
app.use(cors({ origin: corsOrigin }));
app.get('/api/openapi.json', (_request, response) => response.json(openapi));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.use(healthRouter);
