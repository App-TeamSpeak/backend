import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/errors';
import { sprint0DemoController } from './sprint0.controller';

const getSprint0DemoDocument = vi.hoisted(() => vi.fn());
vi.mock('../services/firestore.service', () => ({ getSprint0DemoDocument }));

describe('Sprint 0 demo controller', () => {
  it('returns the real Firestore fields in the response', async () => {
    const data = { verificado: true, mensaje: 'Sprint 0 conectado' };
    getSprint0DemoDocument.mockResolvedValueOnce(data);
    const response = { json: vi.fn(), setHeader: vi.fn() };
    const next = vi.fn();

    await sprint0DemoController({} as never, response as never, next);

    expect(response.json).toHaveBeenCalledWith({ success: true, data });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a 404 when the document does not exist', async () => {
    getSprint0DemoDocument.mockResolvedValueOnce(null);
    const next = vi.fn();

    await sprint0DemoController({} as never, { setHeader: vi.fn() } as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const [error] = next.mock.calls[0] as [AppError];
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('SPRINT0_DOCUMENT_NOT_FOUND');
  });

  it('forwards a controlled 503 when Firestore is unavailable', async () => {
    getSprint0DemoDocument.mockRejectedValueOnce(new Error('connection failed'));
    const next = vi.fn();

    await sprint0DemoController({} as never, { setHeader: vi.fn() } as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const [error] = next.mock.calls[0] as [AppError];
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('FIRESTORE_UNAVAILABLE');
  });
});
