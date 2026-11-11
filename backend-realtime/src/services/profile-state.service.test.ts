import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../config/firebase', () => ({ readUserProfile: mocks.read }));
import { requireCompleteProfile } from './profile-state.service';
const full = () => ({ uid: 'trusted', email: 'fixture@example.com', nombre: 'Ana', apellido: 'Pérez', username: 'Ana_User1', usernameKey: 'ana_user1', avatarUrl: null, profileStatus: 'complete', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
it('accepts authoritative complete data for the authenticated UID', async () => {
  mocks.read.mockResolvedValue(full()); await expect(requireCompleteProfile('trusted')).resolves.toBeUndefined(); expect(mocks.read).toHaveBeenCalledExactlyOnceWith('trusted');
});
it.each([undefined, {}, { uid: 'trusted', profileStatus: 'incomplete' }, { uid: 'trusted', profileStatus: 'complete' }])('denies absent or partial persisted profile %j', async value => {
  mocks.read.mockResolvedValue(value); await expect(requireCompleteProfile('trusted')).rejects.toMatchObject({ code: 'PROFILE_INCOMPLETE' });
});
it.each([
  { uid: 'other' }, { usernameKey: 'different_key' }, { username: 'bad' }, { email: 'invalid' },
  { avatarUrl: 'http://example.com/a' }, { createdAt: '2026-01-01' }, { profileStatus: 'forged' },
])('rejects inconsistent persisted fields %j', async patch => {
  mocks.read.mockResolvedValue({ ...full(), ...patch }); await expect(requireCompleteProfile('trusted')).rejects.toMatchObject({ code: 'PROFILE_INCONSISTENT' });
});
it('maps infrastructure failure without exposing SDK details', async () => {
  mocks.read.mockRejectedValue(new Error('PRIVATE SDK detail')); await expect(requireCompleteProfile('trusted')).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE', message: 'AUTHORIZATION_UNAVAILABLE' });
});
it('times out a pending read without granting access', async () => {
  vi.useFakeTimers(); mocks.read.mockReturnValue(new Promise(() => {}));
  const result = expect(requireCompleteProfile('trusted')).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(5000); await result;
});
