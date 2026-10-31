import { AppError } from '../middleware/errors';

export function notImplemented(resource: string): never {
  throw new AppError(
    501,
    'NOT_IMPLEMENTED',
    `La operación de ${resource} está preparada, pero aún no implementada.`,
  );
}
