import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { AppError } from './errors';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), active: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: () => ({ verifyIdToken: mocks.verify }) }));
vi.mock('../services/account-state.service', () => ({ ensureAccountActive: mocks.active }));
vi.mock('../services/users.service', () => ({ getUserProfile: mocks.get, createUserProfile: mocks.create, updateUserProfile: mocks.update }));
import { app } from '../app';
import { requireVerifiedEmail } from './email-verified';
beforeEach(() => {
  vi.resetAllMocks(); mocks.verify.mockResolvedValue({ uid: 'fixture', email: 'fixture@example.invalid', email_verified: false });
  mocks.active.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue({ uid: 'fixture', profileStatus: 'incomplete', profile: null });
  mocks.create.mockResolvedValue({ created: true, data: { uid: 'fixture', profileStatus: 'complete' } });
  mocks.update.mockResolvedValue({ uid: 'fixture', profileStatus: 'complete' });
});
it('fails closed when used without authenticated identity', () => {
  expect(() => requireVerifiedEmail({} as never, {} as never, vi.fn())).toThrow('Se requiere autenticación.');
});
it.each([false, undefined, 'true', 1])('rejects private access unless the trusted claim is exactly true: %s', async (claim) => {
  mocks.verify.mockResolvedValue({ uid: 'fixture', email_verified: claim });
  for (const [method, path] of [['patch','/api/users/me'], ['get','/api/rooms'], ['post','/api/rooms'], ['get','/api/rooms/fixture/messages']] as const) {
    const response = await request(app)[method](path).set('Authorization', 'Bearer fixture').send({ emailVerified: true });
    expect(response.status).toBe(403); expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
  }
  expect(mocks.update).not.toHaveBeenCalled();
});
it('permits authenticated onboarding before verification and defaults avatar to null', async () => {
  expect((await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture')).status).toBe(200);
  expect((await request(app).post('/api/users/me').set('Authorization', 'Bearer fixture').send({ nombre: 'Ana', apellido: 'Pérez', username: 'Ana-user1' })).status).toBe(201);
  expect(mocks.create).toHaveBeenCalledWith({ uid: 'fixture', email: 'fixture@example.invalid' }, { nombre: 'Ana', apellido: 'Pérez', username: 'Ana-user1', avatarUrl: null });
});
it('accepts a verified token without depending on its provider', async () => {
  mocks.verify.mockResolvedValue({ uid: 'fixture', email_verified: true, firebase: { sign_in_provider: 'google.com' } });
  expect((await request(app).patch('/api/users/me').set('Authorization', 'Bearer fixture').send({ nombre: 'Ana' })).status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith({ uid: 'fixture', emailVerified: true }, { nombre: 'Ana' });
});
it('preserves account deletion protection even for onboarding and verified identities', async () => {
  mocks.active.mockRejectedValue(new AppError(403, 'ACCOUNT_DELETION_PENDING', 'blocked'));
  for (const verified of [false, true]) {
    mocks.verify.mockResolvedValue({ uid: 'fixture', email_verified: verified });
    expect((await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture')).body.code).toBe('ACCOUNT_DELETION_PENDING');
  }
});
it('rejects body claims during onboarding and preserves missing/invalid token errors', async () => {
  const body = { nombre: 'Ana', apellido: 'Pérez', username: 'Ana-user1', emailVerified: true };
  expect((await request(app).post('/api/users/me').set('Authorization', 'Bearer fixture').send(body)).status).toBe(400);
  expect((await request(app).get('/api/rooms')).body.code).toBe('AUTH_REQUIRED');
  mocks.verify.mockRejectedValue(new Error('invalid'));
  expect((await request(app).get('/api/rooms').set('Authorization', 'Bearer invalid')).body.code).toBe('AUTH_INVALID');
});
it.each(['/health','/api/openapi.json'])('keeps public %s available without authentication', async (path) => {
  expect((await request(app).get(path)).status).toBe(200); expect(mocks.verify).not.toHaveBeenCalled();
});
