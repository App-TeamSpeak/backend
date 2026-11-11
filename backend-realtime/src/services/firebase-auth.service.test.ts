import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verifyFirebaseIdToken: vi.fn() }));
vi.mock('../config/firebase', () => ({ verifyFirebaseIdToken: mocks.verifyFirebaseIdToken }));
import { verifyToken } from './firebase-auth.service';
beforeEach(() => { vi.resetAllMocks(); });
it('uses the owned Auth client and preserves verification without checkRevoked', async () => {
  const identity = { uid: 'fixture-user' }; mocks.verifyFirebaseIdToken.mockResolvedValue(identity);
  expect(await verifyToken('fixture-token')).toBe(identity); expect(mocks.verifyFirebaseIdToken).toHaveBeenCalledExactlyOnceWith('fixture-token');
});
it('propagates verification failure to the existing Socket.IO middleware', async () => {
  const error = new Error('controlled failure'); mocks.verifyFirebaseIdToken.mockRejectedValue(error);
  await expect(verifyToken('fixture-token')).rejects.toBe(error);
});

it('forwards an explicit revocation check without exposing Auth', async () => {
  mocks.verifyFirebaseIdToken.mockResolvedValue({ uid: 'fixture-user' });
  expect(await verifyToken('fixture-token', true)).toEqual({ uid: 'fixture-user' });
  expect(mocks.verifyFirebaseIdToken).toHaveBeenCalledExactlyOnceWith('fixture-token', true);
});
