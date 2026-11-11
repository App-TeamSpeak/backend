import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { AppError } from './errors';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), active: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: () => ({ verifyIdToken: mocks.verify }) }));
vi.mock('../services/account-state.service', () => ({ ensureAccountActive: mocks.active }));
vi.mock('../services/users.service', () => ({ getUserProfile: mocks.get, updateUserProfile: mocks.update }));
import { app } from '../app';
import { requireCompleteProfile } from './complete-profile';
beforeEach(() => {
  vi.resetAllMocks(); mocks.verify.mockResolvedValue({ uid: 'trusted', email_verified: true });
  mocks.active.mockResolvedValue(undefined); mocks.get.mockResolvedValue({ profileStatus: 'incomplete', profile: null });
  mocks.update.mockResolvedValue({ uid: 'trusted', profileStatus: 'complete' });
});
it('fails closed without an authenticated identity', async () => {
  await expect(requireCompleteProfile({} as never, {} as never, vi.fn())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
});
it.each([['patch', '/api/users/me'], ['get', '/api/rooms'], ['post', '/api/rooms'], ['get', '/api/rooms/room/messages']] as const)('denies %s %s despite client claims', async (method, path) => {
  const response = await request(app)[method](path).set('Authorization', 'Bearer fixture').send({ profileStatus: 'complete', uid: 'other' });
  expect(response.status).toBe(403); expect(response.body.code).toBe('PROFILE_INCOMPLETE');
  expect(mocks.get).toHaveBeenCalledWith({ uid: 'trusted', emailVerified: true }); expect(mocks.update).not.toHaveBeenCalled();
});
it('allows GET onboarding without complete profile', async () => {
  const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture');
  expect(response.status).toBe(200); expect(response.body.data.profileStatus).toBe('incomplete');
});
it('allows PATCH after authoritative completion', async () => {
  mocks.get.mockResolvedValue({ profileStatus: 'complete' });
  expect((await request(app).patch('/api/users/me').set('Authorization', 'Bearer fixture').send({ nombre: 'Ana' })).status).toBe(200);
});
it.each([[409, 'PROFILE_INCONSISTENT'], [503, 'FIRESTORE_UNAVAILABLE']] as const)('preserves %s %s instead of granting access', async (status, code) => {
  mocks.get.mockRejectedValue(new AppError(status, code, 'Controlled failure'));
  const response = await request(app).get('/api/rooms').set('Authorization', 'Bearer fixture');
  expect(response.status).toBe(status); expect(response.body.code).toBe(code);
});
it('checks account and verified email before reading profile', async () => {
  mocks.verify.mockResolvedValue({ uid: 'trusted', email_verified: false });
  expect((await request(app).get('/api/rooms').set('Authorization', 'Bearer fixture')).body.code).toBe('EMAIL_NOT_VERIFIED');
  expect(mocks.active).toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
});
