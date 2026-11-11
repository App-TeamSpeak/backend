import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getAuth: vi.fn(), verify: vi.fn(), active: vi.fn(), profile: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: mocks.getAuth }));
vi.mock('../services/account-state.service', () => ({ ensureAccountActive: mocks.active }));
vi.mock('../services/users.service', () => ({ getUserProfile: mocks.profile }));
import { app } from '../app';
beforeEach(() => {
  vi.resetAllMocks(); mocks.getAuth.mockReturnValue({ verifyIdToken: mocks.verify });
  mocks.verify.mockResolvedValue({ uid: 'trusted', email: 'trusted@example.com', email_verified: true, name: 'Trusted' });
  mocks.active.mockResolvedValue(undefined); mocks.profile.mockResolvedValue({ uid: 'trusted', profileStatus: 'complete', profile: {} });
});
it.each([undefined, '', 'Basic fixture', 'Bearer', 'Bearer ', 'bearer fixture'])('rejects missing/unrecognized Bearer %s before accessing SDK', async header => {
  const call = request(app).get('/api/users/me'); if (header !== undefined) call.set('Authorization', header);
  const response = await call; expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_REQUIRED');
  expect(mocks.getAuth).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled();
});
it('trims token boundaries and uses trusted identity without enabling revocation implicitly', async () => {
  const response = await request(app).get('/api/users/me?uid=forged').set('Authorization', 'Bearer   fixture-token   ');
  expect(response.status).toBe(200); expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('fixture-token');
  expect(mocks.profile).toHaveBeenCalledWith({ uid: 'trusted', email: 'trusted@example.com', emailVerified: true, name: 'Trusted' });
});
it.each(['auth/invalid-id-token', 'auth/argument-error', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found', 'auth/invalid-argument'])('preserves sanitized 401 for SDK rejection %s', async code => {
  // Simulated SDK outcomes; in production default verifyIdToken does not request revocation/user lookup.
  mocks.verify.mockRejectedValue(Object.assign(new Error('PRIVATE token details'), { code }));
  const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture');
  expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_INVALID');
  expect(JSON.stringify(response.body)).not.toContain('PRIVATE'); expect(mocks.active).not.toHaveBeenCalled();
});
it.each(['app/network-error', 'app/network-timeout', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/quota-exceeded'])('returns 503 for Auth infrastructure %s without authorizing downstream', async code => {
  mocks.verify.mockRejectedValue(Object.assign(new Error('PRIVATE service details'), { code }));
  const response = await request(app).get('/api/rooms').set('Authorization', 'Bearer fixture');
  expect(response.status).toBe(503); expect(response.body.code).toBe('AUTH_UNAVAILABLE');
  expect(JSON.stringify(response.body)).not.toContain('PRIVATE'); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
});
it('fails closed for an unclassified verification error', async () => {
  mocks.verify.mockRejectedValue(null);
  expect((await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture')).body.code).toBe('AUTH_INVALID');
});
it('returns configuration unavailability without calling verify', async () => {
  mocks.getAuth.mockImplementation(() => { throw new Error('PRIVATE credential'); });
  const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer fixture');
  expect(response.status).toBe(503); expect(response.body.code).toBe('AUTH_UNAVAILABLE'); expect(mocks.verify).not.toHaveBeenCalled();
});
it('accepts a newly issued valid token for the same identity without a profile write', async () => {
  for (const token of ['first', 'renewed']) expect((await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  expect(mocks.verify.mock.calls).toEqual([['first'], ['renewed']]); expect(mocks.profile).toHaveBeenCalledTimes(2);
});
