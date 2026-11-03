import { beforeEach, describe, expect, it, vi } from 'vitest';
import { main, runFirestoreSmoke } from './firestore-smoke';

const getFirestoreDb = vi.hoisted(() => vi.fn());
vi.mock('../config/firebase', () => ({ getFirestoreDb }));

describe('Firestore smoke script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('reports connected collections', async () => {
    const log = vi.fn();
    getFirestoreDb.mockReturnValue({
      listCollections: vi.fn().mockResolvedValue([{ id: 'users' }, { id: 'rooms' }]),
    });

    await runFirestoreSmoke(log);

    expect(log).toHaveBeenCalledWith(JSON.stringify({
      success: true,
      service: 'teamspeak-backend-api',
      firestore: 'connected',
      collections: ['users', 'rooms'],
    }));
  });

  it('reports an unknown error without exposing implementation details', async () => {
    const errorLog = vi.fn();
    getFirestoreDb.mockImplementation(() => {
      throw 'failure';
    });

    await main(vi.fn(), errorLog);

    expect(errorLog).toHaveBeenCalledWith('Firestore smoke test failed: Error desconocido');
    expect(process.exitCode).toBe(1);
  });

  it('reports Error messages from failed connections', async () => {
    const errorLog = vi.fn();
    getFirestoreDb.mockImplementation(() => {
      throw new Error('permission denied');
    });

    await main(vi.fn(), errorLog);

    expect(errorLog).toHaveBeenCalledWith('Firestore smoke test failed: permission denied');
    expect(process.exitCode).toBe(1);
  });
});
