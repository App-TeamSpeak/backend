import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/errors';
import { firestoreHealthController } from './health.controller';

const checkFirestoreConnection = vi.hoisted(() => vi.fn());
vi.mock('../services/firestore.service', () => ({ checkFirestoreConnection }));

describe('Firestore health controller', () => {
  it('returns connected when Firestore responds', async () => {
    checkFirestoreConnection.mockResolvedValueOnce(undefined);
    const response = { json: vi.fn() };
    const next = vi.fn();

    await firestoreHealthController({} as never, response as never, next);

    expect(response.json).toHaveBeenCalledWith({
      success: true,
      service: 'teamspeak-backend-api',
      firestore: 'connected',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a controlled 503 error when Firestore is unavailable', async () => {
    checkFirestoreConnection.mockRejectedValueOnce(new Error('connection failed'));
    const response = { json: vi.fn() };
    const next = vi.fn();

    await firestoreHealthController({} as never, response as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const [error] = next.mock.calls[0] as [AppError];
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('FIRESTORE_UNAVAILABLE');
  });
});
