import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/errors';
const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), getFirebaseAuth: vi.fn(), getUserProfile: vi.fn(), createUserProfile: vi.fn() }));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: mocks.getFirebaseAuth }));
vi.mock('../services/users.service', () => ({ getUserProfile: mocks.getUserProfile, createUserProfile: mocks.createUserProfile }));
import { app } from '../app';
const body = { nombre: 'Ana', apellido: 'Pérez', username: ' ANA_User1 ' };
const data = { uid: 'uid-1', profileStatus: 'complete', profile: { uid: 'uid-1', email: 'ana@example.com', nombre: 'Ana', apellido: 'Pérez', username: 'ANA_User1', usernameKey: 'ana_user1', avatarUrl: null, profileStatus: 'complete', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' } };
const post = () => request(app).post('/api/users/me').set('Authorization', 'Bearer test-token');
describe('authenticated user profile HTTP contracts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getFirebaseAuth.mockReturnValue({ verifyIdToken: mocks.verifyIdToken });
    mocks.verifyIdToken.mockResolvedValue({ uid: 'uid-1', email: 'ana@example.com' });
  });
  it.each(['get', 'post'] as const)('requires authentication for %s', async (method) => {
    const response = await request(app)[method]('/api/users/me');
    expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(mocks.getFirebaseAuth).not.toHaveBeenCalled();
  });
  it('rejects an invalid token before accessing profiles', async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error('invalid'));
    const response = await post().send(body);
    expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_INVALID');
    expect(mocks.createUserProfile).not.toHaveBeenCalled();
  });
  it('returns 503 when authentication is not configured', async () => {
    mocks.getFirebaseAuth.mockImplementation(() => { throw new Error('configuration'); });
    expect((await post().send(body)).body.code).toBe('AUTH_UNAVAILABLE');
  });
  it.each([data, { uid: 'uid-1', profileStatus: 'incomplete', profile: null }])('returns authenticated profile state', async (state) => {
    mocks.getUserProfile.mockResolvedValue(state);
    const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer test-token');
    expect(response.status).toBe(200); expect(response.body).toEqual({ success: true, data: state });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([true, false])('returns correct creation/idempotency status (%s)', async (created) => {
    mocks.createUserProfile.mockResolvedValue({ created, data });
    const response = await post().send(body);
    expect(response.status).toBe(created ? 201 : 200);
    expect(response.body).toEqual({ success: true, data });
    expect(mocks.createUserProfile).toHaveBeenCalledWith({ uid: 'uid-1', email: 'ana@example.com' }, { ...body, username: 'ANA_User1', avatarUrl: null });
  });
  it.each([{ ...body, avatarUrl: '' }, { ...body, avatarUrl: 'not-a-url' }, { ...body, avatarUrl: 'http://example.com' }, { ...body, uid: 'attacker' }, { ...body, username: '../' }, {}])('validates before calling the service', async (input) => {
    const response = await post().send(input);
    expect(response.status).toBe(400); expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.createUserProfile).not.toHaveBeenCalled();
  });
  it.each([[409, 'PROFILE_INCONSISTENT'], [500, 'INTERNAL_ERROR'], [409, 'USERNAME_TAKEN'], [409, 'PROFILE_ALREADY_EXISTS'], [503, 'FIRESTORE_UNAVAILABLE'], [400, 'AUTH_EMAIL_REQUIRED']] as const)('preserves controlled errors %s %s', async (status, code) => {
    mocks.createUserProfile.mockRejectedValue(new AppError(status, code, 'Error controlado.'));
    const response = await post().send(body);
    expect(response.status).toBe(status); expect(response.body).toEqual({ success: false, code, message: 'Error controlado.' });
  });
  it('rejects malformed JSON with a controlled 400', async () => {
    const response = await post().set('Content-Type', 'application/json').send('{');
    expect(response.status).toBe(400); expect(response.body.code).toBe('INVALID_JSON');
  });
  it('handles Firestore read errors', async () => {
    mocks.getUserProfile.mockRejectedValue(new AppError(503, 'FIRESTORE_UNAVAILABLE', 'No disponible.'));
    const response = await request(app).get('/api/users/me').set('Authorization', 'Bearer test-token');
    expect(response.status).toBe(503);
  });
});
