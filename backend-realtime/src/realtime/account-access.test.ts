import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('../config/firebase', () => ({ watchAccountDeletion: mocks.watch }));
import { createAccountAccess, type AccessSession } from './account-access';
let access: ReturnType<typeof createAccountAccess>;
let listeners: { uid: string; changed: (exists: boolean) => void; failed: (error: { code: string }) => void; stop: ReturnType<typeof vi.fn> }[];
function session() {
  const abort = new AbortController();
  return { abort, block: vi.fn(), disconnect: vi.fn(() => abort.abort()) };
}
beforeEach(() => {
  listeners = []; vi.resetAllMocks(); access = createAccountAccess();
  mocks.watch.mockImplementation((uid, changed, failed) => {
    const stop = vi.fn(); listeners.push({ uid, changed, failed, stop }); return stop;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { access.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
function attach(uid: string, value = session()) { return { value, ready: access.attach(uid, value, value.abort.signal) }; }
it('shares one observer across simultaneous sessions, removes it after the last and creates a fresh generation', async () => {
  const a = attach('a'); const b = attach('a'); const c = attach('a');
  expect(mocks.watch).toHaveBeenCalledTimes(1); listeners[0].changed(false);
  const release = await a.ready; await b.ready; await c.ready;
  release(); b.value.abort.abort(); expect(listeners[0].stop).not.toHaveBeenCalled();
  c.value.abort.abort(); expect(listeners[0].stop).toHaveBeenCalledOnce();
  expect(access.getState().sessions).toBe(0);
  const fresh = attach('a'); listeners[0].changed(true);
  expect(fresh.value.block).not.toHaveBeenCalled();
  listeners[1].changed(false); await fresh.ready;
});
it('blocks all sessions before disconnecting them and leaves other UIDs alone', async () => {
  const a = attach('a'); const b = attach('a'); const c = attach('b');
  listeners.forEach((listener) => listener.changed(false)); await Promise.all([a.ready, b.ready, c.ready]);
  a.value.disconnect.mockImplementation(() => { expect(b.value.block).toHaveBeenCalled(); a.value.abort.abort(); });
  listeners[0].changed(true);
  expect(a.value.block).toHaveBeenCalledWith('ACCOUNT_UNAVAILABLE'); expect(b.value.disconnect).toHaveBeenCalledOnce();
  expect(c.value.block).not.toHaveBeenCalled(); expect(access.getState().sessions).toBe(1);
});
it('denies the first existing snapshot regardless of marker content', async () => {
  const a = attach('a'); const denied = expect(a.ready).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
  listeners[0].changed(true); await denied;
  expect(listeners[0].stop).toHaveBeenCalledOnce(); expect(access.getState().observers).toBe(0);
});
it('fails closed when construction throws and permits a new generation to authenticate afresh', async () => {
  mocks.watch.mockImplementationOnce(() => { throw new Error('PRIVATE'); });
  const a = attach('a'); await expect(a.ready).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  expect(access.getState().sessions).toBe(0);
  const next = attach('a'); listeners[0].changed(false); await next.ready;
});
it.each([false, true])('handles observer errors before/after activation: %s', async (active) => {
  const a = attach('a');
  if (active) { listeners[0].changed(false); await a.ready; }
  const denied = active ? Promise.resolve() : expect(a.ready).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  listeners[0].failed({ code: 'FIREBASE_OBSERVER_FAILED' }); await denied;
  expect(a.value.block).toHaveBeenCalledWith('AUTHORIZATION_UNAVAILABLE');
  expect(a.value.disconnect).toHaveBeenCalledOnce(); expect(listeners[0].stop).toHaveBeenCalledOnce();
});
it('removes a socket disappearing before its first snapshot', async () => {
  const a = attach('a'); const denied = expect(a.ready).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  a.value.abort.abort(); await denied; listeners[0].changed(false);
  expect(access.getState().sessions).toBe(0); expect(listeners[0].stop).toHaveBeenCalledOnce();
});
it('bounds the first snapshot wait and ignores late callbacks', async () => {
  vi.useFakeTimers(); const a = attach('a');
  const denied = expect(a.ready).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(5000); await denied; listeners[0].changed(false);
  expect(access.getState().observers).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('is idempotent during shutdown and rejects further registrations', async () => {
  const a = attach('a'); listeners[0].changed(false); await a.ready;
  access.close(); access.close(); listeners[0].changed(true);
  expect(listeners[0].stop).toHaveBeenCalledOnce(); expect(a.value.disconnect).toHaveBeenCalledOnce();
  await expect(attach('b').ready).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  expect(access.getState()).toEqual({ closing: true, observers: 0, sessions: 0 });
});
it('cleans subscriptions when the initial callback runs synchronously', async () => {
  const stop = vi.fn();
  mocks.watch.mockImplementationOnce((_uid, changed) => { changed(true); return stop; });
  await expect(attach('a').ready).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
  expect(stop).toHaveBeenCalledOnce();
});
it('continues closing other UIDs if cancellation throws', async () => {
  const a = attach('a'); const b = attach('b');
  listeners.forEach((listener) => listener.changed(false)); await Promise.all([a.ready, b.ready]);
  listeners[0].stop.mockImplementation(() => { throw new Error('PRIVATE'); });
  access.close(); expect(b.value.disconnect).toHaveBeenCalled(); expect(access.getState().observers).toBe(0);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
});
it('does not duplicate registration of the same session', async () => {
  const value = session(); const a = access.attach('a', value, value.abort.signal);
  expect(access.attach('a', value, value.abort.signal)).toBe(a);
  listeners[0].changed(false); await a; expect(access.getState().sessions).toBe(1);
});
it('cleans a registration when shutdown arrives before its first snapshot', async () => {
  const a = attach('a'); const denied = expect(a.ready).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  access.close(); await denied; listeners[0].changed(false);
  expect(access.getState()).toEqual({ closing: true, observers: 0, sessions: 0 });
});
