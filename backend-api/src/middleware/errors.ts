import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: 'La ruta solicitada no existe.',
  });
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (response.destroyed || response.writableEnded) return;
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    response.status(400).json({ success: false, code: 'INVALID_JSON', message: 'El cuerpo JSON no es válido.' });
    return;
  }

  if (error instanceof z.ZodError) {
    response.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Los datos enviados no son válidos.',
      details: error.issues,
    });
    return;
  }

  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  console.error(error);
  response.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Ocurrió un error interno.',
  });
};
