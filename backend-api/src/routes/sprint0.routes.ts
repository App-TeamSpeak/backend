import { Router } from 'express';
import { sprint0DemoController } from '../controllers/sprint0.controller';

export const sprint0Router = Router();

sprint0Router.get('/demo', sprint0DemoController);
