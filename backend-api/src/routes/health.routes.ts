import { Router } from 'express';
import { firestoreHealthController, healthController } from '../controllers/health.controller';

export const healthRouter = Router();

healthRouter.get('/', healthController);
healthRouter.get('/health', healthController);
healthRouter.get('/health/firestore', firestoreHealthController);
