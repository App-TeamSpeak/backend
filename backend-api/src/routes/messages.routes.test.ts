import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  active: vi.fn(),
  profile: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../config/firebase', () => ({ getFirebaseAuth: () => ({ verifyIdToken: mocks.verify }) }));
vi.mock('../services/account-state.service', () => ({ ensureAccountActive: mocks.active }));
vi.mock('../services/users.service', () => ({ getUserProfile: mocks.profile }));
vi.mock('../services/messages.service', () => ({ listMessages: mocks.list, createMessage: vi.fn() }));

import { app } from '../app';

const url = '/api/rooms/room-1/messages';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue({ uid: 'verified-user', email_verified: true });
  mocks.active.mockResolvedValue(undefined);
  mocks.profile.mockResolvedValue({ profileStatus: 'complete' });
});

it('requires a session before reading the history', async () => {
  const response = await request(app).get(url);
  expect(response.status).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});

it('passes the authenticated UID and parsed cursor to the service', async () => {
  const cursor = Buffer.from(JSON.stringify([1, 2000, 'message-1'])).toString('base64url');
  mocks.list.mockResolvedValue({ data: [], pagination: { nextCursor: null } });

  const response = await request(app).get(url).set('Authorization', 'Bearer fixture')
    .query({ limit: 2, cursor, uid: 'untrusted' });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true, data: [], pagination: { nextCursor: null } });
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith('verified-user', 'room-1', undefined, {
    limit: 2, cursor: [1, 2000, 'message-1'],
  });
});

it('returns 400 for an invalid cursor without querying the history', async () => {
  const response = await request(app).get(url).set('Authorization', 'Bearer fixture').query({ cursor: '!' });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('VALIDATION_ERROR');
  expect(mocks.list).not.toHaveBeenCalled();
});
