import type { RequestHandler } from 'express';
import { notImplemented } from '../services/placeholder.service';

export const listMessages: RequestHandler = () => notImplemented('consultar mensajes');
export const createMessage: RequestHandler = () => notImplemented('guardar mensajes');
