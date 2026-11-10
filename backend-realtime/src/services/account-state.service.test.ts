import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ hasAccountDeletion: vi.fn() }));
vi.mock('../config/firebase', () => mocks);
import { requireActiveAccount, startAccountAuthorization } from './account-state.service';
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); });
it('permits only an absent marker and reads exactly the trusted UID', async () => {
  mocks.hasAccountDeletion.mockResolvedValue(false);
  await expect(requireActiveAccount('trusted')).resolves.toBeUndefined();
  expect(mocks.hasAccountDeletion).toHaveBeenCalledExactlyOnceWith('trusted');
});
it('denies any existing marker without inspecting its data', async () => {
  mocks.hasAccountDeletion.mockResolvedValue(true);
  await expect(requireActiveAccount('trusted')).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
});
it.each(['', 'a/b', 'x'.repeat(129), undefined])('rejects invalid UID %s before reading', async (uid) => {
  await expect(requireActiveAccount(uid as string)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  expect(mocks.hasAccountDeletion).not.toHaveBeenCalled();
});
it('sanitizes read failures', async () => {
  mocks.hasAccountDeletion.mockRejectedValue(new Error('PRIVATE'));
  await expect(requireActiveAccount('trusted')).rejects.toMatchObject({ message: 'AUTHORIZATION_UNAVAILABLE' });
});
it('times out closed and handles a late SDK rejection', async () => {
  vi.useFakeTimers(); let reject!: (reason: Error) => void;
  mocks.hasAccountDeletion.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const result = expect(requireActiveAccount('trusted')).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(5000); await result;
  reject(new Error('late')); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
});

it('keeps SDK settlement distinct from the authorization timeout', async () => {
  vi.useFakeTimers(); let complete!: (exists: boolean) => void;
  mocks.hasAccountDeletion.mockImplementation(() => new Promise<boolean>((resolve) => { complete = resolve; }));
  const operation = startAccountAuthorization('trusted'); let settled = false;
  void operation.settled.then(() => { settled = true; });
  const denied = expect(operation.authorized).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(5000); await denied; expect(settled).toBe(false);
  complete(false); await operation.settled; expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('reports actual SDK rejection as settled without leaking its error', async () => {
  mocks.hasAccountDeletion.mockRejectedValue(new Error('PRIVATE'));
  const operation = startAccountAuthorization('trusted');
  await expect(operation.authorized).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  await expect(operation.settled).resolves.toBeUndefined();
});
