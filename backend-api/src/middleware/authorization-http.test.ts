import request from 'supertest';
import http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), getProfile: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: () => ({ verifyIdToken: async () => ({ uid: 'trusted', email_verified: true }) }), getFirestoreDb: () => ({ collection: () => ({ doc: () => ({ onSnapshot: mocks.subscribe }) }) }) }));
vi.mock('../services/users.service', () => ({ getUserProfile: mocks.getProfile }));
import { app, setApiAcceptingRequests } from '../app';
beforeEach(() => { vi.resetAllMocks(); setApiAcceptingRequests(true); });
afterEach(() => { vi.useRealTimers(); setApiAcceptingRequests(true); });
it('responds 503 at the authorization deadline and ignores a later SDK result', async () => {
  vi.useFakeTimers(); let subscribed!: () => void; const ready = new Promise<void>(resolve => { subscribed = resolve; }); let late!: (value: unknown) => void;
  const stop = vi.fn(); mocks.subscribe.mockImplementation(next => { late = next; subscribed(); return stop; });
  const response = request(app).get('/api/users/me').set('Authorization', 'Bearer fixture').then(value => value);
  await ready; await vi.advanceTimersByTimeAsync(5000); const result = await response;
  expect(result.status).toBe(503); expect(result.body.code).toBe('FIRESTORE_UNAVAILABLE'); expect(stop).toHaveBeenCalledOnce();
  late({ exists: false }); await Promise.resolve(); expect(mocks.getProfile).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('unsubscribes on a real client disconnect and never continues authorization', async () => {
  let subscribed!: () => void; const ready = new Promise<void>(resolve => { subscribed = resolve; });
  let stopped!: () => void; const cleanup = new Promise<void>(resolve => { stopped = resolve; });
  let late!: (value: unknown) => void; mocks.subscribe.mockImplementation(next => { late = next; subscribed(); return stopped; });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const client = http.get({ host: '127.0.0.1', port: (server.address() as { port: number }).port, path: '/api/users/me', headers: { Authorization: 'Bearer fixture' } });
  client.on('error', () => undefined);
  try { await ready; client.destroy(); await cleanup; late({ exists: false }); await Promise.resolve(); expect(mocks.getProfile).not.toHaveBeenCalled(); }
  finally { client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('rejects admission during shutdown without creating another SDK subscription', async () => {
  setApiAcceptingRequests(false); const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture');
  expect(response.status).toBe(503); expect(response.body.code).toBe('SERVER_STOPPED'); expect(mocks.subscribe).not.toHaveBeenCalled();
});
