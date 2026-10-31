import type { RequestHandler } from 'express';
import { notImplemented } from '../services/placeholder.service';

export const getMe: RequestHandler = () => notImplemented('consultar el perfil');
export const updateMe: RequestHandler = () => notImplemented('actualizar el perfil');
export const deleteMe: RequestHandler = () => notImplemented('eliminar la cuenta');
